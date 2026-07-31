'use strict';
/* 采集服务：运行在站点进程内，统一调度 模拟源 / 真实 DHT 集群 / Tracker / PEX / 爬虫 / WebSeed，
   维护运行状态与统计，供后台监控 WEBUI 展示。
   集成：冷存储同步、动态 Tracker 健康检查、pipeline 写队列、
        元数据聚合补全（meta-search）、cross-infohash swarm merge（crawler）。 */
const db = require('../server/db');
const pipeline = require('./pipeline');
const { DHTCluster } = require('./dht');
const tracker = require('./tracker');
const metadata = require('./metadata');
const pex = require('./pex');
const metaSearch = require('./meta-search');
const webseed = require('./webseed');
const { SwarmCrawler } = require('./crawler');
const geo = require('../server/geo');
const { randomHex } = require('../common/util');

const RING_CAP = 500;

class CollectorService {
  constructor() {
    this.mode = 'off';            // off | sim | live
    this.startedAt = null;
    this.cluster = null;          // live 模式的 DHTCluster（多端口并发）
    this.crawler = null;          // 全局爬虫聚合器
    this.simTimer = null;
    this.simIps = [];
    this.trackerTimer = null;
    this.trackerMgr = null;       // 动态 Tracker 管理器
    this.coldStorage = null;      // 冷存储同步
    this.metaQueue = [];
    this.metaWorking = 0;
    this.trackerHarvestQueue = []; // crawler 发现的待收割 infohash
    this.ring = [];               // 最近事件环形缓冲 {ts,ip,infohash,source}
    this.counters = { ingested: 0, newTorrents: 0, metaResolved: 0, metaFailed: 0, metaEnriched: 0 };
    this.dhtInstances = 3;
  }

  /* ---------- 模式控制 ---------- */
  startSim(opts = {}) {
    this.stop();
    this.mode = 'sim';
    this.startedAt = Date.now();
    this.counters = { ingested: 0, newTorrents: 0, metaResolved: 0, metaFailed: 0, metaEnriched: 0 };
    pipeline.startPipeline();
    /* v0.8.5：sim 模式也设置元数据回调和重试定时器。
       旧版本仅在 live 模式设置，导致 sim 模式下新发现的种子永远不会触发元数据解析，
       "元数据解析度"始终为 0。现在 sim 模式也通过 meta-search 聚合补全元数据。 */
    pipeline.setMetadataCallback((ih) => { this.counters.newTorrents++; this._queueMeta(ih); });
    this.simIps = Array.from({ length: opts.ipPool || 2000 }, () => randomPublicIp());
    const intervalMs = opts.intervalMs || 2000;
    const maxPerTick = opts.maxPerTick || 6;
    const d = db.get();
    const pickTorrent = d.prepare('SELECT infohash FROM torrents ORDER BY RANDOM() LIMIT 1');
    this.simTimer = setInterval(() => {
      try {
        const n = 1 + Math.floor(Math.random() * maxPerTick);
        for (let i = 0; i < n; i++) {
          const t = pickTorrent.get();
          if (!t) return;
          const ev = {
            ip: this.simIps[Math.floor(Math.random() * this.simIps.length)],
            port: 1024 + Math.floor(Math.random() * 60000),
            infohash: t.infohash, ts: Date.now(), source: 'simulator',
          };
          this._ingest(ev);
        }
      } catch (_) {}
    }, intervalMs);
    this.simTimer.unref && this.simTimer.unref();
    this.geoFlushTimer = setInterval(() => geo.flushPending(), 5000);
    this.geoFlushTimer.unref && this.geoFlushTimer.unref();
    this.geoBackfillTimer = setInterval(() => geo.backfillCountryDaily(), 30000);
    this.geoBackfillTimer.unref && this.geoBackfillTimer.unref();
    /* sim 模式也启动元数据重试定时器：对无 name 的种子定期重试解析 */
    if (opts.retryMeta !== false) {
      this.retryTimer = setInterval(() => this._retryMeta(), 15000);
      this.retryTimer.unref && this.retryTimer.unref();
    }
    /* sim 模式也启动 Tracker 管理器：让监控 WebUI 的 tracker 列表/健康检查/手动添加
       功能完整可用（用户在 sim 模式下也需要验证 tracker 健康度）。
       tracker 健康检查是独立的网络探测，不依赖 DHT/PEX，可在 sim 模式下安全运行。 */
    if (opts.tracker !== false) {
      this.trackerMgr = new tracker.TrackerManager();
      this.trackerMgr.start();
    }
    this._startColdStorage();
    return { mode: this.mode };
  }

