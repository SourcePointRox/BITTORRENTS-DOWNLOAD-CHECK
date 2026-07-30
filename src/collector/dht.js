'use strict';
/* Mainline DHT 爬虫（BEP-5 / BEP-32 / BEP-51 / BEP-52）。
   - 标准 Kademlia K-bucket 路由表（160 桶，每桶 K=8，LRU 淘汰）
   - IPv4 + IPv6 双栈 UDP 监听 + 【双栈独立引导】：
     udp4 走 IPv4 DHT（BEP-5），udp6 走 IPv6 DHT（BEP-32），
     bootstrap 时显式 DNS 解析（A + AAAA），两条 DHT 各自建立路由覆盖
   - 端口预检：bind 前探测 UDP 端口占用，冲突自动换端口；支持多实例集群（DHTCluster）
   - v2 infohash 支持：DHT 层面截断为 20 字节（SHA-256 前 20 字节）
   - 被动：应答 get_peers / announce_peer / find_node / sample_infohashes / vote
   - 主动：get_peers + sample_infohashes 批量发现 infohash，want=[n4,n6] 请求双栈节点
   事件统一交给 pipeline.ingest。 */
const dgram = require('dgram');
const dns = require('dns');
const bencode = require('../common/bencode');
const { randomBytes } = require('../common/util');
const upnp = require('../common/upnp');
const { parseSocksConfig, wrapDgramSocket } = require('../common/proxy');

const { lookup: dnsLookup } = dns.promises;

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

/* ---------- 标准 Kademlia K-bucket（BEP-5）----------
   路由表采用二叉前缀树（trie）组织，替代旧的"固定 160 桶 + 线性扫描"结构：
   - 每个叶子节点是一个 K-bucket，最多容纳 K=8 个节点
   - 内部节点按 node ID 的某一 bit 划分左右子树（bit 0 = 最高有效位）
   - 桶分裂：当叶子桶满且"包含自身 ID"时递归分裂（细化近邻区域）；
     不包含自身 ID 的远端桶满时按 LRU 淘汰最久未联系节点
   - 选 K 近邻：沿 target 方向优先遍历近子树，不足时回溯远子树，
     近子树节点与 target 的 XOR 距离严格不大于远子树，无需全局排序
   - 每个桶记录 lastChanged，供定期 bucket refresh 使用 */
class KBucket {
  constructor() {
    this.nodes = []; // [{id, host, port, family, lastSeen}]
    this.lastChanged = Date.now();
  }
  add(node) {
    const idx = this.nodes.findIndex(n => n.id.equals(node.id));
    if (idx >= 0) { this.nodes.splice(idx, 1); this.nodes.push(node); this.lastChanged = Date.now(); return true; }
    if (this.nodes.length < K) { this.nodes.push(node); this.lastChanged = Date.now(); return true; }
    return false; // 桶满（由 RoutingTable 决定分裂或 LRU）
  }
  /* 不可分裂的远端桶满时：淘汰队首（最久未联系），追加新节点 */
  evictLRUAndAdd(node) {
    const evicted = this.nodes.shift();
    this.nodes.push(node);
    this.lastChanged = Date.now();
    return evicted || null;
  }
  closest(target, k) {
    return this.nodes.slice().sort((a, b) => xorCmp(a.id, b.id, target)).slice(0, k);
  }
  size() { return this.nodes.length; }
}

class RoutingTable {
  constructor(nodeId) {
    this.nodeId = nodeId;
    /* 二叉前缀树根：初始为单个叶子桶（覆盖整个 160-bit ID 空间）。
       叶子节点：{ type:'leaf', bucket, depth }
       内部节点：{ type:'internal', bit, left, right }（bit=划分位，0=MSB） */
    this.root = { type: 'leaf', bucket: new KBucket(), depth: 0 };
    this.index = new Map(); // idHex -> 叶子节点（快速查找/去重）
  }

  /* 取 id 的第 bit 位（0=最高有效位） */
  _bit(id, bit) {
    return (id[bit >> 3] >> (7 - (bit & 7))) & 1;
  }

