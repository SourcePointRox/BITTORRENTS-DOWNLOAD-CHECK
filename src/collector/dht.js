'use strict';
/* Mainline DHT 爬虫（BEP-5 / BEP-51 / BEP-52）。
   - 标准 Kademlia K-bucket 路由表（160 桶，每桶 K=8，LRU 淘汰）
   - IPv4 + IPv6 双栈 UDP 监听（udp4 + udp6 同时 bind）
   - v2 infohash 支持：DHT 层面截断为 20 字节（SHA-256 前 20 字节）
   - 被动：应答 get_peers / announce_peer
   - 主动：get_peers + sample_infohashes 批量发现 infohash
   事件统一交给 pipeline.ingest。 */
const dgram = require('dgram');
const bencode = require('../common/bencode');
const { randomBytes } = require('../common/util');

/* 全球 DHT bootstrap 节点（去重，覆盖主流客户端与地区） */
const BOOTSTRAP_NODES = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.bitcomet.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 },
  { host: 'router.silotis.org', port: 6881 },
  { host: 'dht.aelitis.com', port: 6881 },
  { host: 'dht.bt.bt.cn', port: 6881 },
  { host: 'router.bittorrent.com.cn', port: 6881 },
  { host: 'dht.dhtserver.com', port: 6881 },
  { host: 'kad.to', port: 6881 },
  { host: 'dht.kad.nimrod.sh', port: 6881 },
  { host: 'router.magnets.im', port: 6881 },
  { host: 'router.tfiles.com', port: 6881 },
  { host: 'dht.leporn.info', port: 6881 },
  { host: 'router.novage.com.ua', port: 6881 },
  { host: 'router.qbittorrent.org', port: 6881 },
  { host: 'dht.firebit.org', port: 6881 },
  { host: 'router.deluge-bbqt.org', port: 51413 },
];

const K = 8;                 // 每桶节点数
const MAX_NODES = 2000;      // 路由表总容量上限
const QUERY_INTERVAL = 20;  // ms，主动查询节流
const BOOTSTRAP_RETRY = 3;

/* v2 infohash 截断：64 hex -> 前 40 hex (20 字节，用于 DHT 查询) */
function v2Truncated(hex) {
  return hex.length === 64 ? hex.slice(0, 40) : hex;
}

