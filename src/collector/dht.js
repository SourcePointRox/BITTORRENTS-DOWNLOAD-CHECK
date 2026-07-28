'use strict';
/* Mainline DHT 爬虫（BEP-5 / BEP-51）。
   - 被动：应答 get_peers / announce_peer，从 announce_peer 捕获真实做种 (ip, port, infohash)
   - 主动：对随机目标发 get_peers，从 values 收集 peer；sample_infohashes 批量发现 infohash
   事件统一交给 pipeline.ingest。 */
const dgram = require('dgram');
const bencode = require('../common/bencode');
const { randomBytes } = require('../common/util');

/* 全球 DHT bootstrap 节点（覆盖主流客户端与地区，提升入网速度） */
const BOOTSTRAP_NODES = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.bitcomet.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 },
  { host: 'router.silotis.org', port: 6881 },
  { host: 'dht.aelitis.com', port: 6881 },
  { host: 'dht.bt.bt.cn', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
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

const K = 8;                 // 每桶节点数（简化实现：平面路由表）
const MAX_NODES = 2000;      // 扩大路由表容量以提升覆盖率
const QUERY_INTERVAL = 20;  // ms，主动查询节流（加快发现速度）
const BOOTSTRAP_RETRY = 3;  // bootstrap 节点重试次数

class DHTSpider {
  constructor(opts = {}) {
    this.port = opts.port || 6881;
    this.nodeId = randomBytes(20);
    this.nodes = new Map();        // id(hex) -> {id, host, port, lastSeen}
    this.pending = new Map();      // tid -> {resolve, timer, type}
    this.onObservation = opts.onObservation || (() => {});
    this.onInfohash = opts.onInfohash || (() => {});
    this.getKnownInfohashes = opts.getKnownInfohashes || (() => []); // 从 DB 取已知 infohash
    this.tidCounter = 1;
    this.running = false;
    this.stats = { rx: 0, tx: 0, peers: 0, announces: 0, samples: 0 };
  }

  start() {
    this._bindSocket(this.port);
    this.queryTimer = setInterval(() => this._activeQuery(), QUERY_INTERVAL);
    this.refreshTimer = setInterval(() => this._makeNodeIdYounger(), 15 * 60 * 1000);
    return this;
  }

  /* 创建 socket 并 bind；EADDRINUSE 时关闭旧 socket、递增端口、创建新 socket 重试 */
  _bindSocket(port) {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    sock.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        this.port++;
        console.log(`[dht] port ${this.port - 1} in use, trying ${this.port}`);
        try { sock.close(); } catch (_) {}
        if (this.port - (port) < 20) this._bindSocket(this.port); // 最多重试 20 个端口
      }
    });
    sock.on('listening', () => {
      console.log(`[dht] listening on UDP ${this.port}`);
      this.running = true;
      this._bootstrap();
    });
    this.sock = sock;
    try { sock.bind(this.port); } catch (_) {}
  }

  stop() {
    this.running = false;
    clearInterval(this.queryTimer); clearInterval(this.refreshTimer);
    if (this.sock) try { this.sock.close(); } catch (_) {}
  }

  _makeNodeIdYounger() { this.nodeId = randomBytes(20); } // 定期更换节点 ID，扩大覆盖

  _tid() { const t = this.tidCounter = (this.tidCounter + 1) & 0xffff; return Buffer.from([(t >> 8) & 255, t & 255]); }

  _send(msg, host, port) {
    const buf = bencode.encode(msg);
    this.sock.send(buf, port, host, () => {});
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
    // 并行向所有 bootstrap 节点发 find_node，加速入网
    const tasks = BOOTSTRAP_NODES.map(n => this._query('find_node', { target: this.nodeId }, n.host, n.port));
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && r.value.nodes) this._addNodes(r.value.nodes);
    }
    // 如果第一批没有获得节点，串行重试（DNS 可能延迟）
    if (this.nodes.size === 0) {
      for (const n of BOOTSTRAP_NODES) {
        for (let retry = 0; retry < BOOTSTRAP_RETRY; retry++) {
          try {
            const r = await this._query('find_node', { target: this.nodeId }, n.host, n.port);
            if (r && r.nodes) { this._addNodes(r.nodes); break; }
          } catch (_) {}
        }
        if (this.nodes.size > 0) break;
      }
    }
  }

  _addNodes(compact) {
    if (!compact || !Buffer.isBuffer(compact)) return;
    for (let i = 0; i + 26 <= compact.length; i += 26) {
      const id = compact.slice(i, i + 20);
      const ip = [...compact.slice(i + 20, i + 24)].join('.');
      const port = compact.readUInt16BE(i + 24);
      if (port > 0 && this.nodes.size < MAX_NODES) {
        this.nodes.set(id.toString('hex'), { id, host: ip, port, lastSeen: Date.now() });
      }
    }
  }

  /* 主动查询：对随机节点发 get_peers + sample_infohashes。
     - 50% 概率用已知 infohash 查 get_peers（更可能获得 values）
     - 50% 概率用随机 infohash 查 get_peers（发现新 peer）
     - sample_infohashes 发现 infohash 后立即对其 get_peers */
  async _activeQuery() {
    if (this.nodes.size === 0) return;
    const arr = [...this.nodes.values()];
    // 每轮查询 2 个节点以加速发现
    const node1 = arr[Math.floor(Math.random() * arr.length)];
    const node2 = arr[Math.floor(Math.random() * arr.length)];

    // --- get_peers 查询 ---
    const knownHashes = this.getKnownInfohashes();
    const useKnown = knownHashes.length > 0 && Math.random() < 0.5;
    const target = useKnown
      ? Buffer.from(knownHashes[Math.floor(Math.random() * knownHashes.length)], 'hex')
      : randomBytes(20);
    const r = await this._query('get_peers', { info_hash: target }, node1.host, node1.port, 'get_peers');
    if (r) {
      this._addNodes(r.nodes);
      if (r.values) {
        for (const v of r.values) {
          if (Buffer.isBuffer(v) && v.length === 6) {
            const ip = [...v.slice(0, 4)].join('.');
            const port = v.readUInt16BE(4);
            this.stats.peers++;
            this.onObservation({ ip, port, infohash: target.toString('hex'), source: 'dht_active', ts: Date.now() });
          }
        }
      }
      if (r.token) {
        // 有 token 说明对方认识我们，可以主动 announce
      }
    }

    // --- sample_infohashes 查询（BEP-51）---
    const s = await this._query('sample_infohashes', { target: randomBytes(20) }, node2.host, node2.port, 'sample');
    if (s && s.samples && Buffer.isBuffer(s.samples) && s.samples.length >= 20) {
      this.stats.samples++;
      const discovered = [];
      for (let i = 0; i + 20 <= s.samples.length; i += 20) {
        const ih = s.samples.slice(i, i + 20).toString('hex');
        discovered.push(ih);
        this.onInfohash(ih);
      }
      // 对新发现的 infohash 立即做 get_peers，尝试找到 peer
      if (discovered.length > 0 && this.nodes.size > 10) {
        const ih = discovered[Math.floor(Math.random() * discovered.length)];
        const ihBuf = Buffer.from(ih, 'hex');
        const node3 = arr[Math.floor(Math.random() * arr.length)];
        const r2 = await this._query('get_peers', { info_hash: ihBuf }, node3.host, node3.port, 'get_peers');
        if (r2 && r2.values) {
          for (const v of r2.values) {
            if (Buffer.isBuffer(v) && v.length === 6) {
              const ip = [...v.slice(0, 4)].join('.');
              const port = v.readUInt16BE(4);
              this.stats.peers++;
              this.onObservation({ ip, port, infohash: ih, source: 'dht_sample', ts: Date.now() });
            }
          }
        }
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
    if (a.id && Buffer.isBuffer(a.id)) {
      this.nodes.set(a.id.toString('hex'), { id: a.id, host: rinfo.address, port: rinfo.port, lastSeen: Date.now() });
    }
    switch (q) {
      case 'ping':
        return this._respond(tid, { id: this.nodeId }, rinfo.address, rinfo.port);
      case 'find_node': {
        const nodes = this._closestNodes(a.target || a.id, K);
        return this._respond(tid, { id: this.nodeId, nodes }, rinfo.address, rinfo.port);
      }
      case 'get_peers': {
        const ih = a.info_hash && a.info_hash.toString('hex');
        // 我们不持有真实 peer 列表时返回 nodes（协议允许）
        const nodes = this._closestNodes(a.info_hash || a.id, K);
        return this._respond(tid, { id: this.nodeId, token: randomBytes(4), nodes }, rinfo.address, rinfo.port);
      }
      case 'announce_peer': {
        // 关键：有人向我们宣告做种 —— 记录真实观测
        const ih = a.info_hash && a.info_hash.toString('hex');
        const port = a.implied_port ? rinfo.port : (a.port || rinfo.port);
        if (ih) {
          this.stats.announces++;
          this.onObservation({ ip: rinfo.address, port, infohash: ih, source: 'dht_passive', ts: Date.now() });
        }
        return this._respond(tid, { id: this.nodeId }, rinfo.address, rinfo.port);
      }
      case 'sample_infohashes': {
        const nodes = this._closestNodes(a.target || a.id, K);
        return this._respond(tid, { id: this.nodeId, interval: 1800, num: 0, nodes }, rinfo.address, rinfo.port);
      }
      case 'vote':
        return this._respond(tid, { id: this.nodeId }, rinfo.address, rinfo.port);
      default:
        return this._error(tid, 204, 'Method Unknown', rinfo.address, rinfo.port);
    }
  }

  /* 紧凑节点格式：按 XOR 距离选 K 个 */
  _closestNodes(target, k) {
    if (!Buffer.isBuffer(target) || target.length !== 20) target = randomBytes(20);
    const dist = (id) => {
      let d = 0;
      for (let i = 0; i < 20; i++) { const x = id[i] ^ target[i]; if (x) { d = 160 - i * 8 - (8 - Math.floor(Math.log2(x + 1))); break; } }
      return d;
    };
    const sorted = [...this.nodes.values()].sort((a, b) => dist(a.id) - dist(b.id)).slice(0, k);
    return Buffer.concat(sorted.map(n => Buffer.concat([n.id, Buffer.from(n.host.split('.').map(Number)), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(n.port); return b; })()])));
  }
}

module.exports = { DHTSpider };