  /* 按 id 沿前缀树下行到所在叶子 */
  _walkToLeaf(id) {
    let cur = this.root;
    while (cur.type === 'internal') {
      cur = this._bit(id, cur.bit) === 0 ? cur.left : cur.right;
    }
    return cur;
  }

  _leafContainsSelf(leaf) {
    return this._walkToLeaf(this.nodeId) === leaf;
  }

  /* 将满的叶子桶分裂为两个子桶（仅当包含自身 ID 时调用） */
  _split(leaf) {
    const bit = leaf.depth;
    const left = { type: 'leaf', bucket: new KBucket(), depth: leaf.depth + 1 };
    const right = { type: 'leaf', bucket: new KBucket(), depth: leaf.depth + 1 };
    for (const n of leaf.bucket.nodes) {
      const tgt = this._bit(n.id, bit) === 0 ? left : right;
      tgt.bucket.nodes.push(n);
      tgt.bucket.lastChanged = leaf.bucket.lastChanged;
      this.index.set(n.id.toString('hex'), tgt);
    }
    leaf.type = 'internal';
    leaf.bit = bit;
    leaf.left = left;
    leaf.right = right;
    leaf.bucket = null;
  }

  add(node) {
    const leaf = this._walkToLeaf(node.id);
    if (leaf.bucket.add(node)) {
      this.index.set(node.id.toString('hex'), leaf);
      return true;
    }
    // 桶满：若该桶包含自身 ID 则递归分裂后重试（标准 Kademlia 行为）
    if (leaf.depth < 160 && this._leafContainsSelf(leaf)) {
      this._split(leaf);
      return this.add(node);
    }
    // 不可分裂的远端桶：LRU 淘汰，保持爬虫路由表新鲜
    const evicted = leaf.bucket.evictLRUAndAdd(node);
    if (evicted) this.index.delete(evicted.id.toString('hex'));
    this.index.set(node.id.toString('hex'), leaf);
    return true;
  }

  get(id) {
    const leaf = this.index.get(id.toString('hex'));
    if (!leaf) return null;
    return leaf.bucket.nodes.find(n => n.id.equals(id)) || null;
  }

  /* 选 K 近邻：沿 target 方向优先下行近子树，不足时回溯远子树 */
  closest(target, k) {
    const result = [];
    this._collectClosest(this.root, target, k, result);
    result.sort((a, b) => xorCmp(a.id, b.id, target));
    return result.slice(0, k);
  }
  _collectClosest(node, target, k, result) {
    if (node.type === 'leaf') {
      for (const n of node.bucket.nodes) result.push(n);
      return;
    }
    const side = this._bit(target, node.bit);
    const near = side === 0 ? node.left : node.right;
    const far = side === 0 ? node.right : node.left;
    this._collectClosest(near, target, k, result);
    if (result.length < k) this._collectClosest(far, target, k, result);
  }

  size() {
    let n = 0;
    const walk = (node) => {
      if (node.type === 'leaf') { n += node.bucket.nodes.length; return; }
      walk(node.left); walk(node.right);
    };
    walk(this.root);
    return n;
  }

  size6() {
    let n = 0;
    const walk = (node) => {
      if (node.type === 'leaf') {
        for (const nd of node.bucket.nodes) if (nd.family === 'ipv6') n++;
        return;
      }
      walk(node.left); walk(node.right);
    };
    walk(this.root);
    return n;
  }

  values() {
    const out = [];
    const walk = (node) => {
      if (node.type === 'leaf') { for (const n of node.bucket.nodes) out.push(n); return; }
      walk(node.left); walk(node.right);
    };
    walk(this.root);
    return out;
  }

  /* ---------- bucket refresh（BEP-5）----------
     返回需要刷新的桶对应的随机 target ID 列表（供上层发起 find_node）。
     maxAge: 桶未变动超过该时长视为陈旧。 */
  refreshTargets(maxAge, maxCount = 8) {
    const now = Date.now();
    const targets = [];
    const walk = (node) => {
      if (node.type === 'leaf') {
        if (node.bucket.nodes.length > 0 && now - node.bucket.lastChanged > maxAge) {
          targets.push(this._randomIdForLeaf(node));
        }
        return;
      }
      walk(node.left); walk(node.right);
    };
    walk(this.root);
    return targets.slice(0, maxCount);
  }

