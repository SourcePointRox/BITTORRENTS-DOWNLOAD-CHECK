'use strict';
/* 纯 JS MMDB (MaxMind DB) 读取器 —— GeoLite2 二进制格式。
   零第三方依赖，仅用 Node.js 标准库。
   规范参考：https://maxmind.github.io/MaxMind-DB/

   支持读取 GeoLite2-Country / GeoLite2-City 等 .mmdb 文件。
   支持 IPv4 与 IPv6 查询（IPv6 库中的 IPv4 自动走 /96 前缀）。

   用法：
     const { open } = require('./mmdb-reader');
     const reader = open('/path/to/GeoLite2-City.mmdb');
     const r = reader.lookup('1.2.3.4');
     // r = { country: { iso_code, names }, city: {...}, continent: {...}, location: {...}, ... }
*/
const fs = require('fs');

/* 元数据标记：出现在文件末尾的元数据段开头 */
const METADATA_MARKER = Buffer.from(
  '\xab\xcd\xefMaxMind.com', 'binary'
);

/* ---- 数据段解码器：解析 MMDB 自定义二进制数据格式 ----
   每个值由 1 个控制字节 + 可变长度 size + 数据体组成。
   控制字节：高 3 位 = 类型，低 5 位 = size（或 size 扩展标记）。 */
class DataDecoder {
  constructor(buffer, offset, dataSectionStart) {
    this.buffer = buffer;
    this.offset = offset;
    this.dataSectionStart = dataSectionStart; // 指针基准（数据段起始或元数据起始）
  }

  parse() {
    const ctrl = this.buffer[this.offset++];
    const type = ctrl >> 5;
    let size = ctrl & 0x1f;

    /* 类型 0 = 扩展类型：下一个字节 + 7 = 实际类型 */
    if (type === 0) {
      const extType = this.buffer[this.offset++] + 7;
      return this._parseValue(extType, size);
    }

    /* 类型 1 = 指针：指向数据段内某偏移 */
    if (type === 1) return this._parsePointer(ctrl);

    /* 解析 size 扩展 */
    if (size === 29) {
      size = this.buffer[this.offset++] + 29;
    } else if (size === 30) {
      size = this.buffer.readUInt16BE(this.offset) + 285;
      this.offset += 2;
    } else if (size === 31) {
      size = ((this.buffer[this.offset] << 16) |
              (this.buffer[this.offset + 1] << 8) |
              this.buffer[this.offset + 2]) + 65821;
      this.offset += 3;
    }

    return this._parseValue(type, size);
  }

  _parsePointer(ctrl) {
    /* 指针 size 类别（ctrl 的第 4-3 位），值字段长度 1-4 字节。
       指针值是数据段内的偏移量。 */
    const psize = (ctrl >> 3) & 0x03;
    let ptr;
    if (psize === 0) {
      ptr = ((ctrl & 0x07) << 8) | this.buffer[this.offset++];
    } else if (psize === 1) {
      ptr = ((ctrl & 0x07) << 16) | this.buffer.readUInt16BE(this.offset);
      this.offset += 2;
    } else if (psize === 2) {
      ptr = ((ctrl & 0x07) << 24) | this._readUInt24(this.offset);
      this.offset += 3;
    } else {
      ptr = this.buffer.readUInt32BE(this.offset);
      this.offset += 4;
    }
    /* 递归解析指针目标，保存/恢复当前 offset */
    const saved = this.offset;
    this.offset = this.dataSectionStart + ptr;
    const val = this.parse();
    this.offset = saved;
    return val;
  }

  _readUInt24(off) {
    return (this.buffer[off] << 16) | (this.buffer[off + 1] << 8) | this.buffer[off + 2];
  }