  startLive(opts = {}) {
    this.stop();
    this.mode = 'live';
    this.startedAt = Date.now();
    this.counters = { ingested: 0, newTorrents: 0, metaResolved: 0, metaFailed: 0, metaEnriched: 0, pexPeers: 0, trackerPeers: 0, ipv6Peers: 0 };
    pipeline.startPipeline();
    pipeline.setMetadataCallback((ih) => { this.counters.newTorrents++; this._queueMeta(ih); });

    // DHT 集群：多端口并发（默认 3 实例），每实例独立端口预检 + 双栈引导
    this.dhtInstances = opts.dhtInstances || 3;
    this.cluster = new DHTCluster({
      port: opts.dhtPort || 6881,
      upnp: opts.upnp !== false,
      onObservation: (ev) => this._ingest(ev),
      onInfohash: (ih) => { if (pipeline.registerInfohash(ih)) this.counters.newTorrents++; },
      getKnownInfohashes: () => {
        try {
          return db.get().prepare('SELECT infohash FROM torrents LIMIT 100').all().map(r => r.infohash);
        } catch (_) { return []; }
      },
    });
    this.cluster.start(this.dhtInstances).catch(e => console.log('[dht-cluster] 启动异常:', e.message));

    // 全局爬虫聚合器（DHT 全生态采集 + cross-infohash swarm merge）
    this.crawler = new SwarmCrawler({
      cluster: this.cluster,
      onObservation: (ev) => this._ingest(ev),
      onInfohash: (ih) => { if (pipeline.registerInfohash(ih)) this.counters.newTorrents++; },
      onTrackerHarvest: (ih) => {
        if (this.trackerHarvestQueue.length < 50) this.trackerHarvestQueue.push(ih);
      },
    });
    this.crawler.start();

    // 动态 Tracker 管理器
    if (opts.tracker) {
      this.trackerMgr = new tracker.TrackerManager();
      this.trackerMgr.start();
      this.trackerTimer = setInterval(() => this._harvestSome(), 30000);
      this.trackerTimer.unref && this.trackerTimer.unref();
    }
    if (opts.pex !== false) {
      this.pexTimer = setInterval(() => this._pexHarvest(), 45000);
      this.pexTimer.unref && this.pexTimer.unref();
    }
    if (opts.retryMeta !== false) {
      this.retryTimer = setInterval(() => this._retryMeta(), 10000);
      this.retryTimer.unref && this.retryTimer.unref();
    }
    // WebSeed 采集轮询（BEP-19 长效 HTTP 源探测 + 内容采样修正分类）
    this.webseedTimer = setInterval(() => webseed.runRound(4).catch(() => {}), 90000);
    this.webseedTimer.unref && this.webseedTimer.unref();

    this.geoFlushTimer = setInterval(() => geo.flushPending(), 5000);
    this.geoFlushTimer.unref && this.geoFlushTimer.unref();
    this.geoRefreshTimer = setInterval(() => geo.refresh(), 2 * 3600 * 1000);
    this.geoRefreshTimer.unref && this.geoRefreshTimer.unref();
    this.geoBackfillTimer = setInterval(() => geo.backfillCountryDaily(), 30000);
    this.geoBackfillTimer.unref && this.geoBackfillTimer.unref();
    this._startColdStorage();
    return { mode: this.mode };
  }

