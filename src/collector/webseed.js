'use strict';
/* WebSeed 采集器（BEP-19 GetRight-style HTTP/FTP seeding）。
   WebSeed 是种子内 url-list（或 magnet 的 ws= 参数）声明的 HTTP 内容源，
   本质上等价于 BitComet“长效种子”的 HTTP 缓存层：即使 BT swarm 死亡，
   内容仍可通过 HTTP 长存。本项目将 WebSeed 用作：
   1) 内容采样：HTTP Range 拉取文件头 512KB，用魔数（magic bytes）验证/修正分类；
   2) 活性信号：HEAD 探测成功 → 该资源有长效 HTTP 源，标记 alive；
   3) 采集补充：WebSeed 服务端常同时是 BT peer（P2SP 混合），其 URL 计入观测。
   工程化：并发闸 2、每 host 最小间隔、超时 8s、只做 Range 小样本，不下载完整内容。 */
const db = require('../server/db');

const SAMPLE_BYTES = 512 * 1024; // 512KB 采样
const CONCURRENCY = 2;
const HOST_MIN_INTERVAL = 5000;
const TIMEOUT = 8000;

const hostLastCall = new Map();
let sem = 0;
const stats = { probed: 0, ok: 0, sampled: 0, reclassified: 0, registered: 0 };

/* 常见内容魔数 → 分类提示 */
const MAGIC_RULES = [
  { sig: [0x52, 0x61, 0x72, 0x21], cat: 'Software', desc: 'RAR' },            // Rar!
  { sig: [0x50, 0x4B, 0x03, 0x04], cat: null, desc: 'ZIP' },                  // ZIP（类别不定）
  { sig: [0x1A, 0x45, 0xDF, 0xA3], cat: 'Movies', desc: 'MKV/WebM' },         // EBML
  { sig: [0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70], cat: 'Movies', desc: 'MP4' }, // ftyp
  { sig: [0x49, 0x44, 0x33], cat: 'Music', desc: 'MP3-ID3' },                 // ID3
  { sig: [0xFF, 0xFB], cat: 'Music', desc: 'MP3' },
  { sig: [0x66, 0x4C, 0x61, 0x43], cat: 'Music', desc: 'FLAC' },              // fLaC
  { sig: [0x25, 0x50, 0x44, 0x46], cat: 'Books', desc: 'PDF' },               // %PDF
  { sig: [0x4D, 0x5A], cat: 'Software', desc: 'PE/EXE' },                     // MZ
  { sig: [0x7F, 0x45, 0x4C, 0x46], cat: 'Software', desc: 'ELF' },            // ELF
  { sig: [0x52, 0x49, 0x46, 0x46], cat: 'Movies', desc: 'AVI/WAV' },          // RIFF
  { sig: [0x30, 0x26, 0xB2, 0x75], cat: 'Movies', desc: 'WMV/ASF' },          // ASF
  { sig: [0x4F, 0x67, 0x67, 0x53], cat: 'Music', desc: 'OGG' },               // OggS
];

function matchMagic(buf) {
  if (!buf || buf.length < 8) return null;
  for (const rule of MAGIC_RULES) {
    let ok = true;
    for (let i = 0; i < rule.sig.length; i++) {
      if (rule.sig[i] === null) continue; // 通配
      if (i >= buf.length || buf[i] !== rule.sig[i]) { ok = false; break; }
    }
    if (ok) return rule;
  }
  return null;
}

