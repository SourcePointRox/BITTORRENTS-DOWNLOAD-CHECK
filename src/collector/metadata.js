'use strict';
/* 元数据抓取器（BEP-9 / BEP-10）：
   TCP 连接 peer → BitTorrent 握手 → 协商 ut_metadata 扩展 → 分片拉取 info 字典 →
   bencode 解析 name/files → SHA-1 校验 infohash → pipeline.upsertTorrentMeta。 */
const net = require('net');
const crypto = require('crypto');
const bencode = require('../common/bencode');
const { decodeWithNext } = bencode;
const pipeline = require('./pipeline');
const { normalizeInfohash } = require('../common/util');

const PSTR = Buffer.from('BitTorrent protocol');
const EXT_HANDSHAKE_ID = 0;
const UT_METADATA_ID = 3; // 本地扩展 ID（对方可能不同，以握手为准）
const BLOCK = 16 * 1024;
const TIMEOUT = 12000;

/* 分类规则引擎（与官方分类体系对齐，可用 ML 替换） */
const CATEGORY_RULES = [
  [/\b(XXX|xxx|adult|18\+|porn|hentai)\b/i, 'XXX'],
  [/\b(s\d{1,2}e\d{1,2}|season|episode|s\d{2}\b|complete\.series)\b/i, 'TV'],
  [/\b(anime|ova|amv|subsplease|erai-raws)\b/i, 'Anime'],
  [/\b(19\d{2}|20\d{2})\b.*\b(1080p|720p|2160p|4k|bluray|brrip|web-?dl|webrip|hdrip|dvdrip|cam|hd-?ts)\b/i, 'Movies'],
  [/\b(mp3|flac|aac|320kbps|discography|album|soundtrack|ost)\b/i, 'Music'],
  [/\b(repack|fitgirl|rune|codex|empress|pc\.iso|game|gog)\b/i, 'Games'],
  [/\b(epub|mobi|pdf|ebook|audiobook)\b/i, 'Books'],
  [/\b(apk|android|mod\.apk)\b/i, 'Software'],
  [/\b(windows|office|photoshop|autodesk|matlab|setup|portable|macos|linux\.iso)\b/i, 'Software'],
];
function classify(name) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
  return 'Unsorted';
}

function parseInfo(infoRaw) {
  const info = bencode.decode(infoRaw);
  const name = info['name.utf-8'] ? info['name.utf-8'].toString('utf8')
    : info.name ? info.name.toString('utf8') : null;
  let size = 0; const files = [];
  if (Array.isArray(info.files)) {
    for (const f of info.files) {
      const parts = (f['path.utf-8'] || f.path || []).map(p => p.toString('utf8'));
      files.push({ path: parts.join('/'), size: f.length || 0 });
      size += f.length || 0;
    }
  } else if (info.length) {
    size = info.length;
    files.push({ path: name, size });
  }
  return { name, size, files };
}