  _parseValue(type, size) {
    switch (type) {
      case 1: /* pointer — 不应到达此处 */
        return null;
      case 2: { /* UTF-8 字符串 */
        const s = this.buffer.toString('utf8', this.offset, this.offset + size);
        this.offset += size;
        return s;
      }
      case 3: { /* double（固定 8 字节） */
        const v = this.buffer.readDoubleBE(this.offset);
        this.offset += 8;
        return v;
      }
      case 4: { /* bytes */
        const b = this.buffer.slice(this.offset, this.offset + size);
        this.offset += size;
        return b;
      }
      case 5: { /* uint16，size = 字节数（0-2） */
        let v = 0;
        for (let i = 0; i < size; i++) v = (v << 8) | this.buffer[this.offset++];
        return v;
      }
      case 6: { /* uint32，size = 字节数（0-4） */
        let v = 0;
        for (let i = 0; i < size; i++) v = (v << 8) | this.buffer[this.offset++];
        return v >>> 0;
      }
      case 7: { /* map：size = 键值对数量 */
        const m = {};
        for (let i = 0; i < size; i++) {
          const k = this.parse();
          const v = this.parse();
          m[k] = v;
        }
        return m;
      }
      case 8: { /* int32，size = 字节数（0-4），可能有符号 */
        let v = 0;
        for (let i = 0; i < size; i++) v = (v << 8) | this.buffer[this.offset++];
        return v;
      }
      case 9: { /* uint64，size = 字节数 */
        let v = 0;
        for (let i = 0; i < size; i++) v = v * 256 + this.buffer[this.offset++];
        return v;
      }
      case 10: { /* uint128，size = 字节数 */
        let v = 0;
        for (let i = 0; i < size; i++) v = v * 256 + this.buffer[this.offset++];
        return v;
      }
      case 11: { /* array：size = 元素数量 */
        const a = new Array(size);
        for (let i = 0; i < size; i++) a[i] = this.parse();
        return a;
      }
      case 12: /* data cache container — 不用于 v2 格式 */
        return null;
      case 13: /* end marker */
        return null;
      case 14: /* boolean：size 非 0 = true */
        return size !== 0;
      case 15: { /* float（固定 4 字节） */
        const v = this.buffer.readFloatBE(this.offset);
        this.offset += 4;
        return v;
      }
      default:
        /* 未知类型：跳过 size 字节 */
        this.offset += size;
        return null;
    }
  }
}

/* ---- MMDB 读取器主类 ---- */
class MMDBReader {
  constructor(filePath) {
    this.buffer = fs.readFileSync(filePath);
    this._parseMetadata();
    /* 树大小（字节）= 节点数 × 2 条记录 × 每条记录位数 / 8 */
    this.treeSize = this.nodeCount * 2 * this.recordSize / 8;
    /* 数据段紧跟在搜索树之后 */
    this.dataOffset = this.treeSize;
  }

  _parseMetadata() {
    /* 从文件末尾向前查找元数据标记（取最后一次出现） */
    const idx = this.buffer.lastIndexOf(METADATA_MARKER);
    if (idx < 0) throw new Error('MMDB: metadata marker not found');
    const metaStart = idx + METADATA_MARKER.length;
    /* 元数据用相同数据格式编码，指针基准 = 元数据起始 */
    const dec = new DataDecoder(this.buffer, metaStart, metaStart);
    const meta = dec.parse();
    this.nodeCount = meta.node_count;
    this.recordSize = meta.record_size;
    this.ipVersion = meta.ip_version;
    this.databaseType = meta.database_type;
    this.buildEpoch = meta.build_epoch;
    this.languages = meta.languages;
    this.description = meta.description;
    if (![24, 28, 32].includes(this.recordSize)) {
      throw new Error('MMDB: unsupported record size ' + this.recordSize);
    }
  }

  /* 读取搜索树节点的一条记录（left=bit0 / right=bit1） */
  _readRecord(nodeIndex, bit) {
    const base = nodeIndex * this.recordSize * 2 / 8; /* 每节点字节数 = 2 × recordSize / 8 */
    let left, right;
    if (this.recordSize === 24) {
      /* 6 字节：left 3 + right 3 */
      left = this._readUInt24(base);
      right = this._readUInt24(base + 3);
    } else if (this.recordSize === 28) {
      /* 7 字节：left 中间 3 + right 中间 3 + 1 字节（高 4 位 left，低 4 位 right） */
      const mid = this.buffer[base + 6];
      left = ((mid >> 4) << 24) | this._readUInt24(base);
      right = ((mid & 0x0f) << 24) | this._readUInt24(base + 3);
    } else {
      /* 32 位：8 字节，left 4 + right 4 */
      left = this.buffer.readUInt32BE(base);
      right = this.buffer.readUInt32BE(base + 4);
    }
    return bit === 0 ? left : right;
  }