  stop() {
    if (this.simTimer) { clearInterval(this.simTimer); this.simTimer = null; }
    if (this.trackerTimer) { clearInterval(this.trackerTimer); this.trackerTimer = null; }
    if (this.pexTimer) { clearInterval(this.pexTimer); this.pexTimer = null; }
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    if (this.webseedTimer) { clearInterval(this.webseedTimer); this.webseedTimer = null; }
    if (this.geoFlushTimer) { clearInterval(this.geoFlushTimer); this.geoFlushTimer = null; }
    if (this.geoRefreshTimer) { clearInterval(this.geoRefreshTimer); this.geoRefreshTimer = null; }
    if (this.geoBackfillTimer) { clearInterval(this.geoBackfillTimer); this.geoBackfillTimer = null; }
    if (this._enrichTimer) { clearInterval(this._enrichTimer); this._enrichTimer = null; }
    if (this.trackerMgr) { this.trackerMgr.stop(); this.trackerMgr = null; }
    if (this.coldStorage) { this.coldStorage.stop(); this.coldStorage = null; }
    if (this.crawler) { this.crawler.stop(); this.crawler = null; }
    if (this.cluster) { this.cluster.stop(); this.cluster = null; }
    this.mode = 'off';
    this.startedAt = null;
    return { mode: this.mode };
  }

  /* 冷存储同步启动 */
  _startColdStorage() {
    try {
      const { ColdStorage } = require('./cold-storage');
      this.coldStorage = new ColdStorage({ pollInterval: 3000 });
      this.coldStorage.start();
      console.log('[cold-storage] started, poll=3000ms');
    } catch (e) { console.error('[cold-storage] 启动失败:', e.message); }
  }

  /* ---------- 内部 ---------- */
  _ingest(ev) {
    const isNew = pipeline.ingest(ev);
    if (isNew) {
      this.counters.ingested++;
      if (ev.ip && ev.ip.includes(':')) this.counters.ipv6Peers = (this.counters.ipv6Peers || 0) + 1;
      this.ring.push({ ts: ev.ts || Date.now(), ip: ev.ip, infohash: ev.infohash, source: ev.source });
      if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    }
    return isNew;
  }

  _queueMeta(infohash) {
    if (this.metaQueue.length > 400 || this.metaWorking > 20) return;
    this.metaQueue.push(infohash);
    this._pumpMeta();
  }

  async _pumpMeta() {
    if (this.metaWorking > 20) return;
    const ih = this.metaQueue.shift();
    if (!ih) return;
    this.metaWorking++;
    try {
      const rows = db.get().prepare('SELECT ip,port FROM obs_log WHERE infohash=? AND port IS NOT NULL ORDER BY id DESC LIMIT 40').all(ih);
      if (!rows.length) {
        // 无任何可连接 peer 的 hash（sample 噪声）：不计失败，直接走聚合补全（限流）
        this.metaWorking--;
        this._enrichMetaThrottled(ih).catch(() => {});
        if (this.metaQueue.length) this._pumpMeta();
        return;
      }
      const m = await metadata.resolveAndStore(ih, rows);
      if (m) {
        this.counters.metaResolved++;
        // hybrid 种子解析成功后，注册 v2 infohash 用于 DHT 查询发现更多 peer
        if (m.isHybrid && m.infohash_v2) {
          pipeline.registerInfohash(m.infohash_v2);
          this.counters.newTorrents++;
        }
        // cross-infohash swarm merge：注册内容签名，发现 sibling swarm
        if (this.crawler && m.name && m.size) {
          const siblings = this.crawler.registerSignature(m.infohash || ih, m.name, m.size);
          if (siblings.length) this._mergeSiblings(ih, siblings);
        }
      } else {
        // ut_metadata 失败 → 多 BT 站聚合搜索补全元数据（name/size/category）
        this.counters.metaFailed++;
        this._enrichMetaThrottled(ih).catch(() => {});
      }
    } catch (_) { this.counters.metaFailed++; }
    this.metaWorking--;
    if (this.metaQueue.length) this._pumpMeta();
  }