/* 从 magnet URL 解析 ws= / xs= 参数（WebSeed 声明） */
function parseWebSeedsFromMagnet(magnet) {
  if (!magnet || typeof magnet !== 'string') return [];
  const out = [];
  for (const m of magnet.matchAll(/[?&](?:ws|xs)=([^&]+)/g)) {
    try { out.push(decodeURIComponent(m[1])); } catch (_) { out.push(m[1]); }
  }
  return out.filter(u => /^https?:\/\//i.test(u));
}

/* WebSeed 注册表：infohash -> Set(url)。来源：meta-search magnetUrl / 外部调用。 */
const registry = new Map();
function registerWebSeeds(infohash, urls) {
  if (!infohash || !Array.isArray(urls) || !urls.length) return 0;
  if (!registry.has(infohash)) registry.set(infohash, new Set());
  const set = registry.get(infohash);
  let added = 0;
  for (const u of urls) {
    if (set.size >= 8) break; // 每种子最多保留 8 个 webseed
    if (!set.has(u)) { set.add(u); added++; }
  }
  if (added) stats.registered += added;
  return added;
}

async function throttleHost(url) {
  let host = '';
  try { host = new URL(url).host; } catch (_) { return; }
  const last = hostLastCall.get(host) || 0;
  const wait = Math.max(0, last + HOST_MIN_INTERVAL - Date.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  hostLastCall.set(host, Date.now());
}

async function withSem(fn) {
  while (sem >= CONCURRENCY) await new Promise(r => setTimeout(r, 120));
  sem++;
  try { return await fn(); } finally { sem--; }
}

/* HEAD 探测 WebSeed 活性 */
async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'HEAD', signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'qBittorrent/4.6.0' },
    });
    return { ok: res.ok || res.status === 206 || res.status === 302, status: res.status, length: Number(res.headers.get('content-length')) || 0 };
  } catch (_) {
    return { ok: false, status: 0, length: 0 };
  } finally { clearTimeout(timer); }
}

/* Range 采样首 512KB，返回 Buffer（上限 SAMPLE_BYTES） */
async function sample(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT * 2);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'qBittorrent/4.6.0', 'Range': `bytes=0-${SAMPLE_BYTES - 1}` },
    });
    if (!res.ok && res.status !== 206) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.slice(0, SAMPLE_BYTES);
  } catch (_) {
    return null;
  } finally { clearTimeout(timer); }
}

/* 对一个种子执行 WebSeed 采集：HEAD 探测 + Range 采样 + 魔数分类修正。
   返回 { probed, alive, magicCat } */
async function collect(infohash) {
  const urls = registry.get(infohash);
  if (!urls || !urls.size) return null;
  const result = { probed: 0, alive: false, magicCat: null };
  for (const url of [...urls].slice(0, 3)) { // 每轮最多试 3 个源
    await throttleHost(url);
    const p = await withSem(() => probe(url));
    stats.probed++;
    result.probed++;
    if (!p.ok) continue;
    stats.ok++;
    result.alive = true;
    const buf = await withSem(() => sample(url));
    if (buf) {
      stats.sampled++;
      const rule = matchMagic(buf);
      if (rule && rule.cat) { result.magicCat = rule.cat; break; }
    }
  }
  return result;
}

/* 后台轮询：对注册了 webseed 的种子分批采集，修正分类 + 活性。
   由 service 调度，每轮处理少量种子，避免外网请求风暴。 */
async function runRound(limit = 4) {
  const keys = [...registry.keys()];
  if (!keys.length) return 0;
  const d = db.get();
  let touched = 0;
  for (const ih of keys.slice(0, limit)) {
    try {
      const r = await collect(ih);
      if (!r) continue;
      if (r.alive) {
        try { d.prepare('UPDATE torrents SET alive=1 WHERE infohash=?').run(ih); } catch (_) {}
      }
      if (r.magicCat) {
        const row = d.prepare('SELECT category FROM torrents WHERE infohash=?').get(ih);
        if (row && (!row.category || row.category === 'Unsorted')) {
          d.prepare('UPDATE torrents SET category=? WHERE infohash=?').run(r.magicCat, ih);
          stats.reclassified++;
          touched++;
        }
      }
    } catch (_) {}
  }
  return touched;
}

function getStats() {
  return { ...stats, registrySize: registry.size, hosts: hostLastCall.size };
}

module.exports = { registerWebSeeds, parseWebSeedsFromMagnet, collect, runRound, getStats, matchMagic };