/* 从单个 peer 拉取元数据。返回 Promise<Buffer|null>（info 原始字节） */
function fetchFromPeer(ip, port, infohashHex) {
  return new Promise((resolve) => {
    const infohash = Buffer.from(infohashHex, 'hex');
    const peerId = crypto.randomBytes(20);
    const sock = new net.Socket();
    let buffer = Buffer.alloc(0);
    let hsDone = false, extDone = false;
    let utId = null, metaSize = 0, got = Buffer.alloc(0), reqIndex = 0;
    const done = (v) => { try { sock.destroy(); } catch (_) {} resolve(v); };
    const timer = setTimeout(() => done(null), TIMEOUT);

    function sendExt(id, payload) {
      const body = Buffer.concat([Buffer.from([20, id]), payload]);
      const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
      sock.write(Buffer.concat([len, body]));
    }
    function requestPiece(i) {
      const msg = bencode.encode({ msg_type: 0, piece: i });
      sendExt(utId, msg);
    }

    sock.connect(port, ip, () => {
      const reserved = Buffer.alloc(8); reserved[5] = 0x10; // 支持扩展协议 (BEP-10)
      const hs = Buffer.concat([Buffer.from([19]), PSTR, reserved, infohash, peerId]);
      sock.write(hs);
    });
    sock.on('error', () => { clearTimeout(timer); done(null); });
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (!hsDone) {
          if (buffer.length < 68) return;
          const pstrlen = buffer[0];
          if (buffer.slice(1, 1 + pstrlen).toString() !== PSTR.toString()) { clearTimeout(timer); return done(null); }
          // BT 握手: [1 pstrlen][pstr 19][reserved 8][infohash 20][peer_id 20]
          // infohash 起始 = 1 + pstrlen + 8 = 28
          const ihStart = 1 + pstrlen + 8;
          const gotHash = buffer.slice(ihStart, ihStart + 20);
          if (!gotHash.equals(infohash)) { clearTimeout(timer); return done(null); }
          buffer = buffer.slice(1 + pstrlen + 48); hsDone = true; // 跳过整个握手 (1+pstr+8+20+20)
          // 发送扩展握手
          sendExt(EXT_HANDSHAKE_ID, bencode.encode({ m: { ut_metadata: UT_METADATA_ID }, metadata_size: 0, v: 'ikwyd-sandbox/0.1' }));
        }
        for (;;) {
          if (buffer.length < 4) return;
          const len = buffer.readUInt32BE(0);
          if (len === 0) { buffer = buffer.slice(4); continue; }
          if (buffer.length < 4 + len) return;
          const msg = buffer.slice(4, 4 + len);
          buffer = buffer.slice(4 + len);
          const id = msg[0];
          if (id === 20) { // 扩展消息
            const extId = msg[1];
            const payload = msg.slice(2);
            if (extId === EXT_HANDSHAKE_ID) {
              const h = bencode.decode(payload);
              if (h.m && h.m.ut_metadata) { utId = h.m.ut_metadata; metaSize = h.metadata_size || 0; }
              if (utId && metaSize > 0 && metaSize < 16 * 1024 * 1024) { got = Buffer.alloc(metaSize); requestPiece(0); }
              else { clearTimeout(timer); return done(null); }
            } else if (extId === utId && utId != null) {
              // BEP-9 ut_metadata 数据消息：bencode header 字典 + 原始 piece 数据
              // msg_type: 0=request 1=data 2=reject
              const r = decodeWithNext(payload, 0);
              const d = r.value;
              const data = payload.slice(r.next); // next 精确指向 header 之后的数据起点
              const piece = d.piece || 0;
              if (d.msg_type === 2) { // reject —— 对方拒绝提供
                clearTimeout(timer); return done(null);
              }
              if (d.msg_type === 1 && data.length > 0) { // data —— 写入对应分片
                data.copy(got, piece * BLOCK);
              }
              const pieces = Math.ceil(metaSize / BLOCK);
              reqIndex++;
              if (reqIndex < pieces) requestPiece(reqIndex);
              else { clearTimeout(timer); return done(got); }
            }
          } else if (id === 5) { /* bitfield，忽略 */ }
          else if (id === 7) { /* piece，忽略 */ }
        }
      } catch (_) { clearTimeout(timer); done(null); }
    });
  });
}

/* 诊断计数器：统计失败原因分布，定期输出帮助定位问题 */
const diag = { conn: 0, hs: 0, sha: 0, noname: 0, ok: 0, total: 0, debug: 0 };
setInterval(() => {
  if (diag.total === 0) return;
  console.log(`[meta-diag] 尝试 ${diag.total} | 连接/握手失败 ${diag.conn} | SHA不匹配 ${diag.sha} | 无name ${diag.noname} | 成功 ${diag.ok}`);
  diag.conn = diag.hs = diag.sha = diag.noname = diag.ok = diag.total = 0;
}, 30000).unref();

/* 元数据解析并入库：并行尝试多个 peer（DHT peer 质量参差，并行提高成功率） */
async function resolveAndStore(infohashHex, peersList) {
  const infohash = normalizeInfohash(infohashHex);
  if (!infohash) return null;
  // 并行尝试最多 20 个 peer，取第一个 SHA-1 匹配的结果
  const candidates = peersList.slice(0, 20);
  diag.total += candidates.length;
  const tasks = candidates.map(p =>
    fetchFromPeer(p.ip, p.port, infohash).then(raw => ({ raw, peer: p }))
  );
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value || !r.value.raw) { diag.conn++; continue; }
    const raw = r.value.raw;
    if (raw.length < 1) { diag.conn++; continue; }
    const hash = crypto.createHash('sha1').update(raw).digest('hex');
    if (hash !== infohash) {
      diag.sha++;
      if (diag.debug < 5) { diag.debug++; console.log('[meta-debug] SHA mismatch', infohash.slice(0,12), 'got', hash.slice(0,12), 'len', raw.length); }
      continue;
    }
    const meta = parseInfo(raw);
    if (!meta.name) { diag.noname++; continue; }
    pipeline.upsertTorrentMeta({
      infohash, name: meta.name, size: meta.size, files: meta.files,
      category: classify(meta.name), metadata_ok: 1, first_seen: Date.now(), last_seen: Date.now(),
    });
    diag.ok++;
    return meta;
  }
  return null;
}

module.exports = { fetchFromPeer, resolveAndStore, classify, parseInfo };