/* XOR 距离比较：返回 -1/0/1 */
function xorCmp(a, b, target) {
  for (let i = 0; i < a.length; i++) {
    const da = a[i] ^ target[i];
    const db = b[i] ^ target[i];
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/* 计算 XOR 距离的前导零比特数（用于确定桶索引） */
function bucketIndex(nodeId, target) {
  for (let i = 0; i < nodeId.length; i++) {
    const x = nodeId[i] ^ target[i];
    if (x) return i * 8 + 7 - Math.floor(Math.log2(x));
  }
  return nodeId.length * 8 - 1;
}

/* ---------- 标准 Kademlia K-bucket ---------- */
class KBucket {
  constructor() {
    this.nodes = []; // [{id, host, port, family, lastSeen}]
  }
  add(node) {
    const idx = this.nodes.findIndex(n => n.id.equals(node.id));
    if (idx >= 0) { this.nodes.splice(idx, 1); this.nodes.push(node); return true; }
    if (this.nodes.length < K) { this.nodes.push(node); return true; }
    // 桶满：淘汰最久未联系（LRU）
    this.nodes.shift();
    this.nodes.push(node);
    return true;
  }
  closest(target, k) {
    return this.nodes.slice().sort((a, b) => xorCmp(a.id, b.id, target)).slice(0, k);
  }
  size() { return this.nodes.length; }
}

class RoutingTable {
  constructor(nodeId) {
    this.nodeId = nodeId;
    this.buckets = Array.from({ length: 160 }, () => new KBucket());
    this.index = new Map(); // idHex -> bucketIdx（快速查找）
  }
  add(node) {
    const bi = bucketIndex(this.nodeId, node.id);
    const added = this.buckets[bi].add(node);
    if (added) this.index.set(node.id.toString('hex'), bi);
    return added;
  }
  closest(target, k) {
    const all = [];
    for (const b of this.buckets) all.push(...b.nodes);
    return all.sort((a, b) => xorCmp(a.id, b.id, target)).slice(0, k);
  }
  size() {
    let n = 0; for (const b of this.buckets) n += b.nodes.length; return n;
  }
  values() {
    const out = [];
    for (const b of this.buckets) out.push(...b.nodes);
    return out;
  }
  refreshNodeId() {
    this.nodeId = randomBytes(20);
    // 节点 ID 变了，桶分配会变，简单清空重建
    const nodes = this.values();
    this.buckets = Array.from({ length: 160 }, () => new KBucket());
    this.index.clear();
    for (const n of nodes) this.add(n);
  }
}

/* ---------- DHT Spider ---------- */
class DHTSpider {
  constructor(opts = {}) {
    this.port = opts.port || 6881;
    this.nodeId = randomBytes(20);
    this.routing = new RoutingTable(this.nodeId);
    this.pending = new Map();      // tid -> {resolve, timer, type}
    this.onObservation = opts.onObservation || (() => {});
    this.onInfohash = opts.onInfohash || (() => {});
    this.getKnownInfohashes = opts.getKnownInfohashes || (() => []);
    this.tidCounter = 1;
    this.running = false;
    this.sock4 = null;
    this.sock6 = null;
    this.stats = { rx: 0, tx: 0, peers: 0, announces: 0, samples: 0, ipv6Peers: 0, utpPeers: 0 };
  }

  start() {
    this._bindSocket(this.port, 'udp4');
    this._bindSocket(this.port, 'udp6');
    this.queryTimer = setInterval(() => this._activeQuery(), QUERY_INTERVAL);
    this.refreshTimer = setInterval(() => this.routing.refreshNodeId(), 15 * 60 * 1000);
    return this;
  }

  /* 创建 socket 并 bind；EADDRINUSE 时递增端口重试 */
  _bindSocket(port, family) {
    const sock = dgram.createSocket(family);
    sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    sock.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && family === 'udp4') {
        this.port++;
        console.log(`[dht] port ${this.port - 1} in use, trying ${this.port}`);
        try { sock.close(); } catch (_) {}
        if (this.port - port < 20) {
          this._bindSocket(this.port, 'udp4');
          this._bindSocket(this.port, 'udp6');
        }
      }
    });
    sock.on('listening', () => {
      console.log(`[dht] listening on ${family} UDP ${port}`);
      this.running = true;
      if (family === 'udp4') this._bootstrap();
    });
    if (family === 'udp4') this.sock4 = sock; else this.sock6 = sock;
    try { sock.bind(port); } catch (_) {}
  }

  stop() {
    this.running = false;
    clearInterval(this.queryTimer); clearInterval(this.refreshTimer);
    if (this.sock4) try { this.sock4.close(); } catch (_) {}
    if (this.sock6) try { this.sock6.close(); } catch (_) {}
  }

  _tid() { const t = this.tidCounter = (this.tidCounter + 1) & 0xffff; return Buffer.from([(t >> 8) & 255, t & 255]); }

  _send(msg, host, port) {
    const buf = bencode.encode(msg);
    const isV6 = host.includes(':');
    const sock = isV6 ? this.sock6 : this.sock4;
    if (sock) sock.send(buf, port, host, () => {});
    this.stats.tx++;
  }

  _query(type, args, host, port, ptype) {
    const tid = this._tid();
    this._send({ t: tid, y: 'q', q: type, a: { id: this.nodeId, ...args } }, host, port);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(tid.toString('hex')); resolve(null); }, 4000);
      this.pending.set(tid.toString('hex'), { resolve, timer, type: ptype || type });
    });
  }

  _respond(tid, r, host, port) { this._send({ t: tid, y: 'r', r }, host, port); }
  _error(tid, code, msg, host, port) { this._send({ t: tid, y: 'e', e: [code, msg] }, host, port); }

  async _bootstrap() {
    const tasks = BOOTSTRAP_NODES.map(n => this._query('find_node', { target: this.nodeId }, n.host, n.port));
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && r.value.nodes) this._addNodes(r.value.nodes, 'ipv4');
    }
    if (this.routing.size() === 0) {
      for (const n of BOOTSTRAP_NODES) {
        for (let retry = 0; retry < BOOTSTRAP_RETRY; retry++) {
          try {
            const r = await this._query('find_node', { target: this.nodeId }, n.host, n.port);
            if (r && r.nodes) { this._addNodes(r.nodes, 'ipv4'); break; }
          } catch (_) {}
        }
        if (this.routing.size() > 0) break;
      }
    }
  }

  /* 解析紧凑节点列表（IPv4: 26 字节，IPv6: 38 字节） */
  _addNodes(compact, family) {
    if (!compact || !Buffer.isBuffer(compact)) return;
    const step = family === 'ipv6' ? 38 : 26;
    for (let i = 0; i + step <= compact.length; i += step) {
      const id = compact.slice(i, i + 20);
      let host, port;
      if (family === 'ipv6') {
        // 16 字节 IPv6 + 2 字节 port
        const parts = [];
        for (let j = 0; j < 16; j += 2) parts.push(compact.readUInt16BE(i + 20 + j).toString(16));
        host = parts.join(':');
        port = compact.readUInt16BE(i + 36);
      } else {
        host = [...compact.slice(i + 20, i + 24)].join('.');
        port = compact.readUInt16BE(i + 24);
      }
      if (port > 0 && this.routing.size() < MAX_NODES) {
        this.routing.add({ id, host, port, family, lastSeen: Date.now() });
      }
    }
  }

  /* 解析紧凑 peer 列表（IPv4: 6 字节，IPv6: 18 字节） */
  _parseValues(values, infohash, source) {
    if (!values) return;
    for (const v of values) {
      if (!Buffer.isBuffer(v)) continue;
      if (v.length === 6) {
        // IPv4 compact peer
        const ip = [...v.slice(0, 4)].join('.');
        const port = v.readUInt16BE(4);
        this.stats.peers++;
        this.onObservation({ ip, port, infohash, source, ts: Date.now() });
      } else if (v.length === 18) {
        // IPv6 compact peer
        const parts = [];
        for (let j = 0; j < 16; j += 2) parts.push(v.readUInt16BE(j).toString(16));
        const ip = parts.join(':');
        const port = v.readUInt16BE(16);
        this.stats.peers++;
        this.stats.ipv6Peers++;
        this.onObservation({ ip, port, infohash, source, ts: Date.now() });
      }
    }
  }

  async _activeQuery() {
    const nodes = this.routing.values();
    if (nodes.length === 0) return;
    const node1 = nodes[Math.floor(Math.random() * nodes.length)];
    const node2 = nodes[Math.floor(Math.random() * nodes.length)];

    // get_peers：50% 已知 infohash，50% 随机
    const knownHashes = this.getKnownInfohashes();
    const useKnown = knownHashes.length > 0 && Math.random() < 0.5;
    const fullHash = useKnown
      ? knownHashes[Math.floor(Math.random() * knownHashes.length)]
      : randomBytes(20).toString('hex');
    // DHT 层面截断为 20 字节（v2 的前 20 字节）
    const target = Buffer.from(v2Truncated(fullHash), 'hex');

    const r = await this._query('get_peers', { info_hash: target }, node1.host, node1.port, 'get_peers');
    if (r) {
      this._addNodes(r.nodes, node1.family || 'ipv4');
      this._parseValues(r.values, fullHash, 'dht_active');
    }

    // sample_infohashes (BEP-51)
    const s = await this._query('sample_infohashes', { target: randomBytes(20) }, node2.host, node2.port, 'sample');
    if (s && s.samples && Buffer.isBuffer(s.samples) && s.samples.length >= 20) {
      this.stats.samples++;
      const discovered = [];
      for (let i = 0; i + 20 <= s.samples.length; i += 20) {
        const ih = s.samples.slice(i, i + 20).toString('hex');
        discovered.push(ih);
        this.onInfohash(ih);
      }
      // 对新发现的 infohash 立即 get_peers
      if (discovered.length > 0 && nodes.length > 10) {
        const ih = discovered[Math.floor(Math.random() * discovered.length)];
        const node3 = nodes[Math.floor(Math.random() * nodes.length)];
        const r2 = await this._query('get_peers', { info_hash: Buffer.from(ih, 'hex') }, node3.host, node3.port, 'get_peers');
        if (r2 && r2.values) this._parseValues(r2.values, ih, 'dht_sample');
      }
    }
  }

  _onMessage(msg, rinfo) {
    let m;
    try { m = bencode.decode(msg); } catch (_) { return; }
    this.stats.rx++;
    const tid = m.t;
    const y = Buffer.isBuffer(m.y) ? m.y.toString() : m.y;
    if (y === 'q') return this._onQuery(m, tid, rinfo);
    if (y === 'r' || y === 'e') {
      const p = this.pending.get(Buffer.isBuffer(tid) ? tid.toString('hex') : String(tid));
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(Buffer.isBuffer(tid) ? tid.toString('hex') : String(tid));
        p.resolve(m.r || null);
      }
    }
  }

  _onQuery(m, tid, rinfo) {
    const q = m.q && m.q.toString();
    const a = m.a || {};
    const family = rinfo.family || (rinfo.address.includes(':') ? 'ipv6' : 'ipv4');
    if (a.id && Buffer.isBuffer(a.id)) {
      this.routing.add({ id: a.id, host: rinfo.address, port: rinfo.port, family, lastSeen: Date.now() });
    }
    switch (q) {
      case 'ping':
        return this._respond(tid, { id: this.nodeId }, rinfo.address, rinfo.port);
      case 'find_node': {
        const nodes = this._closestNodesCompact(a.target || a.id, K, family);
        return this._respond(tid, { id: this.nodeId, nodes }, rinfo.address, rinfo.port);
      }
      case 'get_peers': {
        const ih = a.info_hash && a.info_hash.toString('hex');
        const nodes = this._closestNodesCompact(a.info_hash || a.id, K, family);
        return this._respond(tid, { id: this.nodeId, token: randomBytes(4), nodes }, rinfo.address, rinfo.port);
      }
      case 'announce_peer': {
        const ih = a.info_hash && a.info_hash.toString('hex');
        const port = a.implied_port ? rinfo.port : (a.port || rinfo.port);
        if (ih) {
          this.stats.announces++;
          // implied_port=1 的 peer 可能在使用 uTP（BEP-29），统计以便监控
          if (a.implied_port) this.stats.utpPeers++;
          this.onObservation({ ip: rinfo.address, port, infohash: ih, source: 'dht_passive', ts: Date.now() });
        }
        return this._respond(tid, { id: this.nodeId }, rinfo.address, rinfo.port);
      }
      case 'sample_infohashes': {
        const nodes = this._closestNodesCompact(a.target || a.id, K, family);
        return this._respond(tid, { id: this.nodeId, interval: 1800, num: 0, nodes }, rinfo.address, rinfo.port);
      }
      case 'vote':
        return this._respond(tid, { id: this.nodeId }, rinfo.address, rinfo.port);
      default:
        return this._error(tid, 204, 'Method Unknown', rinfo.address, rinfo.port);
    }
  }

  /* 紧凑节点格式编码（按距离选 K 个） */
  _closestNodesCompact(target, k, family) {
    if (!Buffer.isBuffer(target) || target.length !== 20) target = randomBytes(20);
    const closest = this.routing.closest(target, k);
    const isV6 = family === 'ipv6';
    const step = isV6 ? 38 : 26;
    const buf = Buffer.allocUnsafe(closest.length * step);
    let off = 0;
    for (const n of closest) {
      n.id.copy(buf, off); off += 20;
      if (isV6 || n.family === 'ipv6') {
        // 16 字节 IPv6
        const parts = n.host.split(':');
        for (let i = 0; i < 16; i += 2) {
          buf.writeUInt16BE(parseInt(parts[i / 2] || '0', 16), off + i);
        }
        off += 16;
      } else {
        n.host.split('.').map(Number).forEach(x => { buf[off++] = x; });
      }
      buf.writeUInt16BE(n.port, off); off += 2;
    }
    return buf.slice(0, off);
  }
}

module.exports = { DHTSpider, KBucket, RoutingTable, v2Truncated, BOOTSTRAP_NODES };