  /* 聚合补全限流：单独队列 + 令牌桶（~25 个/分钟），防止外网请求风暴 */
  _enrichMetaThrottled(infohash) {
    if (!this._enrichQueue) {
      this._enrichQueue = [];
      this._enrichSet = new Set();
      this._enrichTimer = setInterval(() => this._pumpEnrich(), 2400); // 25/min
      this._enrichTimer.unref && this._enrichTimer.unref();
    }
    if (this._enrichSet.has(infohash)) return Promise.resolve(false);
    if (this._enrichQueue.length >= 300) return Promise.resolve(false); // 背压：队列满丢弃
    this._enrichSet.add(infohash);
    this._enrichQueue.push(infohash);
    return Promise.resolve(true);
  }

  async _pumpEnrich() {
    if (!this._enrichQueue || !this._enrichQueue.length) return;
    const ih = this._enrichQueue.shift();
    this._enrichSet.delete(ih);
    // 只对"网络中真实活跃"（≥2 条观测）的 hash 消耗外部索引配额，
    // sample 噪声 hash（0-1 条观测）不值得查询（命中率极低且浪费配额）
    try {
      const c = db.get().prepare('SELECT COUNT(*) AS c FROM obs_log WHERE infohash=?').get(ih).c;
      if (c < 2) return;
    } catch (_) { return; }
    await this._enrichMeta(ih);
  }

  /* 多 BT 站聚合搜索补全：ut_metadata 拿不到时按 infohash 查开放种子库。
     v0.8.5：metadata_ok 设为 1（旧值 0 导致"落库率为 0"——元数据已获取但未计入解析率）。
     外部 BT 站数据在实践中足够可靠（knaben/btdigg 等索引站对 infohash 精确匹配），
     且 metadata_ok=0 会导致 _retryMeta 无限重试已解析的种子，浪费配额。 */
  async _enrichMeta(infohash) {
    try {
      const data = await metaSearch.enrich(infohash);
      if (!data || !data.name) return;
      this.counters.metaEnriched++;
      // 补全入库：metadata_ok=1（外部源数据可靠，计入解析率）
      pipeline.upsertTorrentMeta({
        infohash,
        hash_version: infohash.length === 64 ? 2 : 1,
        name: data.name,
        size: data.size || null,
        category: data.category || 'Unsorted',
        metadata_ok: 1,
        first_seen: Date.now(), last_seen: Date.now(),
      });
      // knaben 等源返回的 magnetUrl 可能含 ws= WebSeed 声明
      if (data.magnetUrl) {
        const seeds = webseed.parseWebSeedsFromMagnet(data.magnetUrl);
        if (seeds.length) webseed.registerWebSeeds(infohash, seeds);
      }
      // 内容签名注册（sibling swarm 发现）
      if (this.crawler && data.name && data.size) {
        const siblings = this.crawler.registerSignature(infohash, data.name, data.size);
        if (siblings.length) this._mergeSiblings(infohash, siblings);
      }
    } catch (_) {}
  }

  /* sibling swarm 即时合并：A 的 peer 记录为 B 的观测（cross-infohash swarm merge） */
  _mergeSiblings(infohash, siblings) {
    try {
      const peers = db.get().prepare('SELECT DISTINCT ip, port FROM obs_log WHERE infohash=? AND port IS NOT NULL ORDER BY id DESC LIMIT 100').all(infohash);
      if (!peers.length) return;
      for (const dst of siblings.slice(0, 4)) {
        for (const p of peers.slice(0, 50)) {
          this._ingest({ ip: p.ip, port: p.port, infohash: dst, source: 'swarm_merge', ts: Date.now() });
        }
      }
    } catch (_) {}
  }

