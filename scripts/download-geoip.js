#!/usr/bin/env node
'use strict';
/* 下载 MaxMind GeoLite2 离线 IP 地理位置库到 data/geoip/ 目录。
   零第三方依赖，仅用 Node.js 标准库（https + zlib + 手写 tar 解包）。

   前置条件：
   1. 注册 MaxMind 免费账号：https://www.maxmind.com/en/geolite2/signup
   2. 在 Account Settings → Manage License Keys 生成一个 License Key

   用法：
     node scripts/download-geoip.js LICENSE_KEY
     node scripts/download-geoip.js                          # 从环境变量 MAXMIND_LICENSE_KEY 读取
     MAXMIND_LICENSE_KEY=xxx node scripts/download-geoip.js

   下载内容（默认 City + Country）：
     - GeoLite2-City.mmdb     （~70MB，含国家/州/城市/经纬度/时区）
     - GeoLite2-Country.mmdb  （~6MB，仅国家/洲）

   可选：传入第二个参数 --country-only 仅下载 Country 库（更小更快）。 */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const GEOIP_DIR = path.join(__dirname, '..', 'data', 'geoip');
const MAXMIND_BASE = 'https://download.maxmind.com/app/geoip_download';

/* ---- 命令行参数解析 ---- */
const licenseKey = process.env.MAXMIND_LICENSE_KEY || process.argv[2];
const countryOnly = process.argv.includes('--country-only') || process.argv.includes('--country');

if (!licenseKey) {
  console.error('用法: node scripts/download-geoip.js <LICENSE_KEY>');
  console.error('   或: 设置环境变量 MAXMIND_LICENSE_KEY 后运行 node scripts/download-geoip.js');
  console.error('');
  console.error('获取 License Key: https://www.maxmind.com/en/geolite2/signup');
  process.exit(1);
}

const editions = countryOnly
  ? [{ id: 'GeoLite2-Country', file: 'GeoLite2-Country.mmdb' }]
  : [
      { id: 'GeoLite2-City', file: 'GeoLite2-City.mmdb' },
      { id: 'GeoLite2-Country', file: 'GeoLite2-Country.mmdb' },
    ];

/* ---- 下载文件（返回 Buffer，跟随重定向） ---- */
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'ikwyd-geoip-downloader/1.0' } }, (res) => {
      /* MaxMind 会 302 重定向到 CDN */
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); /* 丢弃当前响应体 */
        return resolve(download(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(new Error('download timeout')); });
  });
}

/* ---- 手写 tar 解包：从 .tar.gz Buffer 中提取 .mmdb 文件 ----
   tar 格式：每个条目 = 512 字节头部 + 文件数据（补齐到 512 倍数）。
   头部关键字段：
     0-99:   文件名（null 结尾）
     124-135:文件大小（八进制 ASCII）
     156:    类型标志（'0'/null = 普通文件）
   归档末尾：两个全零的 512 字节块。 */
function extractMmdbFromTar(tarBuf) {
  let offset = 0;
  const files = [];
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.slice(offset, offset + 512);
    /* 全零块 = 归档结束 */
    if (header.every((b) => b === 0)) break;

    const nameRaw = header.toString('latin1', 0, 100).replace(/\0+$/, '');
    /* 文件大小：八进制 ASCII，位于 124-135 */
    const sizeStr = header.toString('latin1', 124, 136).replace(/[\0\s]+$/, '').trim();
    const size = parseInt(sizeStr || '0', 8);
    const typeFlag = header.toString('latin1', 156, 157);

    offset += 512;
    /* 仅处理普通文件（'0' 或 null） */
    if ((typeFlag === '0' || typeFlag === '') && size > 0) {
      const fileData = tarBuf.slice(offset, offset + size);
      files.push({ name: nameRaw, data: fileData });
    }
    /* 跳过文件数据 + 补齐到 512 倍数 */
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

/* ---- 主流程 ---- */
async function main() {
  fs.mkdirSync(GEOIP_DIR, { recursive: true });
  console.log(`[geoip] 目标目录: ${GEOIP_DIR}`);

  for (const ed of editions) {
    const url = `${MAXMIND_BASE}?edition_id=${ed.id}&license_key=${encodeURIComponent(licenseKey)}&suffix=tar.gz`;
    console.log(`[geoip] 下载 ${ed.id} ...`);
    try {
      const gzBuf = await download(url);
      console.log(`[geoip]   已下载 ${(gzBuf.length / 1024 / 1024).toFixed(1)} MB，解压中...`);
      const tarBuf = zlib.gunzipSync(gzBuf);
      const files = extractMmdbFromTar(tarBuf);
      /* 在 tar 中找 .mmdb 文件 */
      const mmdbFile = files.find((f) => f.name.endsWith('.mmdb'));
      if (!mmdbFile) {
        console.error(`[geoip]   ✘ ${ed.id} 解压后未找到 .mmdb 文件（归档内文件: ${files.map((f) => f.name).join(', ')}）`);
        continue;
      }
      const outPath = path.join(GEOIP_DIR, ed.file);
      fs.writeFileSync(outPath, mmdbFile.data);
      console.log(`[geoip]   ✔ 已保存 ${ed.file} (${(mmdbFile.data.length / 1024 / 1024).toFixed(1)} MB) -> ${outPath}`);
    } catch (e) {
      console.error(`[geoip]   ✘ 下载 ${ed.id} 失败: ${e.message}`);
      if (e.message.includes('401') || e.message.includes('403')) {
        console.error('[geoip]     请检查 License Key 是否正确。');
      }
    }
  }

  /* 验证：列出 data/geoip 目录内容 */
  const existing = fs.existsSync(GEOIP_DIR) ? fs.readdirSync(GEOIP_DIR) : [];
  const mmdbFiles = existing.filter((f) => f.endsWith('.mmdb'));
  if (mmdbFiles.length > 0) {
    console.log(`\n[geoip] 完成！data/geoip/ 中已有 ${mmdbFiles.length} 个库文件:`);
    for (const f of mmdbFiles) {
      const stat = fs.statSync(path.join(GEOIP_DIR, f));
      console.log(`  ${f}  (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    }
    console.log('\n[geoip] 重启服务后，geo.lookup 将优先使用本地库解析。');
  } else {
    console.log('\n[geoip] 警告：data/geoip/ 中没有 .mmdb 文件，服务将继续使用在线 API。');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[geoip] 运行异常:', e);
  process.exit(1);
});
