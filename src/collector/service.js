'use strict';
/* 采集服务：运行在站点进程内，统一调度 模拟源 / 真实 DHT / Tracker，
   维护运行状态与统计，供后台监控 WEBUI 展示。 */
const db = require('../server/db');
const pipeline = require('./pipeline');
const { DHTSpider } = require('./dht');
const tracker = require('./tracker');
const metadata = require('./metadata');
const pex = require('./pex');
const geo = require('../server/geo');
const { randomHex } = require('../common/util');

const RING_CAP = 500;

class CollectorService {
  constructor() {
    this.mode = 'off';            // off | sim | live
    this.startedAt = null;
    this.spider = null;           // live 模式的 DHTSpider
    this.simTimer = null;
    this.simIps = [];
    this.trackerTimer = null;
    this.metaQueue = [];
    this.metaWorking = 0;
    this.ring = [];               // 最近事件环形缓冲 {ts,ip,infohash,source}
    this.counters = { ingested: 0, newTorrents: 0, metaResolved: 0, metaFailed: 0 };
  }

  /* ---------- 模式控制 ---------- */
  startSim(opts = {}) {
    this.stop();
    this.mode = 'sim';
    this.startedAt = Date.now();
    this.counters = { ingested: 0, newTorrents: 0, metaResolved: 0, metaFailed: 0 };
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
    // 模拟模式也启动 GeoIP 批量查询（模拟 IP 也需真实解析）
    this.geoFlushTimer = setInterval(() => geo.flushPending(), 5000);
    this.geoFlushTimer.unref && this.geoFlushTimer.unref();
    this.geoBackfillTimer = setInterval(() => geo.backfillCountryDaily(), 30000);
    this.geoBackfillTimer.unref && this.geoBackfillTimer.unref();
    return { mode: this.mode };
  }

  startLive(opts = {}) {
    this.stop();
    this.mode = 'live';
    this.startedAt = Date.now();
    this.counters = { ingested: 0, newTorrents: 0, metaResolved: 0, metaFailed: 0, pexPeers: 0, trackerPeers: 0 };
    pipeline.setMetadataCallback((ih) => this._queueMeta(ih));
    this.spider = new DHTSpider({
      port: opts.dhtPort || 6881,
      onObservation: (ev) => this._ingest(ev),
      onInfohash: (ih) => { if (pipeline.registerInfohash(ih)) this.counters.newTorrents++; },
      getKnownInfohashes: () => {
        try {
          return db.get().prepare('SELECT infohash FROM torrents LIMIT 100').all().map(r => r.infohash);
        } catch (_) { return []; }
      },
    });
    this.spider.start();
    if (opts.tracker) {
      this.trackerTimer = setInterval(() => this._harvestSome(), 30000);
      this.trackerTimer.unref && this.trackerTimer.unref();
    }
    // PEX 采集：定期对活跃种子做 PEX 扩散
    if (opts.pex !== false) {
      this.pexTimer = setInterval(() => this._pexHarvest(), 45000);
      this.pexTimer.unref && this.pexTimer.unref();
    }
    // 元数据重试：定期对有 peer 但无 metadata 的种子重新解析
    if (opts.retryMeta !== false) {
      this.retryTimer = setInterval(() => this._retryMeta(), 10000);
      this.retryTimer.unref && this.retryTimer.unref();
    }
    // GeoIP 批量查询：每 5 秒处理待查队列，每 2 小时刷新旧缓存
    this.geoFlushTimer = setInterval(() => geo.flushPending(), 5000);
    this.geoFlushTimer.unref && this.geoFlushTimer.unref();
    this.geoRefreshTimer = setInterval(() => geo.refresh(), 2 * 3600 * 1000);
    this.geoRefreshTimer.unref && this.geoRefreshTimer.unref();
    // GeoIP 补写：每 30 秒补写之前因占位跳过的 country_daily
    this.geoBackfillTimer = setInterval(() => geo.backfillCountryDaily(), 30000);
    this.geoBackfillTimer.unref && this.geoBackfillTimer.unref();
    return { mode: this.mode };
  }

  stop() {
    if (this.simTimer) { clearInterval(this.simTimer); this.simTimer = null; }
    if (this.trackerTimer) { clearInterval(this.trackerTimer); this.trackerTimer = null; }
    if (this.pexTimer) { clearInterval(this.pexTimer); this.pexTimer = null; }
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    if (this.geoFlushTimer) { clearInterval(this.geoFlushTimer); this.geoFlushTimer = null; }
    if (this.geoRefreshTimer) { clearInterval(this.geoRefreshTimer); this.geoRefreshTimer = null; }
    if (this.geoBackfillTimer) { clearInterval(this.geoBackfillTimer); this.geoBackfillTimer = null; }
    if (this.spider) { this.spider.stop(); this.spider = null; }
    this.mode = 'off';
    this.startedAt = null;
    return { mode: this.mode };
  }