  _retryMeta() {
    if (this.metaWorking > 20) return;
    const d = db.get();
    const rows = d.prepare(`
      SELECT t.infohash, COUNT(o.id) AS pc,
        SUM(CASE WHEN o.source = 'dht_passive' THEN 1 ELSE 0 END) AS ap
      FROM torrents t
      JOIN obs_log o ON o.infohash = t.infohash AND o.port IS NOT NULL
      WHERE t.metadata_ok = 0 AND t.name IS NULL
      GROUP BY t.infohash HAVING pc >= 3
      ORDER BY ap DESC, pc DESC LIMIT 5
    `).all();
    for (const row of rows) {
      this.metaQueue.push(row.infohash);
    }
    this._pumpMeta();
  }

  /* Tracker 收割：热门种子 + crawler 采样发现的种子一起收割。
     hybrid / v2 种子同时收割 v1 和 v2 两个 swarm 视角（双通道）。
     tracker 返回的 peer 是“当前在线”的新鲜 peer（远好于 DHT 陈旧记录），
     收割到足量 peer 的 hash 立即送入元数据队列（ut_metadata 成功率显著提升）。 */
  async _harvestSome() {
    const d = db.get();
    const rows = d.prepare('SELECT infohash, infohash_v2, hash_version FROM torrents ORDER BY last_seen DESC LIMIT 8').all();
    // crawler 通过 sample_infohashes 发现的待收割 hash 优先处理
    const extra = this.trackerHarvestQueue.splice(0, 4);
    for (const ih of extra) rows.unshift({ infohash: ih, infohash_v2: null, hash_version: 1 });
    for (const r of rows) {
      try {
        const found = await tracker.harvest(r.infohash, (ev) => this._ingest(ev));
        const peerN = typeof found === 'number' ? found : (found.peers || 0);
        this.counters.trackerPeers = (this.counters.trackerPeers || 0) + peerN;
        // 新鲜 peer 直通：收割到 ≥3 个 peer 的 hash 优先解析元数据
        if (peerN >= 3) this._queueMeta(r.infohash);
        // hybrid：同时收割 v2 swarm（HTTP tracker 用 32 字节 v2 announce；UDP 自动截断）
        if (r.hash_version === 3 && r.infohash_v2) {
          const found2 = await tracker.harvest(r.infohash_v2, (ev) => this._ingest(ev));
          const peerN2 = typeof found2 === 'number' ? found2 : (found2.peers || 0);
          this.counters.trackerPeers = (this.counters.trackerPeers || 0) + peerN2;
          if (peerN2 >= 3) this._queueMeta(r.infohash_v2);
        }
      } catch (_) {}
    }
  }

  async _pexHarvest() {
    const d = db.get();
    const rows = d.prepare(`
      SELECT DISTINCT o.infohash FROM observations o
      JOIN torrents t ON t.infohash = o.infohash
      WHERE o.last_seen > ? ORDER BY o.last_seen DESC LIMIT 3
    `).all(Date.now() - 600000);
    for (const r of rows) {
      try {
        const peers = d.prepare('SELECT ip, port FROM obs_log WHERE infohash=? AND port IS NOT NULL ORDER BY id DESC LIMIT 24').all(r.infohash);
        if (!peers.length) continue;
        const discovered = await pex.harvest(r.infohash, peers, (ev) => this._ingest(ev), { concurrency: 6, maxSeeds: 16 });
        this.counters.pexPeers = (this.counters.pexPeers || 0) + discovered.length;
      } catch (_) {}
    }
  }