  /* 生成落在指定叶子桶 ID 区间内的随机 ID（前缀固定，剩余位随机） */
  _randomIdForLeaf(leaf) {
    const id = randomBytes(20);
    const path = this._pathToLeaf(leaf);
    for (const { bit, side } of path) this._setBit(id, bit, side);
    return id;
  }

  _pathToLeaf(leaf) {
    const path = [];
    const walk = (node) => {
      if (node === leaf) return true;
      if (node.type === 'leaf') return false;
      path.push({ bit: node.bit, side: 0 });
      if (walk(node.left)) return true;
      path.pop();
      path.push({ bit: node.bit, side: 1 });
      if (walk(node.right)) return true;
      path.pop();
      return false;
    };
    walk(this.root);
    return path;
  }

  _setBit(buf, bit, val) {
    const byteIdx = bit >> 3;
    const bitInByte = 7 - (bit & 7);
    if (val) buf[byteIdx] |= (1 << bitInByte);
    else buf[byteIdx] &= ~(1 << bitInByte);
  }
}

/* UDP 端口预检：尝试 bind 目标端口，成功即关闭并返回 true。
   DHT 启动前先检查端口占用状态，被占则换端口，避免一旦阻塞就停止工作。 */
function canBindUdp(port, family = 'udp4') {
  return new Promise((resolve) => {
    let sock;
    try { sock = dgram.createSocket(family); } catch (_) { return resolve(false); }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (_) {}
      resolve(ok);
    };
    sock.once('error', () => finish(false));
    sock.once('listening', () => finish(true));
    try { sock.bind(port); } catch (_) { finish(false); }
    setTimeout(() => finish(false), 3000).unref();
  });
}

