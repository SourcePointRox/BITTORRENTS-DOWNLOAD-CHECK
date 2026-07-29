'use strict';
/* 全局爬虫聚合器（global swarm crawler）+ cross-infohash swarm merge。

   DHT 生态全采集方式（本模块统一调度 DHT 协议族的全部采集通道）：
   1. announce_peer 被动监听（dht.js 内置）
   2. get_peers 被动观测（dht.js 内置：查询者即真实下载者）
   3. get_peers 主动查询（dht.js 内置）
   4. sample_infohashes (BEP-51) 主动采样（本模块强化：trawl 循环高频遍历）
   5. find_node trawl（本模块：持续向随机 target 发起 find_node 扩大路由覆盖，
      路由覆盖越大，sample/get_peers 命中的网络切片越广）
   6. announce_peer 主动宣告（本模块：向目标 infohash 的最近节点宣告我们的存在，
      吸引 leecher 向我们发起 get_peers/BT 连接 → 转化为被动观测）

   cross-infohash swarm merge：
   同一内容常以多个 infohash 存在（重打包/混合 v1/v2/不同 tracker 分片）。
   内容签名 = normalize(name) + size 相同的种子视为 sibling swarm，
   其 peer 池互相合并（A swarm 的 peer 大概率也在/曾在 B swarm）——
   合并观测记 source='swarm_merge'。

   全局聚合：metadata 候选池强化 —— 某 peer 在多个 swarm 出现说明其长期在线，
   优先用这些“全局稳定 peer”做 ut_metadata / PEX 连接目标。 */
const db = require('../server/db');
const pipeline = require('./pipeline');

class SwarmCrawler {
  constructor(opts = {}) {
    this.cluster = opts.cluster || null;          // DHTCluster
    this.onObservation = opts.onObservation || (() => {});
    this.onInfohash = opts.onInfohash || (() => {});
    this.onTrackerHarvest = opts.onTrackerHarvest || (() => {});
    this.stats = {
      trawlNodes: 0, trawlSamples: 0, announcesSent: 0,
      swarmMerges: 0, mergedPeers: 0, stablePeers: 0,
    };
    this._timers = [];
    this._running = false;
    // 内容签名索引：sig -> Set(infohash)
    this._sigIndex = new Map();
    this._sigBuilt = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    // find_node trawl：每 100ms 一轮，持续扩大路由覆盖
    this._timers.push(setInterval(() => this._trawlRound().catch(() => {}), 100));
    // BEP-51 高频采样：每 500ms 一轮
    this._timers.push(setInterval(() => this._sampleRound().catch(() => {}), 500));
    // 主动 announce：每 60s 一轮（对最热 infohash 向最近节点宣告）
    this._timers.push(setInterval(() => this._announceRound().catch(() => {}), 60000));
    // swarm merge：每 120s 一轮
    this._timers.push(setInterval(() => this._mergeRound().catch(() => {}), 120000));
    // 签名索引重建：每 10 分钟
    this._timers.push(setInterval(() => this._rebuildSigIndex(), 600000));
    for (const t of this._timers) t.unref && t.unref();
    this._rebuildSigIndex();
  }

  stop() {
    this._running = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
  }

  /* find_node trawl：对随机 target 查询随机节点，回收更多节点进路由表 */
  async _trawlRound() {
    if (!this.cluster || !this.cluster.instances.length) return;
    const crypto = require('crypto');
    const r = await this.cluster.queryOnRandom('find_node',
      { target: crypto.randomBytes(20), want: ['n4', 'n6'] }, 'trawl');
    if (r && r.response) {
      r.spider._addResponseNodes(r.response, (r.node && r.node.family) || 'ipv4');
      this.stats.trawlNodes++;
    }
  }

  /* BEP-51 sample_infohashes：随机 target 高频采样，发现全网新 infohash */
  async _sampleRound() {
    if (!this.cluster || !this.cluster.instances.length) return;
    const crypto = require('crypto');
    const r = await this.cluster.queryOnRandom('sample_infohashes',
      { target: crypto.randomBytes(20), want: ['n4', 'n6'] }, 'sample');
    if (!r || !r.response) return;
    const s = r.response;
    if (s.samples && Buffer.isBuffer(s.samples) && s.samples.length >= 20) {
      this.stats.trawlSamples++;
      const discovered = [];
      for (let i = 0; i + 20 <= s.samples.length; i += 20) {
        const ih = s.samples.slice(i, i + 20).toString('hex');
        discovered.push(ih);
        this.onInfohash(ih);
      }
      // 采样到的 infohash 交给 tracker 收割通道（数量受控）
      for (const ih of discovered.slice(0, 3)) this.onTrackerHarvest(ih);
    }
    if (r.spider && s) r.spider._addResponseNodes(s, (r.node && r.node.family) || 'ipv4');
  }