  burst(count) {
    const d = db.get();
    const torrents = d.prepare('SELECT infohash FROM torrents').all();
    if (!torrents.length) return { injected: 0 };
    if (!this.simIps.length) this.simIps = Array.from({ length: 2000 }, () => randomPublicIp());
    let n = 0;
    const events = [];
    for (let i = 0; i < count; i++) {
      const t = torrents[Math.floor(Math.random() * torrents.length)];
      events.push({
        ip: this.simIps[Math.floor(Math.random() * this.simIps.length)],
        port: 1024 + Math.floor(Math.random() * 60000),
        infohash: t.infohash, ts: Date.now(), source: 'simulator',
      });
    }
    pipeline.batch(events);
    for (const ev of events) {
      this.counters.ingested++;
      this.ring.push({ ts: ev.ts, ip: ev.ip, infohash: ev.infohash, source: ev.source });
    }
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    return { injected: events.length };
  }

  getStats() {
    const now = Date.now();
    const ratePerMin = this.ring.filter(e => now - e.ts < 60000).length;
    const dhtRunning = !!(this.cluster && this.cluster.instances.length);
    const dhtAgg = this.cluster ? this.cluster.stats : null;
    return {
      mode: this.mode,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((now - this.startedAt) / 1000) : 0,
      db: {
        torrents: db.scalar('SELECT COUNT(*) FROM torrents'),
        peers: db.scalar('SELECT COUNT(*) FROM peers'),
        observations: db.scalar('SELECT COUNT(*) FROM observations'),
        obsLog: db.scalar('SELECT COUNT(*) FROM obs_log'),
      },
      todayEvents: db.scalar("SELECT COUNT(*) FROM obs_log WHERE ts >= ?", Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')),
      ratePerMin,
      counters: this.counters,
      metaQueue: this.metaQueue.length,
      dht: dhtRunning ? {
        running: true,
        nodes: this.cluster.nodes,
        nodes6: this.cluster.nodes6,
        port: this.cluster.port,
        ports: this.cluster.ports,
        instances: this.cluster.instances.length,
        hasV6: this.cluster.hasV6,
        rx: dhtAgg.rx, tx: dhtAgg.tx, peers: dhtAgg.peers, announces: dhtAgg.announces,
        samples: dhtAgg.samples, ipv6Peers: dhtAgg.ipv6Peers, utpPeers: dhtAgg.utpPeers || 0,
      } : { running: false, nodes: 0, nodes6: 0, port: 6881, ports: [], instances: 0, hasV6: false, rx: 0, tx: 0, peers: 0, announces: 0, samples: 0, ipv6Peers: 0, utpPeers: 0 },
      tracker: this.trackerMgr ? this.trackerMgr.getStats() : null,
      crawler: this.crawler ? this.crawler.getStats() : null,
      webseed: webseed.getStats(),
      metaSearch: metaSearch.getStats(),
      geo: geo._stats(),
      coldStorage: this.coldStorage ? this.coldStorage.getStats() : null,
      recent: this.ring.slice(-30).reverse(),
    };
  }

  getNodes() {
    if (!this.cluster || !this.cluster.instances.length) return { nodes: [] };
    const now = Date.now();
    const nodes = this.cluster.allNodes()
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 100)
      .map(n => ({
        id: n.id.toString('hex').slice(0, 16) + '…',
        address: `${n.host}:${n.port}`,
        family: n.family || 'ipv4',
        ageSec: Math.floor((now - n.lastSeen) / 1000),
      }));
    return { nodes };
  }

  /* 全量 tracker 详情（监控 WebUI 滚轮查看全部） */
  getTrackerList() {
    if (!this.trackerMgr) return [];
    return this.trackerMgr.getAllTrackers();
  }
}

function randomPublicIp() {
  for (;;) {
    const a = 1 + Math.floor(Math.random() * 223);
    if ([10, 127, 169, 172, 192, 224, 255].includes(a)) continue;
    return [a, Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), 1 + Math.floor(Math.random() * 254)].join('.');
  }
}

module.exports = { CollectorService };
