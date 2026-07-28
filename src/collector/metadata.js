'use strict';
/* 元数据抓取器（BEP-9 / BEP-10）：
   TCP 连接 peer → BitTorrent 握手 → 协商 ut_metadata 扩展 → 分片拉取 info 字典 →
   bencode 解析 name/files → SHA-1 校验 infohash → pipeline.upsertTorrentMeta。 */
const net = require('net');
const crypto = require('crypto');
const bencode = require('../common/bencode');
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
          const gotHash = buffer.slice(28 + pstrlen - 20, 48 + pstrlen - 20);
          if (!gotHash.equals(infohash)) { clearTimeout(timer); return done(null); }
          buffer = buffer.slice(68); hsDone = true;
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
              // ut_metadata 数据：bencode 头 + 原始数据
              const d = bencode.decode(payload);
              const headerLen = bencode.encode(d).length;
              const data = payload.slice(headerLen);
              const piece = d.piece || 0;
              data.copy(got, piece * BLOCK);
              const pieces = Math.ceil(metaSize / BLOCK);
              if (d.msg_type === 1) { // reject
                clearTimeout(timer); return done(null);
              }
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

/* 元数据解析并入库 */
async function resolveAndStore(infohashHex, peersList) {
  const infohash = normalizeInfohash(infohashHex);
  if (!infohash) return null;
  for (const p of peersList.slice(0, 5)) {
    const raw = await fetchFromPeer(p.ip, p.port, infohash);
    if (!raw) continue;
    const hash = crypto.createHash('sha1').update(raw).digest('hex');
    if (hash !== infohash) continue;
    const meta = parseInfo(raw);
    if (!meta.name) continue;
    pipeline.upsertTorrentMeta({
      infohash, name: meta.name, size: meta.size, files: meta.files,
      category: classify(meta.name), metadata_ok: 1, first_seen: Date.now(), last_seen: Date.now(),
    });
    return meta;
  }
  return null;
}

module.exports = { fetchFromPeer, resolveAndStore, classify, parseInfo };