/* 在候选范围内找一个可 bind 的 UDP 端口（同时校验 udp4；udp6 不可用时降级只跑 udp4） */
async function findFreeUdpPort(base, span = 50) {
  for (let p = base; p < base + span; p++) {
    if (await canBindUdp(p, 'udp4')) return p;
  }
  return null;
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
    this.hasV6 = false;            // udp6 是否成功监听
    this.stats = { rx: 0, tx: 0, peers: 0, announces: 0, samples: 0, ipv6Peers: 0, utpPeers: 0, nodes6: 0 };
    /* UPnP/NAT-PMP 端口映射（默认开启，opts.upnp === false 关闭）；
       SOCKS5 代理（opts.proxy 或环境变量 IKWYD_SOCKS5_PROXY）。
       代理模式下跳过本地端口预检/UPnP/udp6，所有 UDP 经代理中继。 */
    this.upnpEnabled = opts.upnp !== false;
    this.proxy = opts.proxy || (process.env.IKWYD_SOCKS5_PROXY ? parseSocksConfig(process.env.IKWYD_SOCKS5_PROXY) : null);
    this.mappedPorts = [];        // 已映射端口（供 stop 时清理）
  }

  /* 启动：端口预检（占用自动换端口）→ 双栈 bind → 双栈独立引导。
     等待 udp4 实际 listening 后才返回（bind 异步，确保集群能正确识别可用实例）。
     SOCKS5 代理模式下：跳过本地端口预检与 udp6，UDP 全部经代理中继。
     非代理模式下：bind 后自动尝试 UPnP/NAT-PMP 端口映射（失败静默降级）。 */
  async start() {
    if (!this.proxy) {
      const free = await findFreeUdpPort(this.port, 50);
      if (free == null) {
        console.log(`[dht] ✘ ${this.port}~${this.port + 49} 全部被占用，本实例放弃启动`);
        return this;
      }
      if (free !== this.port) {
        console.log(`[dht] 端口 ${this.port} 被占用，切换到 ${free}`);
        this.port = free;
      }
    }
    this._bindSocket(this.port, 'udp4');
    if (!this.proxy) this._bindSocket(this.port, 'udp6');
    this.queryTimer = setInterval(() => this._activeQuery(), QUERY_INTERVAL);
    // bucket refresh（BEP-5）：定期对长期未变动的桶发起 find_node 刷新路由覆盖。
    // 不再轮换自身 node ID（旧实现会破坏路由稳定性）。
    this.refreshTimer = setInterval(() => this._refreshBuckets(), 15 * 60 * 1000);
    // 等待 udp4 listening（最多 3s）确认实例真实可用
    await new Promise((resolve) => {
      if (this.running) return resolve();
      const iv = setInterval(() => {
        if (this.running) { clearTimeout(t); clearInterval(iv); resolve(); }
      }, 50);
      const t = setTimeout(() => { clearInterval(iv); resolve(); }, 3000);
    });
    // UPnP/NAT-PMP 端口映射（仅非代理模式；失败静默降级，不影响主流程）
    if (this.upnpEnabled && !this.proxy && this.running) {
      try {
        const r = await upnp.mapPort(this.port, this.port, 'udp');
        if (r) {
          this.mappedPorts.push({ externalPort: this.port, protocol: 'udp' });
          console.log(`[dht] UPnP/NAT-PMP 映射 ${this.port}/udp ✔ (${r.method})`);
        }
      } catch (_) { /* 静默降级 */ }
    }
    return this;
  }

  /* 创建 socket 并 bind；EADDRINUSE 时递增端口重试（作为预检之外的兜底）。
     SOCKS5 代理模式下：udp4 用 wrapDgramSocket 经代理中继，udp6 跳过。 */
  _bindSocket(port, family) {
    let sock;
    if (this.proxy) {
      // 代理模式仅支持 udp4（SOCKS5 UDP 中继为 IPv4）
      if (family === 'udp6') return;
      sock = wrapDgramSocket(this.proxy);
    } else {
      try { sock = dgram.createSocket(family); } catch (_) { return; }
    }
    sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    sock.on('error', (err) => {
      if (this.proxy) {
        console.log(`[dht] SOCKS5 代理连接失败: ${err.message}`);
        return;
      }
      if (err && err.code === 'EADDRINUSE' && family === 'udp4') {
        this.port++;
        console.log(`[dht] port ${this.port - 1} in use, trying ${this.port}`);
        try { sock.close(); } catch (_) {}
        if (this.port - port < 20) {
          this._bindSocket(this.port, 'udp4');
          this._bindSocket(this.port, 'udp6');
        }
      }
      // udp6 失败（如无 v6 协议栈）静默降级：只跑 udp4
    });
    sock.on('listening', () => {
      console.log(`[dht] listening on ${family} UDP ${port}`);
      this.running = true;
      if (family === 'udp6') this.hasV6 = true;
      // 双栈独立引导：v4/v6 各自解析 bootstrap 并建立自己的路由覆盖
      this._bootstrap(family === 'udp6' ? 6 : 4).catch(() => {});
    });
    if (family === 'udp4') this.sock4 = sock; else this.sock6 = sock;
    try { sock.bind(port); } catch (_) {}
  }

  stop() {
    this.running = false;
    clearInterval(this.queryTimer); clearInterval(this.refreshTimer);
    // 清理 UPnP/NAT-PMP 端口映射（异步，best-effort，不阻塞关闭）
    for (const m of this.mappedPorts) {
      try { upnp.unmapPort(m.externalPort, m.protocol); } catch (_) {}
    }
    this.mappedPorts = [];
    if (this.sock4) try { this.sock4.close(); } catch (_) {}
    if (this.sock6) try { this.sock6.close(); } catch (_) {}
  }

  _tid() { const t = this.tidCounter = (this.tidCounter + 1) & 0xffff; return Buffer.from([(t >> 8) & 255, t & 255]); }

  _send(msg, host, port) {
    const buf = bencode.encode(msg);
    const isV6 = host.includes(':');
    const sock = isV6 ? this.sock6 : this.sock4;
    if (!sock) return false;
    try { sock.send(buf, port, host, () => {}); } catch (_) { return false; }
    this.stats.tx++;
    return true;
  }

  _query(type, args, host, port, ptype) {
    const tid = this._tid();
    const sent = this._send({ t: tid, y: 'q', q: type, a: { id: this.nodeId, ...args } }, host, port);
    if (!sent) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(tid.toString('hex')); resolve(null); }, 4000);
      this.pending.set(tid.toString('hex'), { resolve, timer, type: ptype || type });
    });
  }

  _respond(tid, r, host, port) { this._send({ t: tid, y: 'r', r }, host, port); }
  _error(tid, code, msg, host, port) { this._send({ t: tid, y: 'e', e: [code, msg] }, host, port); }

  /* 双栈引导：family=4 → 只用 A 记录（udp4）；family=6 → 只用 AAAA 记录（udp6）。
     IPv6 DHT（BEP-32）是与 IPv4 DHT 平行的独立网络，必须显式用 v6 地址引导，
     否则路由表里永远只有 v4 节点 → v6 peer 采集量趋近于 0（旧版缺陷）。 */
  async _bootstrap(family = 4) {
    const targets = [];
    for (const n of BOOTSTRAP_NODES) {
      try {
        const addrs = await dnsLookup(n.host, { all: true });
        for (const a of addrs) {
          if (a.family === family) targets.push({ host: a.address, port: n.port });
        }
      } catch (_) {}
    }
    if (!targets.length) return;

    // 并发 find_node 引导
    const tasks = targets.map(t => this._query('find_node', { target: this.nodeId, want: [family === 6 ? 'n6' : 'n4'] }, t.host, t.port));
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) this._addResponseNodes(r.value, family === 6 ? 'ipv6' : 'ipv4');
    }
    // 重试直到有节点
    if (this.routing.size() === 0) {
      for (const t of targets) {
        for (let retry = 0; retry < BOOTSTRAP_RETRY; retry++) {
          try {
            const r = await this._query('find_node', { target: this.nodeId, want: [family === 6 ? 'n6' : 'n4'] }, t.host, t.port);
            if (r) { this._addResponseNodes(r, family === 6 ? 'ipv6' : 'ipv4'); }
          } catch (_) {}
          if (this.routing.size() > 0) break;
        }
        if (this.routing.size() > 0) break;
      }
    }
  }

  /* bucket refresh（BEP-5）：对长期未变动的桶发起 find_node，刷新路由覆盖。
     自身 node ID 保持稳定（不再轮换），仅对陈旧桶补节点。 */
  async _refreshBuckets() {
    const targets = this.routing.refreshTargets(15 * 60 * 1000, 8);
    for (const target of targets) {
      const nodes = this.routing.values();
      if (!nodes.length) break;
      const node = nodes[Math.floor(Math.random() * nodes.length)];
      try {
        const r = await this._query('find_node', { target, want: ['n4', 'n6'] }, node.host, node.port, 'find_node');
        if (r) this._addResponseNodes(r, node.family || 'ipv4');
      } catch (_) {}
    }
  }

  /* 解析响应中的节点列表：
     - "nodes"：IPv4 26 字节/条（BEP-5），IPv6 38 字节/条（BEP-32 里部分实现仍用 nodes）
     - "nodes6"：IPv6 38 字节/条（BEP-32 标准字段）
     自适应：按缓冲区对齐长度自动判定条目宽度，兼容各类实现。 */
  _addResponseNodes(r, familyHint) {
    if (!r) return;
    if (Buffer.isBuffer(r.nodes)) {
      // 38 对齐 → v6 条目；26 对齐 → v4 条目；都不对齐按 hint 兜底
      let fam = familyHint || 'ipv4';
      if (r.nodes.length % 38 === 0 && r.nodes.length % 26 !== 0) fam = 'ipv6';
      else if (r.nodes.length % 26 === 0) fam = 'ipv4';
      this._addNodes(r.nodes, fam);
    }
    if (Buffer.isBuffer(r.nodes6)) this._addNodes(r.nodes6, 'ipv6');
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
        if (family === 'ipv6') this.stats.nodes6++;
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

    // want=[n4,n6]：请求对方同时返回双栈节点（BEP-32）
    const r = await this._query('get_peers', { info_hash: target, want: ['n4', 'n6'] }, node1.host, node1.port, 'get_peers');
    if (r) {
      this._addResponseNodes(r, node1.family || 'ipv4');
      this._parseValues(r.values, fullHash, 'dht_active');
    }

    // sample_infohashes (BEP-51)
    const s = await this._query('sample_infohashes', { target: randomBytes(20), want: ['n4', 'n6'] }, node2.host, node2.port, 'sample');
    if (s && s.samples && Buffer.isBuffer(s.samples) && s.samples.length >= 20) {
      this.stats.samples++;
      this._addResponseNodes(s, node2.family || 'ipv4');
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
        const r2 = await this._query('get_peers', { info_hash: Buffer.from(ih, 'hex'), want: ['n4', 'n6'] }, node3.host, node3.port, 'get_peers');
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
    const fam = family === 'IPv6' ? 'ipv6' : family === 'IPv4' ? 'ipv4' : family;
    if (a.id && Buffer.isBuffer(a.id)) {
      this.routing.add({ id: a.id, host: rinfo.address, port: rinfo.port, family: fam, lastSeen: Date.now() });
    }
    // want 字段：对方请求特定协议族的节点（BEP-32）
    const want = Array.isArray(a.want) ? a.want.map(w => String(w)) : null;
    switch (q) {
      case 'ping':
        return this._respond(tid, { id: this.nodeId }, rinfo.address, rinfo.port);
      case 'find_node': {
        const resp = this._nodesResponse(a.target || a.id, fam, want);
        return this._respond(tid, { id: this.nodeId, ...resp }, rinfo.address, rinfo.port);
      }
      case 'get_peers': {
        const ih = a.info_hash && a.info_hash.toString('hex');
        // 被动观测：对方正在全网寻找这个 infohash —— 这是真实的下载者信号
        // （iknowwhatyoudownload 式被动采集；port 记 null，因为这是 DHT 端口而非 BT 端口）
        if (ih) this.onObservation({ ip: rinfo.address, port: null, infohash: ih, source: 'dht_getpeers', ts: Date.now() });
        const resp = this._nodesResponse(a.info_hash || a.id, fam, want);
        return this._respond(tid, { id: this.nodeId, token: randomBytes(4), ...resp }, rinfo.address, rinfo.port);
      }
      case 'announce_peer': {
        const ih = a.info_hash && a.info_hash.toString('hex');
        if (ih) {
          this.stats.announces++;
          // implied_port=1 的 peer 可能在使用 uTP（BEP-29），统计以便监控
          if (a.implied_port) this.stats.utpPeers++;
          // 端口语义：a.port 是 peer 宣告的 BT 监听端口（可 TCP 连接）；
          // implied_port=1 时 rinfo.port 是 DHT/UDP 端口，不是 BT 端口 —— 记 null，
          // 避免后续拿 UDP 端口去做 TCP 元数据/PEX 连接（必然超时）。
          const port = a.implied_port ? null : (a.port || null);
          this.onObservation({ ip: rinfo.address, port, infohash: ih, source: 'dht_passive', ts: Date.now() });
        }
        return this._respond(tid, { id: this.nodeId }, rinfo.address, rinfo.port);
      }
      case 'sample_infohashes': {
        const resp = this._nodesResponse(a.target || a.id, fam, want);
        return this._respond(tid, { id: this.nodeId, interval: 1800, num: 0, ...resp }, rinfo.address, rinfo.port);
      }
      case 'vote':
        return this._respond(tid, { id: this.nodeId }, rinfo.address, rinfo.port);
      default:
        return this._error(tid, 204, 'Method Unknown', rinfo.address, rinfo.port);
    }
  }

  /* 构造 nodes / nodes6 响应字段（尊重对方的 want 请求，BEP-32） */
  _nodesResponse(target, fam, want) {
    const out = {};
    const wantV4 = !want || want.includes('n4');
    const wantV6 = !want || want.includes('n6');
    if (fam === 'ipv6' || wantV6) out.nodes6 = this._closestNodesCompact(target, K, 'ipv6');
    if (fam === 'ipv4' || wantV4) out.nodes = this._closestNodesCompact(target, K, 'ipv4');
    return out;
  }

  /* 紧凑节点格式编码（按距离选 K 个，只选对应协议族的节点） */
  _closestNodesCompact(target, k, family) {
    if (!Buffer.isBuffer(target) || target.length !== 20) target = randomBytes(20);
    const isV6 = family === 'ipv6';
    const pool = this.routing.values().filter(n => (n.family === 'ipv6') === isV6);
    const closest = pool.sort((a, b) => xorCmp(a.id, b.id, target)).slice(0, k);
    const step = isV6 ? 38 : 26;
    const buf = Buffer.allocUnsafe(closest.length * step);
    let off = 0;
    for (const n of closest) {
      n.id.copy(buf, off); off += 20;
      if (isV6) {
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

/* ---------- DHT 集群：多端口并发，提升容错率 ----------
   单个 DHT 实例只跑在一个 UDP 端口上，一旦该端口被运营商/防火墙阻塞就停止工作。
   集群模式同时启动 N 个实例（各自独立端口、nodeId、路由表），
   任一实例可用即维持采集；事件回调统一聚合到上层。 */
class DHTCluster {
  constructor(opts = {}) {
    this.basePort = opts.port || 6881;
    this.instances = [];
    this.opts = opts;
    this.running = false;
  }

  /* instanceCount：并发实例数（默认 3）。端口分配：base, base+1000, base+2000…
     每个实例启动前独立做端口预检，冲突自动换端口。 */
  async start(instanceCount = 3) {
    this.running = true;
    for (let i = 0; i < instanceCount; i++) {
      const spider = new DHTSpider({
        port: this.basePort + i * 1000,
        onObservation: this.opts.onObservation,
        onInfohash: this.opts.onInfohash,
        getKnownInfohashes: this.opts.getKnownInfohashes,
        upnp: this.opts.upnp,
        proxy: this.opts.proxy,
      });
      await spider.start();
      if (spider.running) this.instances.push(spider);
    }
    console.log(`[dht-cluster] ${this.instances.length} 个实例运行中: ${this.instances.map(s => 'UDP ' + s.port).join(', ')}`);
    return this;
  }

  stop() {
    this.running = false;
    for (const s of this.instances) { try { s.stop(); } catch (_) {} }
    this.instances = [];
  }

  /* 聚合统计：供监控面板展示（向后兼容单实例字段，另附 instances 明细） */
  get stats() {
    const agg = { rx: 0, tx: 0, peers: 0, announces: 0, samples: 0, ipv6Peers: 0, utpPeers: 0, nodes6: 0 };
    for (const s of this.instances) {
      for (const k of Object.keys(agg)) agg[k] += s.stats[k] || 0;
    }
    return agg;
  }

  get nodes() { return this.instances.reduce((a, s) => a + s.routing.size(), 0); }
  get nodes6() { return this.instances.reduce((a, s) => a + s.routing.size6(), 0); }
  get port() { return this.instances.length ? this.instances[0].port : this.basePort; }
  get ports() { return this.instances.map(s => s.port); }
  get hasV6() { return this.instances.some(s => s.hasV6); }

  /* 全部实例的路由节点（供 crawler 调度） */
  allNodes() {
    const out = [];
    for (const s of this.instances) out.push(...s.routing.values());
    return out;
  }

  /* 在随机实例上执行一次查询（供 crawler 使用） */
  queryOnRandom(type, args, ptype) {
    if (!this.instances.length) return Promise.resolve(null);
    const spider = this.instances[Math.floor(Math.random() * this.instances.length)];
    const nodes = spider.routing.values();
    if (!nodes.length) return Promise.resolve(null);
    const node = nodes[Math.floor(Math.random() * nodes.length)];
    return spider._query(type, args, node.host, node.port, ptype)
      .then(r => ({ response: r, spider, node }));
  }
}

module.exports = { DHTSpider, DHTCluster, KBucket, RoutingTable, v2Truncated, BOOTSTRAP_NODES, canBindUdp, findFreeUdpPort };
