'use strict';
/* Bencode 编解码（BEP-3）。字符串一律按 Buffer 处理，键按 utf8 输出。 */

function encode(value) {
  const parts = [];
  _enc(value, parts);
  return Buffer.concat(parts);
}

function _enc(v, parts) {
  if (v == null) throw new Error('bencode: cannot encode null');
  if (Buffer.isBuffer(v)) {
    parts.push(Buffer.from(String(v.length) + ':'), v);
  } else if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    parts.push(Buffer.from(String(b.length) + ':'), b);
  } else if (typeof v === 'number') {
    parts.push(Buffer.from('i' + Math.trunc(v) + 'e'));
  } else if (typeof v === 'bigint') {
    parts.push(Buffer.from('i' + v.toString() + 'e'));
  } else if (Array.isArray(v)) {
    parts.push(Buffer.from('l'));
    for (const item of v) _enc(item, parts);
    parts.push(Buffer.from('e'));
  } else if (typeof v === 'object') {
    parts.push(Buffer.from('d'));
    const keys = Object.keys(v).sort(); // 字典序（按 utf8 字节）
    for (const k of keys) { _enc(k, parts); _enc(v[k], parts); }
    parts.push(Buffer.from('e'));
  } else {
    throw new Error('bencode: unsupported type ' + typeof v);
  }
}

/* 解码：返回 { value, next }。字符串以 Buffer 呈现（键除外，键转 utf8）。 */
function decode(buf, start = 0) {
  const r = _dec(buf, start);
  return r.value;
}

/* 解码并返回 { value, next }：next 指向该 bencode 元素结束后的下一字节。
   用于精确定位 BEP-9 ut_metadata 数据消息中 header 字典的边界，
   避免"解码后再编码"计算长度时因 key 顺序/数字编码差异导致切错位置。 */
function decodeWithNext(buf, start = 0) {
  return _dec(buf, start);
}

function _dec(buf, i) {
  if (i >= buf.length) throw new Error('bencode: unexpected end');
  const c = buf[i];
  if (c === 0x69) { // 'i'
    const e = buf.indexOf(0x65, i); // 'e'
    if (e < 0) throw new Error('bencode: unterminated int');
    const num = Number(buf.slice(i + 1, e).toString('ascii'));
    return { value: num, next: e + 1 };
  }
  if (c === 0x6c) { // 'l'
    const arr = []; i++;
    while (buf[i] !== 0x65) { const r = _dec(buf, i); arr.push(r.value); i = r.next; }
    return { value: arr, next: i + 1 };
  }
  if (c === 0x64) { // 'd'
    const obj = {}; i++;
    while (buf[i] !== 0x65) {
      const k = _dec(buf, i);
      const key = Buffer.isBuffer(k.value) ? k.value.toString('utf8') : String(k.value);
      const v = _dec(buf, k.next);
      obj[key] = v.value; i = v.next;
    }
    return { value: obj, next: i + 1 };
  }
  if (c >= 0x30 && c <= 0x39) { // 数字开头的字节串
    const colon = buf.indexOf(0x3a, i); // ':'
    const len = Number(buf.slice(i, colon).toString('ascii'));
    const s = colon + 1;
    return { value: buf.slice(s, s + len), next: s + len };
  }
  throw new Error('bencode: bad token at ' + i);
}

/* 计算字典中某个键对应原始字节区间 —— 用于 ut_metadata 校验 info 的 SHA-1 */
function findKeyRaw(buf, key) {
  const needle = Buffer.from(String(key.length) + ':' + key);
  // 顶层字典从 'd' 开始扫描键
  let i = 1;
  while (i < buf.length && buf[i] !== 0x65) {
    const k = _dec(buf, i);
    const vStart = k.next;
    const v = _dec(buf, vStart);
    if (Buffer.isBuffer(k.value) && k.value.equals(Buffer.from(key))) {
      return buf.slice(vStart, v.next);
    }
    i = v.next;
  }
  return null;
}

module.exports = { encode, decode, decodeWithNext, findKeyRaw };
