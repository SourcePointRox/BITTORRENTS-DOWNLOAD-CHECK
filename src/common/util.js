'use strict';
/* 通用工具：哈希、编码、格式化、校验 */
const crypto = require('crypto');

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest(); }
function sha1hex(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function randomBytes(n) { return crypto.randomBytes(n); }
function randomHex(n) { return crypto.randomBytes(n).toString('hex'); }

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

/* infohash 规范化：接受 40hex / 32base32 / 64hex(BTMH 取前40?) —— 统一返回 40 位小写 hex；非法返回 null */
function normalizeInfohash(h) {
  if (!h || typeof h !== 'string') return null;
  h = h.trim();
  if (/^[0-9a-fA-F]{40}$/.test(h)) return h.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(h)) { // base32 -> hex
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

/* 生成 magnet URI（v1）。name 可选 */
function magnetURI(infohash, name) {
  let m = 'magnet:?xt=urn:btih:' + infohash;
  if (name) m += '&dn=' + encodeURIComponent(name);
  // 公共 tracker 便于一键打开即可开始获取元数据
  const trackers = [
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
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
  sha1, sha1hex, randomBytes, randomHex, base32Encode,
  normalizeInfohash, magnetURI, formatSize, fmtUTC, fmtDay,
  isIPv4, ipToInt, intToIp, esc, slugify,
};