  /* ---------- 内部 ---------- */
  _ingest(ev) {
    const isNew = pipeline.ingest(ev);
    if (isNew) {
      this.counters.ingested++;
      this.ring.push({ ts: ev.ts || Date.now(), ip: ev.ip, infohash: ev.infohash, source: ev.source });
      if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    }
    return isNew;
  }

  _queueMeta(infohash) {
    this.counters.newTorrents++;
    if (this.metaQueue.length > 200 || this.metaWorking > 3) return;
    this.metaQueue.push(infohash);
    this._pumpMeta();
  }

  async _pumpMeta() {
    if (this.metaWorking > 3) return;
    const ih = this.metaQueue.shift();
    if (!ih) return;
    this.metaWorking++;
    try {
      const rows = db.get().prepare('SELECT ip,port FROM obs_log WHERE infohash=? AND port IS NOT NULL ORDER BY id DESC LIMIT 20').all(ih);
      const m = await metadata.resolveAndStore(ih, rows);
      if (m) this.counters.metaResolved++; else this.counters.metaFailed++;
    } catch (_) { this.counters.metaFailed++; }
    this.metaWorking--;
    if (this.metaQueue.length) this._pumpMeta();
  }

  /* 元数据重试：定期对有 peer 但无 metadata 的种子重新解析。
     DHT 网络中 peer 质量参差，首次解析常因 peer 不可达而失败，
     积累更多 peer 后重试可显著提升 size 落库率。
     优先用 announce_peer（dht_passive）的 peer —— 这些是真实声明做种的 peer。 */
  _retryMeta() {
    if (this.metaWorking > 3) return;
    const d = db.get();
    // 取有 3+ peer 但无 metadata 的种子，优先 announce_peer 来源的
    const row = d.prepare(`
      SELECT t.infohash, COUNT(o.id) AS pc,
        SUM(CASE WHEN o.source = 'dht_passive' THEN 1 ELSE 0 END) AS ap
      FROM torrents t
      JOIN obs_log o ON o.infohash = t.infohash AND o.port IS NOT NULL
      WHERE t.metadata_ok = 0 AND t.name IS NULL
      GROUP BY t.infohash HAVING pc >= 3
      ORDER BY ap DESC, pc DESC LIMIT 1
    `).get();
    if (!row) return;
    this.metaQueue.push(row.infohash);
    this._pumpMeta();
  }

  async _harvestSome() {
    // 对最近活跃的种子做 tracker harvest，获取真实做种者（比 DHT peer 质量高）
    const rows = db.get().prepare('SELECT infohash FROM torrents ORDER BY last_seen DESC LIMIT 8').all();
    for (const r of rows) {
      try {
        const found = await tracker.harvest(r.infohash, (ev) => this._ingest(ev));
        this.counters.trackerPeers = (this.counters.trackerPeers || 0) + found;
      } catch (_) {}
    }
  }

  /* PEX 收集：对最近活跃的种子，取其已知 peer 做 PEX 扩散发现 */
  async _pexHarvest() {
    const d = db.get();
    // 取最近有观测的种子及其 peer
    const rows = d.prepare(`
      SELECT DISTINCT o.infohash FROM observations o
      JOIN torrents t ON t.infohash = o.infohash
      WHERE o.last_seen > ? ORDER BY o.last_seen DESC LIMIT 3
    `).all(Date.now() - 600000); // 10 分钟内有观测
    for (const r of rows) {
      try {
        const peers = d.prepare('SELECT ip, port FROM obs_log WHERE infohash=? AND port IS NOT NULL ORDER BY id DESC LIMIT 20').all(r.infohash);
        if (!peers.length) continue;
        const discovered = await pex.harvest(r.infohash, peers, (ev) => this._ingest(ev));
        this.counters.pexPeers = (this.counters.pexPeers || 0) + discovered.length;
      } catch (_) {}
    }
  }

  /* 手动注入一批模拟事件（WEBUI 的"立即灌入"按钮） */
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
    const d = db.get();
    const now = Date.now();
    const ratePerMin = this.ring.filter(e => now - e.ts < 60000).length;
    const s = this.spider ? this.spider.stats : null;
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
      dht: this.spider ? {
        running: true, nodes: this.spider.nodes.size,
        rx: s.rx, tx: s.tx, peers: s.peers, announces: s.announces,
      } : { running: false, nodes: 0, rx: 0, tx: 0, peers: 0, announces: 0 },
      recent: this.ring.slice(-30).reverse(),
    };
  }

  getNodes() {
    if (!this.spider) return { nodes: [] };
    const now = Date.now();
    const nodes = [...this.spider.nodes.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 100)
      .map(n => ({
        id: n.id.toString('hex').slice(0, 16) + '…',
        address: `${n.host}:${n.port}`,
        ageSec: Math.floor((now - n.lastSeen) / 1000),
      }));
    return { nodes };
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