  /* 主动 announce_peer：向目标 infohash 的 K 个最近节点宣告，
     使我们进入该 swarm 的 peer 列表，吸引真实 leecher 反向连接（被动观测）。 */
  async _announceRound() {
    if (!this.cluster || !this.cluster.instances.length) return;
    let rows;
    try {
      rows = db.get().prepare('SELECT infohash FROM torrents ORDER BY last_seen DESC LIMIT 4').all();
    } catch (_) { return; }
    const crypto = require('crypto');
    for (const row of rows) {
      const target = Buffer.from(row.infohash.length === 64 ? row.infohash.slice(0, 40) : row.infohash, 'hex');
      // 取每个实例路由表中最近的节点，向其 announce
      for (const spider of this.cluster.instances) {
        const closest = spider.routing.closest(target, 4);
        for (const node of closest) {
          spider._query('announce_peer', {
            info_hash: target,
            port: spider.port,
            token: crypto.randomBytes(4), // 宽松的节点接受任意 token；严格节点拒绝也无害
          }, node.host, node.port, 'announce').then(() => {}).catch(() => {});
          this.stats.announcesSent++;
        }
      }
    }
  }

  /* 内容签名：归一化 name + size。同一内容的重打包种子签名相同。 */
  static sigOf(name, size) {
    if (!name || !size) return null;
    const n = String(name).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
    if (!n) return null;
    return n + '|' + size;
  }

  /* 重建内容签名索引（内存 Map：sig -> Set(infohash)） */
  _rebuildSigIndex() {
    try {
      const rows = db.get().prepare('SELECT infohash, name, size FROM torrents WHERE name IS NOT NULL AND size > 0').all();
      const idx = new Map();
      for (const r of rows) {
        const sig = SwarmCrawler.sigOf(r.name, r.size);
        if (!sig) continue;
        if (!idx.has(sig)) idx.set(sig, new Set());
        idx.get(sig).add(r.infohash);
      }
      this._sigIndex = idx;
      this._sigBuilt = Date.now();
    } catch (_) {}
  }

  /* 注册单个种子的签名（metadata 解析成功后由 service 调用，实时进索引） */
  registerSignature(infohash, name, size) {
    const sig = SwarmCrawler.sigOf(name, size);
    if (!sig) return [];
    if (!this._sigIndex.has(sig)) this._sigIndex.set(sig, new Set());
    const set = this._sigIndex.get(sig);
    const siblings = [...set].filter(x => x !== infohash);
    set.add(infohash);
    return siblings;
  }

  /* cross-infohash swarm merge：对签名相同的 sibling swarm 合并 peer 池。
     A swarm 中出现的 peer 记录为 B swarm 的观测（source='swarm_merge'）。 */
  async _mergeRound() {
    if (!this._sigIndex.size) return;
    let merged = 0;
    const d = db.get();
    // 每轮最多处理 5 个签名组，每组最多搬运 200 条 peer 观测
    let groups = 0;
    for (const [, set] of this._sigIndex) {
      if (set.size < 2) continue;
      if (++groups > 5) break;
      const hashes = [...set].slice(0, 6);
      for (const src of hashes) {
        let peers;
        try {
          peers = d.prepare('SELECT DISTINCT ip, port FROM obs_log WHERE infohash=? AND port IS NOT NULL ORDER BY id DESC LIMIT 200').all(src);
        } catch (_) { continue; }
        for (const dst of hashes) {
          if (dst === src) continue;
          for (const p of peers) {
            this.onObservation({ ip: p.ip, port: p.port, infohash: dst, source: 'swarm_merge', ts: Date.now() });
            merged++;
          }
        }
      }
      this.stats.swarmMerges++;
    }
    this.stats.mergedPeers += merged;
  }

  /* 全局稳定 peer：在多个不同 swarm 出现的 ip 是长期在线节点，
     是 ut_metadata / PEX 连接的最佳候选。返回 [{ip, port, swarms}] */
  getStablePeers(limit = 30) {
    try {
      return db.get().prepare(`
        SELECT ip, MAX(port) AS port, COUNT(DISTINCT infohash) AS swarms
        FROM obs_log WHERE port IS NOT NULL
        GROUP BY ip HAVING swarms >= 3
        ORDER BY swarms DESC LIMIT ?`).all(limit);
    } catch (_) { return []; }
  }

  getStats() {
    return {
      ...this.stats,
      sigGroups: this._sigIndex.size,
      stablePeers: this.getStablePeers(100).length,
    };
  }
}

module.exports = { SwarmCrawler };
