'use strict';
/* 通用工具：哈希、编码、格式化、校验。支持 BitTorrent v1 (SHA-1/20字节) 与 v2 (SHA-256/32字节) */
const crypto = require('crypto');

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest(); }
function sha1hex(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }
function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function randomBytes(n) { return crypto.randomBytes(n); }
function randomHex(n) { return crypto.randomBytes(n).toString('hex'); }

/* 同时计算 v1(SHA-1) 和 v2(SHA-256) infohash。
   用于 hybrid 种子检测：一个 info dict 同时产出 v1 和 v2 哈希。
   BEP-52 hybrid 种子的 info dict 同时包含 file tree(v2) 和 files/pieces(v1)，
   两个哈希独立计算，互不相等。 */
function computeBothHashes(infoRaw) {
  return {
    v1: crypto.createHash('sha1').update(infoRaw).digest('hex'),
    v2: crypto.createHash('sha256').update(infoRaw).digest('hex'),
  };
}

/* base32 (RFC 4648) —— 用于 v1 磁力链接的 btih 展示 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/* infohash 版本检测：40 hex = v1，64 hex = v2 */
function isV2Infohash(h) {
  return typeof h === 'string' && /^[0-9a-fA-F]{64}$/.test(h.trim());
}

/* infohash 规范化：接受 40hex(v1) / 32base32(v1) / 64hex(v2) —— 统一返回小写 hex；非法返回 null */
function normalizeInfohash(h) {
  if (!h || typeof h !== 'string') return null;
  h = h.trim();
  // v2: 64 hex (SHA-256)
  if (/^[0-9a-fA-F]{64}$/.test(h)) return h.toLowerCase();
  // v1: 40 hex (SHA-1)
  if (/^[0-9a-fA-F]{40}$/.test(h)) return h.toLowerCase();
  // v1: 32 base32
  if (/^[A-Z2-7]{32}$/i.test(h)) {
    const map = {}; for (let i = 0; i < 32; i++) map[B32[i]] = i;
    let bits = 0, value = 0; const out = [];
    for (const c of h.toUpperCase()) {
      value = (value << 5) | map[c]; bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out).toString('hex');
  }
  return null;
}

/* 生成 magnet URI。自动判断 v1(btih) / v2(btmh multihash)。name 可选。
   v2 的 btmh 格式: urn:btmh:1220 + 64 hex (0x12=SHA-256算法码, 0x20=32字节长度) */
function magnetURI(infohash, name, opts = {}) {
  let xt;
  if (isV2Infohash(infohash)) {
    xt = 'urn:btmh:1220' + infohash; // multihash: 0x12=SHA-256, 0x20=32 bytes
  } else {
    xt = 'urn:btih:' + infohash;
  }
  let m = 'magnet:?xt=' + xt;
  // 混合种子：同时携带 v1 和 v2
  if (opts.infohashV1 && isV2Infohash(infohash)) {
    m += '&xt=urn:btih:' + opts.infohashV1;
  }
  if (name) m += '&dn=' + encodeURIComponent(name);
  const trackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://exodus.desync.com:6969/announce',
  ];
  for (const t of trackers) m += '&tr=' + encodeURIComponent(t);
  return m;
}

/* 字节数人性化 */
function formatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let b = Number(bytes), i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return (i === 0 ? b : b.toFixed(b >= 100 ? 0 : b >= 10 ? 1 : 2)) + ' ' + units[i];
}

/* UTC 时间格式化：YYYY-MM-DD HH:mm:ss */
function fmtUTC(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function fmtDay(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/* IPv4 校验与 CIDR 展开（限量） */
function isIPv4(ip) {
  if (typeof ip !== 'string') return false;
  const p = ip.split('.');
  return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}
function ipToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0; }
function intToIp(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }

/* IPv6 校验 */
function isIPv6(ip) {
  if (typeof ip !== 'string' || !ip.includes(':')) return false;
  // 简化校验：至少两个冒号段，字符为 hex 和冒号
  const parts = ip.split(':');
  if (parts.length < 3) return false;
  // 允许 :: 简写
  return parts.every(p => p === '' || /^[0-9a-fA-F]{1,4}$/.test(p));
}

/* 判断 IP 是 v4 还是 v6 */
function ipFamily(ip) {
  return isIPv6(ip) ? 'ipv6' : isIPv4(ip) ? 'ipv4' : null;
}

/* 格式化 IPv6 地址为标准形式（展开 16 字节 buffer） */
function formatIPv6(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 16) return '';
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
  return parts.join(':');
}

/* HTML 转义 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* slug：标题转 URL 友好的下划线形式（官网风格） */
function slugify(name) {
  return String(name || '')
    .replace(/['"]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'torrent';
}

module.exports = {
  sha1, sha1hex, sha256, sha256hex, randomBytes, randomHex, base32Encode,
  computeBothHashes,
  normalizeInfohash, isV2Infohash, magnetURI, formatSize, fmtUTC, fmtDay,
  isIPv4, isIPv6, ipFamily, ipToInt, intToIp, formatIPv6, esc, slugify,
};