  _readUInt24(off) {
    return (this.buffer[off] << 16) | (this.buffer[off + 1] << 8) | this.buffer[off + 2];
  }

  /* 将 IP 字符串转为位数组（IPv4 → 32 位或 IPv6 库中的 96+32=128 位） */
  _ipToBits(ip) {
    if (typeof ip !== 'string') return null;

    /* IPv4 */
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      const parts = ip.split('.').map(Number);
      if (parts.some(p => p > 255)) return null;
      const v4Bits = new Array(32);
      for (let i = 0; i < 4; i++) {
        for (let j = 7; j >= 0; j--) v4Bits[i * 8 + (7 - j)] = (parts[i] >> j) & 1;
      }
      if (this.ipVersion === 6) {
        /* IPv6 库：IPv4 前面补 96 个 0（::/96 前缀） */
        return new Array(96).fill(0).concat(v4Bits);
      }
      return v4Bits;
    }

    /* IPv6 */
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return null;
    const bits = new Array(128);
    for (let i = 0; i < 16; i++) {
      for (let j = 7; j >= 0; j--) bits[i * 8 + (7 - j)] = (bytes[i] >> j) & 1;
    }
    return bits;
  }

  /* 查询 IP，返回原始 MMDB 数据记录（map）或 null（未命中） */
  lookup(ip) {
    const bits = this._ipToBits(ip);
    if (!bits) return null;
    let node = 0;
    for (let i = 0; i < bits.length; i++) {
      node = this._readRecord(node, bits[i]);
      /* 等于 nodeCount = IP 不在库中 */
      if (node === this.nodeCount) return null;
      /* 大于 nodeCount = 数据记录指针 */
      if (node > this.nodeCount) {
        const dataOffsetInSection = node - this.nodeCount - 16;
        const dec = new DataDecoder(this.buffer, this.dataOffset + dataOffsetInSection, this.dataOffset);
        return dec.parse();
      }
      /* 否则 node < nodeCount，继续遍历下一层 */
    }
    return null;
  }
}

/* ---- IPv6 字符串 → 16 字节 Buffer ----
   处理 :: 简写、IPv4 映射地址（::ffff:1.2.3.4）等。 */
function ipv6ToBytes(ip) {
  /* 含点号 → IPv4 映射/兼容地址，先把末段 IPv4 转成两组 hex */
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    const v4 = ip.slice(lastColon + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some(b => b > 255)) return null;
    const g1 = (v4[0] * 256 + v4[1]).toString(16);
    const g2 = (v4[2] * 256 + v4[3]).toString(16);
    return ipv6ToBytes(ip.slice(0, lastColon + 1) + g1 + ':' + g2);
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null; /* 多个 :: 非法 */

  let left, right;
  if (halves.length === 2) {
    left = halves[0] ? halves[0].split(':') : [];
    right = halves[1] ? halves[1].split(':') : [];
  } else {
    left = halves[0].split(':');
    right = [];
  }

  const total = left.length + right.length;
  if (total > 8) return null;
  const zeros = 8 - total;
  const groups = left.concat(new Array(zeros).fill('0'), right);
  if (groups.length !== 8) return null;

  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || '0', 16);
    if (isNaN(v) || v > 0xffff) return null;
    buf.writeUInt16BE(v, i * 2);
  }
  return buf;
}

/* ---- 模块导出 ---- */

/* 打开 MMDB 文件。文件不存在或格式错误时返回 null（静默降级）。 */
function open(filePath) {
  try {
    return new MMDBReader(filePath);
  } catch (_) {
    return null;
  }
}

module.exports = { open, MMDBReader, ipv6ToBytes };
