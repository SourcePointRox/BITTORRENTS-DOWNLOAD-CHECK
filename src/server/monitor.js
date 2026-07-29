'use strict';
/* 独立监控 WebUI：专门监控后端运行状态的独立 HTTP 服务。
   运行在独立端口上，与主站点分离，提供：
   - 各服务运行状态（主站点 / 采集器 / DHT 集群 / Tracker / PEX / 爬虫 / WebSeed）
   - 实时采集速率与事件流
   - DHT 路由表节点详情
   - 来源分布（DHT / Tracker / PEX / 爬虫 / 模拟器）
   - 系统资源占用（内存 / uptime）
   - 历史采集趋势图表
   API 分层设计（大负荷与主进程脱离，分步加载防卡死）：
   - /api/stats    轻量：计数器/状态/健康度（2s 轮询）
   - /api/charts   重量：时间桶聚合 SQL（5s 轮询，独立端点）
   - /api/trackers 大表：全量 tracker 详情（10s 轮询，独立端点）
   - /api/nodes    DHT 路由表（10s 轮询） */
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

let collectorRef = null;
let sitePort = null;
let monitorPort = null;

function init(collector, sp, mp) {
  collectorRef = collector;
  sitePort = sp;
  monitorPort = mp;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

/* 系统指标 */
function systemMetrics() {
  const mem = process.memoryUsage();
  return {
    uptime: Math.floor(process.uptime()),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    cpuCount: os.cpus().length,
    loadAvg: os.loadavg(),
    freeMem: os.freemem(),
    totalMem: os.totalmem(),
    platform: process.platform,
    nodeVersion: process.version,
  };
}

/* 时间桶统计（总量）。
   minutes <= 360 用分钟桶（60000ms），> 360 用小时桶（3600000ms）避免点过密。
   走 idx_obslog_ts 索引范围扫描。 */
function perMinuteBuckets(minutes) {
  const now = Date.now();
  const from = now - minutes * 60000;
  const bucketMs = minutes > 360 ? 3600000 : 60000;
  const rows = db.get().prepare(
    `SELECT (ts/${bucketMs})*${bucketMs} AS bucket, COUNT(*) AS c FROM obs_log WHERE ts >= ? GROUP BY bucket ORDER BY bucket`
  ).all(from);
  const map = new Map(rows.map(r => [Number(r.bucket), r.c]));
  const out = [];
  for (let t = Math.floor(from / bucketMs) * bucketMs; t <= now; t += bucketMs) {
    out.push({ t, c: map.get(t) || 0 });
  }
  return out;
}

/* 按来源分桶统计 —— 用于堆叠面积图，展示各采集器贡献。
   走 idx_obslog_ts_source 索引。 */
const SOURCES = ['dht_passive', 'dht_active', 'dht_sample', 'dht_getpeers', 'tracker', 'pex', 'swarm_merge', 'simulator'];
function perMinuteBySource(minutes) {
  const now = Date.now();
  const from = now - minutes * 60000;
  const bucketMs = minutes > 360 ? 3600000 : 60000;
  const rows = db.get().prepare(
    `SELECT (ts/${bucketMs})*${bucketMs} AS bucket, source, COUNT(*) AS c FROM obs_log WHERE ts >= ? GROUP BY bucket, source ORDER BY bucket`
  ).all(from);
  // bucket -> { t, dht_passive, dht_active, ... }
  const map = new Map();
  for (const r of rows) {
    const b = Number(r.bucket);
    if (!map.has(b)) map.set(b, { t: b });
    const o = map.get(b);
    o[r.source] = (o[r.source] || 0) + r.c;
  }
  const out = [];
  for (let t = Math.floor(from / bucketMs) * bucketMs; t <= now; t += bucketMs) {
    const o = map.get(t) || { t };
    o.total = SOURCES.reduce((s, k) => s + (o[k] || 0), 0);
    out.push(o);
  }
  return out;
}

/* 来源分布（近 1 小时） */
function sourceBreakdown() {
  const since = Date.now() - 3600000;
  return db.get().prepare('SELECT source, COUNT(*) AS c FROM obs_log WHERE ts >= ? GROUP BY source ORDER BY c DESC').all(since);
}

/* Top 国家（近 24 小时地理分布，基于 country_daily） */
function topCountries(limit = 10) {
  const since = fmtDay(Date.now() - 86400000);
  const rows = db.get().prepare(
    'SELECT cc, SUM(peers) AS c FROM country_daily WHERE day >= ? GROUP BY cc ORDER BY c DESC LIMIT ?'
  ).all(since, limit);
  return rows.map(r => ({ cc: r.cc, c: r.c }));
}

/* 元数据解析统计：已解析 size 的种子数 / 总种子数 + v1/v2/hybrid 分布 */
function metaStats() {
  const d = db.get();
  const total = d.prepare('SELECT COUNT(*) AS c FROM torrents').get().c;
  const withMeta = d.prepare('SELECT COUNT(*) AS c FROM torrents WHERE metadata_ok=1').get().c;
  const withSize = d.prepare('SELECT COUNT(*) AS c FROM torrents WHERE size > 0').get().c;
  const withName = d.prepare('SELECT COUNT(*) AS c FROM torrents WHERE name IS NOT NULL').get().c;
  // hash_version 分布：1=v1, 2=v2, 3=hybrid
  const verRows = d.prepare('SELECT hash_version, COUNT(*) AS c FROM torrents GROUP BY hash_version').all();
  const versions = { v1: 0, v2: 0, hybrid: 0 };
  for (const r of verRows) {
    if (r.hash_version === 2) versions.v2 = r.c;
    else if (r.hash_version === 3) versions.hybrid = r.c;
    else versions.v1 = r.c;
  }
  // 通过 infohash 长度补全 v2 检测（兼容老数据未填 hash_version 的情况）
  const byLen = d.prepare(`SELECT
    SUM(CASE WHEN length(infohash)=40 THEN 1 ELSE 0 END) AS v1len,
    SUM(CASE WHEN length(infohash)=64 THEN 1 ELSE 0 END) AS v2len
    FROM torrents`).get();
  if (byLen && byLen.v2len > 0 && versions.v2 === 0 && versions.hybrid === 0) {
    versions.v2 = byLen.v2len;
    versions.v1 = byLen.v1len;
  }
  // v2 piece layers 落库情况
  const withPieceLayers = d.prepare('SELECT COUNT(*) AS c FROM torrents WHERE piece_layers_json IS NOT NULL').get().c;
  const withFileTree = d.prepare('SELECT COUNT(*) AS c FROM torrents WHERE file_tree_json IS NOT NULL').get().c;
  return { total, withMeta, withSize, withName, versions, withPieceLayers, withFileTree };
}

/* IPv6 peer 统计：obs_log 中 IPv6 地址数量（按 ip 含冒号判定） */
function ipv6Stats() {
  const d = db.get();
  const since1h = Date.now() - 3600000;
  const since24h = Date.now() - 86400000;
  const peers6_1h = d.prepare("SELECT COUNT(DISTINCT ip) AS c FROM obs_log WHERE ts >= ? AND ip LIKE '%:%'").get(since1h).c;
  const peers6_24h = d.prepare("SELECT COUNT(DISTINCT ip) AS c FROM obs_log WHERE ts >= ? AND ip LIKE '%:%'").get(since24h).c;
  const peers6_total = d.prepare("SELECT COUNT(DISTINCT ip) AS c FROM obs_log WHERE ip LIKE '%:%'").get().c;
  const peers4_total = d.prepare("SELECT COUNT(DISTINCT ip) AS c FROM obs_log WHERE ip NOT LIKE '%:%'").get().c;
  const pct = (peers6_total + peers4_total) > 0
    ? (peers6_total * 100 / (peers6_total + peers4_total)).toFixed(2)
    : '0.00';
  return { peers6_1h, peers6_24h, peers6_total, peers4_total, pct: Number(pct) };
}

function fmtDay(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* 采集器健康度评估 */
function healthScore(stats) {
  let score = 100;
  if (stats.mode === 'off') return 0;
  if (stats.mode === 'live') {
    if (stats.dht.nodes < 10) score -= 30;
    if (stats.dht.nodes < 50) score -= 20;
    if (stats.ratePerMin < 1) score -= 20;
    if (stats.counters.metaFailed > stats.counters.metaResolved && stats.counters.metaResolved > 5) score -= 15;
  }
  if (stats.db.obsLog === 0) score -= 50;
  return Math.max(0, Math.min(100, score));
}

/* 轻量统计（2s 轮询）：计数器 + 状态，不跑聚合 SQL */
function lightStats() {
  const s = collectorRef.getStats();
  return {
    mode: s.mode,
    startedAt: s.startedAt,
    uptimeSec: s.uptimeSec,
    db: s.db,
    todayEvents: s.todayEvents,
    ratePerMin: s.ratePerMin,
    counters: s.counters,
    metaQueue: s.metaQueue,
    dht: s.dht,
    tracker: s.tracker ? {
      total: s.tracker.total, alive: s.tracker.alive, dead: s.tracker.dead,
      unchecked: s.tracker.unchecked, avgLatency: s.tracker.avgLatency,
      sources: s.tracker.sources, checking: s.tracker.checking,
    } : null,
    crawler: s.crawler,
    webseed: s.webseed,
    metaSearch: s.metaSearch,
    geo: s.geo,
    coldStorage: s.coldStorage,
    meta: metaStats(),
    ipv6: ipv6Stats(),
    system: systemMetrics(),
    health: healthScore(s),
    sitePort,
    metaSuccessRate: s.counters.metaResolved + s.counters.metaFailed > 0
      ? Math.round(s.counters.metaResolved * 100 / (s.counters.metaResolved + s.counters.metaFailed)) : 0,
    recent: (() => {
      const d = db.get();
      const stmt = d.prepare('SELECT name, size FROM torrents WHERE infohash=?');
      return s.recent.map(e => {
        const t = stmt.get(e.infohash);
        return { ...e, name: (t && t.name) || e.infohash.slice(0, 16) + '…', size: (t && t.size) || 0 };
      });
    })(),
  };
}

/* 路由 */
async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;

  // 静态资源服务（Chart.js / CSS / 字体等，从 public 目录提供）
  if (pathname.startsWith('/assets/')) {
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return json(res, 404, { error: 'NOT_FOUND' });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    return fs.createReadStream(file).pipe(res);
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(dashboardHtml());
  }
  if (pathname === '/api/health') {
    if (!collectorRef) return json(res, 503, { error: 'collector not initialized' });
    const s = collectorRef.getStats();
    return json(res, 200, {
      mode: s.mode,
      health: healthScore(s),
      uptime: s.uptimeSec,
      sitePort,
      monitorPort,
      system: systemMetrics(),
    });
  }
  // 轻量统计（高频轮询）
  if (pathname === '/api/stats') {
    if (!collectorRef) return json(res, 503, { error: 'collector not initialized' });
    return json(res, 200, lightStats());
  }
  // 重量图表数据（独立端点，低频轮询，与主流程脱离）
  if (pathname === '/api/charts') {
    if (!collectorRef) return json(res, 503, { error: 'collector not initialized' });
    const mins = parseInt(u.searchParams.get('mins') || '60', 10);
    const perMinute = perMinuteBuckets(mins);
    const perMinuteSrc = perMinuteBySource(mins);
    const vals = perMinute.map(b => b.c).filter(c => c > 0);
    return json(res, 200, {
      mins,
      perMinute,
      perMinuteBySource: perMinuteSrc,
      sources: sourceBreakdown(),
      topCountries: topCountries(10),
      peakRate: vals.length ? Math.max(...vals) : 0,
      avgRate: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0,
    });
  }
  // 全量 tracker 详情（独立端点，大表，低频轮询；存活在前死亡在后）
  if (pathname === '/api/trackers') {
    if (!collectorRef) return json(res, 503, { error: 'collector not initialized' });
    let list = [];
    try { list = collectorRef.getTrackerList(); } catch (_) { list = []; }
    const t = collectorRef.trackerMgr ? collectorRef.trackerMgr.getStats() : null;
    return json(res, 200, { total: list.length, stats: t, list });
  }
  if (pathname === '/api/nodes') {
    if (!collectorRef) return json(res, 503, { error: 'collector not initialized' });
    return json(res, 200, collectorRef.getNodes());
  }
  if (pathname === '/api/system') {
    return json(res, 200, systemMetrics());
  }
  if (pathname === '/api/trend') {
    // 最近 6 小时每小时采集趋势
    const now = Date.now();
    const from = now - 6 * 3600000;
    const rows = db.get().prepare(
      'SELECT (ts/3600000)*3600000 AS bucket, COUNT(*) AS c FROM obs_log WHERE ts >= ? GROUP BY bucket ORDER BY bucket'
    ).all(from);
    return json(res, 200, { trend: rows.map(r => ({ t: Number(r.bucket), c: r.c })) });
  }
  return json(res, 404, { error: 'NOT_FOUND' });
}

/* 监控仪表盘 HTML —— 高信息密度 + 平滑图表 + 分步加载（防卡死） */
function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BITTORRENTS 网络监控中心</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0e14; color: #c9d1d9; font-family: 'Segoe UI', 'Consolas', monospace; min-height: 100vh; font-size: 13px; }
  .header { background: linear-gradient(135deg, #161d27 0%, #0f1419 100%); border-bottom: 2px solid #238636; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; box-shadow: 0 2px 12px rgba(0,0,0,0.5); }
  .header h1 { font-size: 18px; color: #58a6ff; display: flex; align-items: center; gap: 10px; }
  .header h1 .icon { width: 26px; height: 26px; background: linear-gradient(135deg,#238636,#2ea043); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; color: #fff; box-shadow: 0 0 10px rgba(35,134,54,0.6); }
  .header .status-bar { display: flex; gap: 14px; align-items: center; font-size: 12px; }
  .health-badge { padding: 3px 12px; border-radius: 16px; font-weight: 600; font-size: 11px; }
  .health-good { background: rgba(35,134,54,0.2); color: #3fb950; border: 1px solid #238636; }
  .health-warn { background: rgba(187,128,9,0.2); color: #d29922; border: 1px solid #bb8009; }
  .health-bad { background: rgba(248,81,73,0.2); color: #f85149; border: 1px solid #f85149; }
  .container { max-width: 1680px; margin: 0 auto; padding: 14px; }
  .grid { display: grid; gap: 12px; }
  .grid-8 { grid-template-columns: repeat(8, 1fr); }
  .grid-4 { grid-template-columns: repeat(4, 1fr); }
  .grid-3 { grid-template-columns: repeat(3, 1fr); }
  .grid-2 { grid-template-columns: repeat(2, 1fr); }
  .grid-2-1 { grid-template-columns: 2fr 1fr; }
  @media (max-width: 1200px) { .grid-8 { grid-template-columns: repeat(4, 1fr); } .grid-2-1 { grid-template-columns: 1fr; } }
  @media (max-width: 800px) { .grid-8, .grid-4, .grid-3, .grid-2, .grid-2-1 { grid-template-columns: 1fr; } }
  .card { background: #161d27; border: 1px solid #232c38; border-radius: 8px; padding: 12px 14px; box-shadow: 0 1px 4px rgba(0,0,0,0.3); transition: border-color 0.2s; }
  .card:hover { border-color: #2d3a4a; }
  .card-title { font-size: 10px; color: #7d8a99; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
  .stat-value { font-size: 24px; font-weight: 700; color: #fff; line-height: 1.1; }
  .stat-sub { font-size: 11px; color: #54626f; margin-top: 3px; }
  .up { color: #3fb950; }
  .down { color: #f85149; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { color: #7d8a99; font-weight: 600; text-transform: uppercase; font-size: 10px; padding: 6px 8px; text-align: left; border-bottom: 1px solid #232c38; position: sticky; top: 0; background: #161d27; z-index: 2; }
  td { padding: 4px 8px; border-bottom: 1px solid #1a2230; color: #c3ccd6; }
  tr:hover td { background: #18202c; }
  .mono { font-family: 'Consolas', monospace; font-size: 11px; }
  .pulse { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
  .pulse-on { background: #3fb950; box-shadow: 0 0 6px #3fb950; animation: pulse 2s infinite; }
  .pulse-off { background: #555; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  .src-badge { padding: 1px 7px; border-radius: 9px; font-size: 10px; font-weight: 600; white-space: nowrap; }
  .src-dht_passive { background: #3d2a5c; color: #c49aff; }
  .src-dht_active { background: #2a5c46; color: #8affc1; }
  .src-dht_sample { background: #2a425c; color: #7dc4ff; }
  .src-dht_getpeers { background: #5c2a4a; color: #ff7dd1; }
  .src-tracker { background: #5c4a24; color: #ffd77d; }
  .src-pex { background: #5c2424; color: #ff9a9a; }
  .src-swarm_merge { background: #24535c; color: #7de8ff; }
  .src-simulator { background: #24425c; color: #7dc4ff; }
  .chart-container { position: relative; height: 240px; margin-top: 6px; }
  .chart-sm { height: 120px; }
  .bar { display: inline-block; height: 14px; border-radius: 2px; vertical-align: middle; transition: width 0.6s ease; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer { text-align: center; padding: 14px; color: #54626f; font-size: 11px; }
  .progress-bar { width: 100%; height: 5px; background: #232c38; border-radius: 3px; overflow: hidden; margin-top: 6px; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #238636, #3fb950); transition: width 0.6s ease; }
  .tw-btn { padding: 3px 10px; border-radius: 4px; border: 1px solid #232c38; background: transparent; color: #7d8a99; cursor: pointer; font-size: 11px; }
  .tw-btn.active { background: #238636; color: #fff; border-color: #238636; }
  .tw-btn:hover { border-color: #3fb950; }
  .legend { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; font-size: 11px; }
  .legend span { display: flex; align-items: center; gap: 4px; }
  .legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .scroll { max-height: 320px; overflow-y: auto; }
  .scroll-tall { max-height: 460px; overflow-y: auto; }
  .scroll::-webkit-scrollbar, .scroll-tall::-webkit-scrollbar { width: 6px; }
  .scroll::-webkit-scrollbar-thumb, .scroll-tall::-webkit-scrollbar-thumb { background: #2d3a4a; border-radius: 3px; }
  .scroll::-webkit-scrollbar-thumb:hover, .scroll-tall::-webkit-scrollbar-thumb:hover { background: #3d4a5a; }
  .mini-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .mini-stat { background: #0f1419; border-radius: 4px; padding: 6px 8px; }
  .mini-stat .v { font-size: 15px; font-weight: 600; color: #fff; }
  .mini-stat .l { font-size: 10px; color: #54626f; }
  .trk-filter { width: 180px; background: #0f1419; border: 1px solid #232c38; border-radius: 4px; color: #c9d1d9; padding: 3px 8px; font-size: 11px; outline: none; }
  .trk-filter:focus { border-color: #58a6ff; }
  .badge-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
  .loading { color: #54626f; text-align: center; padding: 20px; font-size: 12px; }
  .skeleton { background: linear-gradient(90deg, #161d27 25%, #1a2230 50%, #161d27 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  .fade-in { animation: fadeIn 0.4s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
</style>
</head>
<body>
<div class="header">
  <h1><span class="icon">B</span>BITTORRENTS 网络监控中心</h1>
  <div class="status-bar">
    <span id="healthBadge" class="health-badge health-bad">—</span>
    <span id="uptimeText" style="color:#7d8a99">—</span>
    <a href="/" id="siteLink" target="_blank" style="font-size:11px">主站点 →</a>
  </div>
</div>

<div class="container">
  <!-- 核心指标卡片（8 列高密度） -->
  <div class="grid grid-8">
    <div class="card">
      <div class="card-title">采集模式</div>
      <div class="stat-value" id="mode" style="font-size:18px">—</div>
      <div class="stat-sub" id="modeSub">stopped</div>
    </div>
    <div class="card">
      <div class="card-title">种子总数</div>
      <div class="stat-value" id="torrents">0</div>
      <div class="stat-sub" id="newTorrents">新增 0</div>
    </div>
    <div class="card">
      <div class="card-title">IP 节点</div>
      <div class="stat-value" id="peers">0</div>
      <div class="stat-sub" id="todayEvents">今日 0</div>
    </div>
    <div class="card">
      <div class="card-title">当前速率</div>
      <div class="stat-value" id="rate">0<span style="font-size:12px;color:#7d8a99">/min</span></div>
      <div class="stat-sub">峰值 <span id="peakRate">0</span> · 均值 <span id="avgRate">0</span></div>
    </div>
    <div class="card">
      <div class="card-title">DHT 节点</div>
      <div class="stat-value" id="dhtNodes">—</div>
      <div class="stat-sub" id="dhtStats">未运行</div>
    </div>
    <div class="card">
      <div class="card-title">元数据成功率</div>
      <div class="stat-value" id="metaRate">—</div>
      <div class="stat-sub" id="metaDetail">解析 0 / 失败 0</div>
    </div>
    <div class="card">
      <div class="card-title">累计事件</div>
      <div class="stat-value" id="totalEvents" style="font-size:20px">0</div>
      <div class="stat-sub" id="obsDetail">观测 0 · 日志 0</div>
    </div>
    <div class="card">
      <div class="card-title">健康度</div>
      <div class="stat-value" id="health">—</div>
      <div class="progress-bar"><div class="progress-fill" id="healthBar" style="width:0%"></div></div>
    </div>
  </div>

  <!-- 主图表 + Top 国家扇形图 -->
  <div class="grid grid-2-1" style="margin-top:12px">
    <div class="card">
      <div class="card-title">
        <span>采集趋势 · 多来源堆叠</span>
        <span>
          <button class="tw-btn" data-mins="15">15m</button>
          <button class="tw-btn active" data-mins="60">1h</button>
          <button class="tw-btn" data-mins="180">3h</button>
          <button class="tw-btn" data-mins="360">6h</button>
          <button class="tw-btn" data-mins="720">12h</button>
          <button class="tw-btn" data-mins="1440">24h</button>
        </span>
      </div>
      <div class="chart-container"><canvas id="rateChart"></canvas></div>
      <div class="legend" id="chartLegend"></div>
    </div>
    <div class="card">
      <div class="card-title"><span>Top 国家分布（近 24h）</span><span id="ccTotal" style="color:#54626f"></span></div>
      <div class="chart-container" style="height:210px"><canvas id="ccChart"></canvas></div>
      <div id="ccLegend" style="margin-top:8px;font-size:11px"></div>
    </div>
  </div>

  <!-- 来源分布 + 采集器状态 + 元数据 -->
  <div class="grid grid-3" style="margin-top:12px">
    <div class="card">
      <div class="card-title"><span>来源分布（近 1h）</span><span id="srcTotal" style="color:#54626f"></span></div>
      <div id="sourceList" style="margin-top:8px"><div class="loading">加载中…</div></div>
    </div>
    <div class="card">
      <div class="card-title">采集器状态</div>
      <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
        <div id="dhtStatus"><span class="pulse pulse-off"></span>DHT 未运行</div>
        <div id="trackerStatus"><span class="pulse pulse-off"></span>Tracker 未运行</div>
        <div id="pexStatus"><span class="pulse pulse-off"></span>PEX 未运行</div>
        <div id="crawlerStatus"><span class="pulse pulse-off"></span>爬虫聚合 未运行</div>
      </div>
      <div class="mini-grid" style="margin-top:10px">
        <div class="mini-stat"><div class="l">DHT rx/tx</div><div class="v" id="dhtRxTx">— / —</div></div>
        <div class="mini-stat"><div class="l">DHT peers</div><div class="v" id="dhtPeers">0</div></div>
        <div class="mini-stat"><div class="l">Tracker peers</div><div class="v" id="trkPeers">0</div></div>
        <div class="mini-stat"><div class="l">PEX peers</div><div class="v" id="pexPeers">0</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">元数据解析进度</div>
      <div class="mini-grid" style="margin-top:8px">
        <div class="mini-stat"><div class="l">种子总数</div><div class="v" id="metaTotal">0</div></div>
        <div class="mini-stat"><div class="l">已解析名</div><div class="v" id="metaName">0</div></div>
        <div class="mini-stat"><div class="l">已解析 size</div><div class="v" id="metaSize">0</div></div>
        <div class="mini-stat"><div class="l">聚合补全</div><div class="v" id="metaEnriched" style="color:#d29922">0</div></div>
      </div>
      <div style="margin-top:8px">
        <div class="l" style="font-size:10px;color:#54626f">size 落库率</div>
        <div class="progress-bar"><div class="progress-fill" id="sizeBar" style="width:0%"></div></div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:#54626f">队列 <span id="metaQueue">0</span> · 元数据 OK <span id="metaOk">0</span></div>
    </div>
  </div>

  <!-- IPv6 + v2 + 冷存储 + Tracker 四面板 -->
  <div class="grid grid-4" style="margin-top:12px">
    <div class="card">
      <div class="card-title"><span>IPv6 采集统计</span><span id="ipv6Pct" style="color:#3fb950;font-weight:600">0%</span></div>
      <div class="mini-grid" style="margin-top:8px">
        <div class="mini-stat"><div class="l">v6 peer 总数</div><div class="v" id="v6Total">0</div></div>
        <div class="mini-stat"><div class="l">v4 peer 总数</div><div class="v" id="v4Total">0</div></div>
        <div class="mini-stat"><div class="l">v6 (1h)</div><div class="v" id="v6_1h">0</div></div>
        <div class="mini-stat"><div class="l">v6 (24h)</div><div class="v" id="v6_24h">0</div></div>
      </div>
      <div style="margin-top:8px">
        <div class="l" style="font-size:10px;color:#54626f">IPv6 占比</div>
        <div class="progress-bar"><div class="progress-fill" id="ipv6Bar" style="width:0%;background:linear-gradient(90deg,#1f6feb,#58a6ff)"></div></div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:#54626f">DHT 直接捕获 <span id="dhtV6Peers" style="color:#58a6ff">0</span> · v6 路由 <span id="dhtNodes6" style="color:#58a6ff">0</span> · uTP <span id="dhtUtpPeers" style="color:#d29922">0</span></div>
    </div>

    <div class="card">
      <div class="card-title"><span>Info Hash v2 (BEP-52)</span><span id="v2Pct" style="color:#d29922;font-weight:600">0%</span></div>
      <div class="mini-grid" style="margin-top:8px">
        <div class="mini-stat"><div class="l">v1 种子</div><div class="v" id="v1Count">0</div></div>
        <div class="mini-stat"><div class="l">v2 种子</div><div class="v" id="v2Count" style="color:#d29922">0</div></div>
        <div class="mini-stat"><div class="l">hybrid 种子</div><div class="v" id="hybridCount" style="color:#d29922">0</div></div>
        <div class="mini-stat"><div class="l">piece layers</div><div class="v" id="pieceLayers">0</div></div>
      </div>
      <div style="margin-top:8px">
        <div class="l" style="font-size:10px;color:#54626f">v2 落库率</div>
        <div class="progress-bar"><div class="progress-fill" id="v2Bar" style="width:0%;background:linear-gradient(90deg,#bb8009,#d29922)"></div></div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:#54626f">file tree <span id="fileTree">0</span></div>
    </div>

    <div class="card">
      <div class="card-title"><span>冷存储状态</span><span id="coldRunning" style="color:#f85149">未启动</span></div>
      <div class="mini-grid" style="margin-top:8px">
        <div class="mini-stat"><div class="l">冷库总数</div><div class="v" id="coldTotal">0</div></div>
        <div class="mini-stat"><div class="l">已同步</div><div class="v" id="coldSynced" style="color:#3fb950">0</div></div>
        <div class="mini-stat"><div class="l">待同步</div><div class="v" id="coldPending" style="color:#d29922">0</div></div>
        <div class="mini-stat"><div class="l">同步率</div><div class="v" id="coldRate">0%</div></div>
      </div>
      <div style="margin-top:8px;font-size:10px;color:#54626f">数据库路径：</div>
      <div id="coldPath" class="mono" style="font-size:10px;color:#7d8a99;word-break:break-all;margin-top:2px">—</div>
      <div style="margin-top:6px;font-size:11px;color:#54626f">最近同步 <span id="coldLastSync">—</span></div>
    </div>

    <div class="card">
      <div class="card-title"><span>Tracker 健康度</span><span id="trkAlive" style="color:#3fb950;font-weight:600">0/0</span></div>
      <div class="mini-grid" style="margin-top:8px">
        <div class="mini-stat"><div class="l">总 tracker</div><div class="v" id="trkTotal">0</div></div>
        <div class="mini-stat"><div class="l">存活</div><div class="v" id="trkAliveCount" style="color:#3fb950">0</div></div>
        <div class="mini-stat"><div class="l">死亡/未检</div><div class="v" id="trkDead" style="color:#f85149">0</div></div>
        <div class="mini-stat"><div class="l">平均延迟</div><div class="v" id="trkAvgLat">0ms</div></div>
      </div>
      <div style="margin-top:8px;font-size:10px;color:#54626f">存活率</div>
      <div class="progress-bar"><div class="progress-fill" id="trkBar" style="width:0%;background:linear-gradient(90deg,#238636,#3fb950)"></div></div>
      <div style="margin-top:6px;font-size:11px;color:#54626f" id="trkChecking">详情见下方列表</div>
    </div>
  </div>

  <!-- Tracker 全量详情 + 采集器综合统计 -->
  <div class="grid grid-2-1" style="margin-top:12px">
    <div class="card">
      <div class="card-title">
        <span>Tracker 详情（全量 · 存活在前 · 滚动查看）</span>
        <span>
          <input type="text" class="trk-filter" id="trkFilter" placeholder="过滤 URL…">
          <span id="trkListCount" style="color:#54626f;margin-left:8px"></span>
        </span>
      </div>
      <div class="scroll-tall" id="trkScroll" style="max-height:420px">
      <table>
        <thead><tr><th>Tracker URL</th><th>状态</th><th>延迟</th><th>失败</th><th>最近检查</th></tr></thead>
        <tbody id="trkListBody"><tr><td colspan="5" class="loading">分步加载中…</td></tr></tbody>
      </table>
      </div>
    </div>
    <div class="card">
      <div class="card-title">采集器综合统计</div>
      <div class="mini-grid" style="margin-top:8px">
        <div class="mini-stat"><div class="l">会话累计</div><div class="v" id="ingestedCount">0</div></div>
        <div class="mini-stat"><div class="l">本次新增</div><div class="v" id="newTorrents2">0</div></div>
        <div class="mini-stat"><div class="l">DHT announce</div><div class="v" id="dhtAnn">0</div></div>
        <div class="mini-stat"><div class="l">DHT sample</div><div class="v" id="dhtSmp">0</div></div>
        <div class="mini-stat"><div class="l">爬虫 trawl</div><div class="v" id="crawlTrawl">0</div></div>
        <div class="mini-stat"><div class="l">swarm 合并</div><div class="v" id="crawlMerge">0</div></div>
        <div class="mini-stat"><div class="l">WebSeed 源</div><div class="v" id="wsReg">0</div></div>
        <div class="mini-stat"><div class="l">WS 修正分类</div><div class="v" id="wsReclass">0</div></div>
      </div>
      <div style="margin-top:8px">
        <div class="l" style="font-size:10px;color:#54626f">DHT 集群端口</div>
        <div id="dhtPorts" class="mono" style="font-size:11px;color:#7d8a99;margin-top:2px">—</div>
      </div>
      <div style="margin-top:6px">
        <div class="l" style="font-size:10px;color:#54626f">GeoIP 解析服务</div>
        <div id="geoProviders" class="mono" style="font-size:11px;color:#7d8a99;margin-top:2px">—</div>
      </div>
      <div style="margin-top:6px">
        <div class="l" style="font-size:10px;color:#54626f">元数据聚合源</div>
        <div id="metaProviders" class="mono" style="font-size:11px;color:#7d8a99;margin-top:2px">—</div>
      </div>
    </div>
  </div>

  <!-- 实时事件流 + DHT 路由表 + 系统资源 -->
  <div class="grid grid-3" style="margin-top:12px">
    <div class="card">
      <div class="card-title">实时事件流（最近 30 条）</div>
      <div class="scroll">
      <table>
        <thead><tr><th>时间</th><th>IP</th><th>资源名</th><th>大小</th><th>来源</th></tr></thead>
        <tbody id="recentBody"><tr><td colspan="5" class="loading">等待数据...</td></tr></tbody>
      </table>
      </div>
    </div>
    <div class="card">
      <div class="card-title">DHT 路由表节点 <span id="nodeCount" style="font-size:10px;color:#54626f"></span></div>
      <div class="scroll">
      <table>
        <thead><tr><th>Node ID</th><th>地址</th><th>族</th><th>年龄</th></tr></thead>
        <tbody id="nodesBody"><tr><td colspan="4" class="loading">DHT 未运行</td></tr></tbody>
      </table>
      </div>
    </div>
    <div class="card">
      <div class="card-title">系统资源</div>
      <div class="mini-grid" style="margin-top:8px">
        <div class="mini-stat"><div class="l">内存 RSS</div><div class="v" id="rss">— MB</div></div>
        <div class="mini-stat"><div class="l">堆使用</div><div class="v" id="heapUsed">— MB</div></div>
        <div class="mini-stat"><div class="l">运行时长</div><div class="v" id="sysUptime">—</div></div>
        <div class="mini-stat"><div class="l">Node 版本</div><div class="v" id="nodeVer" style="font-size:12px">—</div></div>
      </div>
      <div style="margin-top:8px">
        <div class="l" style="font-size:10px;color:#54626f">内存占用趋势</div>
        <div class="chart-container chart-sm" style="height:80px;margin-top:4px"><canvas id="memChart"></canvas></div>
      </div>
    </div>
  </div>
</div>

<div class="footer">BITTORRENTS Network Monitor · DHT 集群 + PEX + Tracker + 爬虫聚合 + WebSeed 全网络接入 · 分步加载 · 平滑过渡</div>

<script src="/assets/js/chart.umd.min.js"></script>
<script>
var rateChart = null, memChart = null, ccChart = null;
var curMins = 60;
var memHistory = [];
var trkCache = [];
var trkFilterText = '';
var CC_COLORS = ['#36a2eb','#ff6384','#ff9f40','#4bc0c0','#9966ff','#ffcd56','#3fb950','#58a6ff','#d29922','#c9cbcf'];
var SRC_DEFS = [
  { key: 'dht_passive', label: 'DHT被动', color: '#9966ff' },
  { key: 'dht_active', label: 'DHT主动', color: '#4bc0c0' },
  { key: 'dht_sample', label: 'DHT采样', color: '#36a2eb' },
  { key: 'dht_getpeers', label: 'DHT查询', color: '#ff7dd1' },
  { key: 'tracker', label: 'Tracker', color: '#ff9f40' },
  { key: 'pex', label: 'PEX', color: '#ff6384' },
  { key: 'swarm_merge', label: 'Swarm合并', color: '#7de8ff' },
  { key: 'simulator', label: '模拟', color: '#a0a0a0' }
];

function fmt(n) { return (n||0).toLocaleString('en-US'); }
function fmtMB(b) { return (b/1048576).toFixed(1) + ' MB'; }
function fmtSize(b) { if (!b||b<=0) return '—'; if (b<1024) return b+'B'; if (b<1048576) return (b/1024).toFixed(1)+'KB'; if (b<1073741824) return (b/1048576).toFixed(1)+'MB'; return (b/1073741824).toFixed(2)+'GB'; }
function fmtTime(ts) { return new Date(ts).toTimeString().slice(0,8); }
function fmtAgo(ts) { if (!ts) return '—'; var s = Math.floor((Date.now()-ts)/1000); if (s<60) return s+'s前'; if (s<3600) return Math.floor(s/60)+'m前'; return Math.floor(s/3600)+'h前'; }
function fmtDur(s) { if (s<60) return s+'s'; if (s<3600) return Math.floor(s/60)+'m'+s%60+'s'; return Math.floor(s/3600)+'h'+Math.floor((s%3600)/60)+'m'; }
function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function updateHealth(score) {
  var el = document.getElementById('healthBadge');
  document.getElementById('healthBar').style.width = score + '%';
  el.className = 'health-badge ' + (score >= 70 ? 'health-good' : score >= 30 ? 'health-warn' : 'health-bad');
  el.textContent = score >= 70 ? '健康' : score >= 30 ? '警告' : '异常';
}

/* 平滑更新图表：保留 Chart 实例，仅更新 data + labels 后调用 update() */
function ensureRateChart() {
  if (rateChart) return rateChart;
  var ctx = document.getElementById('rateChart').getContext('2d');
  rateChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: SRC_DEFS.map(function(s) {
      return { label: s.label, data: [], borderColor: s.color, backgroundColor: s.color + '33', fill: true, pointRadius: 0, borderWidth: 1.2, lineTension: 0.35 };
    }) },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      animation: { duration: 400, easing: 'easeOutQuart' },
      scales: {
        x: { ticks: { color: '#7d8a99', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: '#1c2530' } },
        y: { stacked: true, ticks: { color: '#7d8a99', beginAtZero: true, font: { size: 10 } }, grid: { color: '#1c2530' } }
      }
    }
  });
  document.getElementById('chartLegend').innerHTML = SRC_DEFS.map(function(s) {
    return '<span><i style="background:' + s.color + '"></i>' + s.label + '</span>';
  }).join('');
  return rateChart;
}

/* Top 国家扇形图（doughnut） */
function ensureCcChart() {
  if (ccChart) return ccChart;
  var ctx = document.getElementById('ccChart').getContext('2d');
  ccChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: CC_COLORS, borderColor: '#161d27', borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '58%',
      plugins: {
        legend: { display: true, position: 'right', labels: { color: '#c9d1d9', font: { size: 10 }, boxWidth: 10, padding: 6 } },
        tooltip: { callbacks: { label: function(item) { var total = item.dataset.data.reduce(function(a,b){return a+b;},0)||1; return ' ' + item.label + ': ' + fmt(item.raw) + ' (' + (item.raw*100/total).toFixed(1) + '%)'; } } }
      },
      animation: { duration: 500 }
    }
  });
  return ccChart;
}

function ensureMemChart() {
  if (memChart) return memChart;
  var ctx = document.getElementById('memChart').getContext('2d');
  memChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#d29922', backgroundColor: 'rgba(210,153,34,0.15)', fill: true, pointRadius: 0, borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, animation: { duration: 400 }, scales: { x: { display: false }, y: { ticks: { color: '#7d8a99', font: { size: 9 }, callback: function(v){ return (v/1048576).toFixed(0)+'M'; } }, grid: { color: '#1c2530' } } } }
  });
  return memChart;
}

/* ---- 轻量统计渲染（2s） ---- */
function renderStats(s) {
  document.getElementById('mode').textContent = s.mode.toUpperCase();
  document.getElementById('modeSub').textContent = s.mode === 'off' ? 'stopped' : ('run ' + fmtDur(s.uptimeSec));
  document.getElementById('torrents').textContent = fmt(s.db.torrents);
  document.getElementById('newTorrents').textContent = '新增 ' + fmt(s.counters.newTorrents);
  document.getElementById('peers').textContent = fmt(s.db.peers);
  document.getElementById('todayEvents').textContent = '今日 ' + fmt(s.todayEvents);
  document.getElementById('rate').innerHTML = fmt(s.ratePerMin) + '<span style="font-size:12px;color:#7d8a99">/min</span>';
  document.getElementById('dhtNodes').textContent = s.dht.running ? fmt(s.dht.nodes) : '—';
  document.getElementById('dhtStats').textContent = s.dht.running ? (s.dht.instances + ' 实例 · rx ' + fmt(s.dht.rx) + ' / tx ' + fmt(s.dht.tx)) : '未运行';
  document.getElementById('totalEvents').textContent = fmt(s.db.obsLog);
  document.getElementById('obsDetail').textContent = '观测 ' + fmt(s.db.observations) + ' · 日志 ' + fmt(s.db.obsLog);

  var resolved = s.counters.metaResolved || 0, failed = s.counters.metaFailed || 0;
  document.getElementById('metaRate').textContent = s.metaSuccessRate + '%';
  document.getElementById('metaDetail').textContent = '解析 ' + fmt(resolved) + ' / 失败 ' + fmt(failed);
  if (s.meta) {
    document.getElementById('metaTotal').textContent = fmt(s.meta.total);
    document.getElementById('metaName').textContent = fmt(s.meta.withName);
    document.getElementById('metaSize').textContent = fmt(s.meta.withSize);
    document.getElementById('metaOk').textContent = fmt(s.meta.withMeta);
    var sizeRate = s.meta.total > 0 ? Math.round(s.meta.withSize * 100 / s.meta.total) : 0;
    document.getElementById('sizeBar').style.width = sizeRate + '%';
  }
  document.getElementById('metaEnriched').textContent = fmt(s.counters.metaEnriched || 0);
  document.getElementById('metaQueue').textContent = fmt(s.metaQueue);

  var dhtEl = document.getElementById('dhtStatus');
  if (s.dht.running) dhtEl.innerHTML = '<span class="pulse pulse-on"></span>DHT 集群运行中 ×' + (s.dht.instances||1) + (s.dht.hasV6 ? ' (v4+v6)' : ' (v4)');
  else dhtEl.innerHTML = '<span class="pulse pulse-off"></span>DHT 未运行';
  document.getElementById('dhtRxTx').textContent = fmt(s.dht.rx) + ' / ' + fmt(s.dht.tx);
  document.getElementById('dhtPeers').textContent = fmt(s.dht.peers);
  document.getElementById('trkPeers').textContent = fmt(s.counters.trackerPeers||0);
  document.getElementById('pexPeers').textContent = fmt(s.counters.pexPeers||0);
  document.getElementById('trackerStatus').innerHTML = s.mode === 'live' ? '<span class="pulse pulse-on"></span>Tracker 运行中' : '<span class="pulse pulse-off"></span>Tracker 未运行';
  document.getElementById('pexStatus').innerHTML = s.mode === 'live' ? '<span class="pulse pulse-on"></span>PEX 运行中' : '<span class="pulse pulse-off"></span>PEX 未运行';
  document.getElementById('crawlerStatus').innerHTML = (s.crawler && s.mode === 'live') ? '<span class="pulse pulse-on"></span>爬虫聚合 运行中' : '<span class="pulse pulse-off"></span>爬虫聚合 未运行';

  document.getElementById('health').textContent = s.health;
  updateHealth(s.health);
  document.getElementById('uptimeText').textContent = s.mode === 'off' ? '—' : ('运行 ' + fmtDur(s.uptimeSec));

  // 实时事件
  var body = document.getElementById('recentBody');
  if (!s.recent.length) { body.innerHTML = '<tr><td colspan="5" class="loading">暂无数据</td></tr>'; }
  else {
    body.innerHTML = s.recent.map(function(e) {
      var name = e.name && e.name.length > 28 ? e.name.slice(0,28) + '…' : (e.name || e.infohash.slice(0,12) + '…');
      return '<tr><td class="mono">' + fmtTime(e.ts) + '</td><td class="mono">' + esc(e.ip) + '</td><td title="' + esc(e.name) + '">' + esc(name) + '</td><td class="mono">' + fmtSize(e.size) + '</td><td><span class="src-badge src-' + e.source + '">' + e.source + '</span></td></tr>';
    }).join('');
  }

  // 系统 + 内存历史
  if (s.system) {
    document.getElementById('rss').textContent = fmtMB(s.system.rss);
    document.getElementById('heapUsed').textContent = fmtMB(s.system.heapUsed);
    document.getElementById('sysUptime').textContent = fmtDur(s.system.uptime);
    document.getElementById('nodeVer').textContent = s.system.nodeVersion;
    memHistory.push(s.system.rss);
    if (memHistory.length > 60) memHistory.shift();
    var mc = ensureMemChart();
    mc.data.labels = memHistory.map(function(_,i){ return i; });
    mc.data.datasets[0].data = memHistory;
    mc.update();
  }

  // IPv6 面板
  if (s.ipv6) {
    var v6 = s.ipv6;
    document.getElementById('v6Total').textContent = fmt(v6.peers6_total);
    document.getElementById('v4Total').textContent = fmt(v6.peers4_total);
    document.getElementById('v6_1h').textContent = fmt(v6.peers6_1h);
    document.getElementById('v6_24h').textContent = fmt(v6.peers6_24h);
    document.getElementById('ipv6Pct').textContent = v6.pct + '%';
    document.getElementById('ipv6Bar').style.width = Math.min(100, v6.pct) + '%';
  }
  document.getElementById('dhtV6Peers').textContent = fmt(s.dht.ipv6Peers || 0);
  document.getElementById('dhtNodes6').textContent = fmt(s.dht.nodes6 || 0);
  document.getElementById('dhtUtpPeers').textContent = fmt(s.dht.utpPeers || 0);

  // v2 面板
  if (s.meta && s.meta.versions) {
    var vv = s.meta.versions;
    document.getElementById('v1Count').textContent = fmt(vv.v1);
    document.getElementById('v2Count').textContent = fmt(vv.v2);
    document.getElementById('hybridCount').textContent = fmt(vv.hybrid);
    document.getElementById('pieceLayers').textContent = fmt(s.meta.withPieceLayers || 0);
    document.getElementById('fileTree').textContent = fmt(s.meta.withFileTree || 0);
    var v2Total = vv.v2 + vv.hybrid;
    var v2Rate = s.meta.total > 0 ? (v2Total * 100 / s.meta.total) : 0;
    document.getElementById('v2Pct').textContent = v2Rate.toFixed(1) + '%';
    document.getElementById('v2Bar').style.width = Math.min(100, v2Rate) + '%';
  }

  // 冷存储面板
  var cs = s.coldStorage;
  var csEl = document.getElementById('coldRunning');
  if (cs && cs.running) {
    csEl.textContent = '运行中';
    csEl.style.color = '#3fb950';
    document.getElementById('coldTotal').textContent = fmt(cs.total || 0);
    document.getElementById('coldSynced').textContent = fmt(cs.synced || 0);
    document.getElementById('coldPending').textContent = fmt(cs.pending || 0);
    var csRate = (cs.total && cs.total > 0) ? Math.round((cs.total - cs.pending) * 100 / cs.total) : 0;
    document.getElementById('coldRate').textContent = csRate + '%';
    document.getElementById('coldPath').textContent = cs.dbPath || '—';
    document.getElementById('coldLastSync').textContent = cs.lastSync ? fmtTime(cs.lastSync) : '—';
  } else {
    csEl.textContent = '未启动';
    csEl.style.color = '#f85149';
  }

  // Tracker 健康度面板
  var trk = s.tracker;
  if (trk) {
    document.getElementById('trkTotal').textContent = fmt(trk.total || 0);
    document.getElementById('trkAliveCount').textContent = fmt(trk.alive || 0);
    document.getElementById('trkDead').textContent = fmt(trk.dead || 0) + '/' + fmt(trk.unchecked || 0);
    document.getElementById('trkAvgLat').textContent = (trk.avgLatency || 0) + 'ms';
    document.getElementById('trkAlive').textContent = fmt(trk.alive || 0) + '/' + fmt(trk.total || 0);
    var trkRate = trk.total > 0 ? (trk.alive * 100 / trk.total) : 0;
    document.getElementById('trkBar').style.width = trkRate + '%';
    document.getElementById('trkChecking').textContent = trk.checking ? '全量健康检查进行中…' : ('共 ' + fmt(trk.sources||0) + ' 个列表源');
  }

  // 综合统计
  document.getElementById('ingestedCount').textContent = fmt(s.counters.ingested || 0);
  document.getElementById('newTorrents2').textContent = fmt(s.counters.newTorrents || 0);
  document.getElementById('dhtAnn').textContent = fmt(s.dht.announces || 0);
  document.getElementById('dhtSmp').textContent = fmt(s.dht.samples || 0);
  document.getElementById('crawlTrawl').textContent = fmt((s.crawler && s.crawler.trawlSamples) || 0);
  document.getElementById('crawlMerge').textContent = fmt((s.crawler && s.crawler.mergedPeers) || 0);
  document.getElementById('wsReg').textContent = fmt((s.webseed && s.webseed.registrySize) || 0);
  document.getElementById('wsReclass').textContent = fmt((s.webseed && s.webseed.reclassified) || 0);
  document.getElementById('dhtPorts').textContent = s.dht.running ? ('UDP ' + (s.dht.ports||[]).join(' / ')) : '—';
  if (s.geo && s.geo.providers) {
    document.getElementById('geoProviders').innerHTML = Object.keys(s.geo.providers).map(function(k) {
      var p = s.geo.providers[k];
      var dot = p.available ? '#3fb950' : '#f85149';
      return '<span class="badge-dot" style="background:' + dot + '"></span>' + k + ' <span style="color:#54626f">(✓' + p.ok + ' ✗' + p.fail + (p.available ? '' : ' 冷却' + p.cooldownSec + 's') + ')</span>';
    }).join(' · ');
  }
  if (s.metaSearch && s.metaSearch.providers) {
    document.getElementById('metaProviders').innerHTML = Object.keys(s.metaSearch.providers).map(function(k) {
      var p = s.metaSearch.providers[k];
      var dot = p.available ? '#3fb950' : '#f85149';
      return '<span class="badge-dot" style="background:' + dot + '"></span>' + k + (p.available ? '' : '<span style="color:#54626f"> 冷却' + p.cooldownSec + 's</span>');
    }).join(' · ');
  }
  if (s.sitePort) {
    var link = document.getElementById('siteLink');
    link.href = 'http://localhost:' + s.sitePort + '/';
  }
}

/* ---- 图表渲染（5s，独立端点） ---- */
function renderCharts(c) {
  document.getElementById('peakRate').textContent = fmt(c.peakRate);
  document.getElementById('avgRate').textContent = fmt(c.avgRate);

  var chart = ensureRateChart();
  var bucketMs = curMins > 360 ? 3600000 : 60000;
  var labels = c.perMinuteBySource.map(function(b){
    var d = new Date(b.t);
    if (bucketMs >= 3600000) {
      var mm = String(d.getMonth()+1).padStart(2,'0');
      var dd = String(d.getDate()).padStart(2,'0');
      var hh = String(d.getHours()).padStart(2,'0');
      return mm + '/' + dd + ' ' + hh + ':00';
    }
    return d.toTimeString().slice(0,5);
  });
  chart.data.labels = labels;
  SRC_DEFS.forEach(function(sd, i) {
    chart.data.datasets[i].data = c.perMinuteBySource.map(function(b){ return b[sd.key] || 0; });
  });
  chart.update();

  // 来源分布
  var srcTotal = c.sources.reduce(function(a,b){ return a+b.c; }, 0);
  document.getElementById('srcTotal').textContent = '共 ' + fmt(srcTotal);
  var srcHtml = c.sources.map(function(x) {
    var pct = srcTotal > 0 ? (x.c * 100 / srcTotal).toFixed(1) : '0';
    var def = SRC_DEFS.find(function(d){ return d.key === x.source; }) || { color: '#c9cbcf', label: x.source };
    return '<div style="margin-bottom:7px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px"><span><span class="src-badge src-' + x.source + '">' + def.label + '</span></span><span>' + fmt(x.c) + ' <span style="color:#54626f">(' + pct + '%)</span></span></div><div class="bar" style="width:' + Math.max(2, pct) + '%;background:' + def.color + ';min-width:8px"></div></div>';
  }).join('');
  document.getElementById('sourceList').innerHTML = srcHtml || '<div class="loading">暂无数据</div>';

  // Top 国家扇形图
  var cc = c.topCountries || [];
  var ccChartInst = ensureCcChart();
  ccChartInst.data.labels = cc.map(function(x){ return x.cc || '?'; });
  ccChartInst.data.datasets[0].data = cc.map(function(x){ return x.c; });
  ccChartInst.update();
  var ccTotal = cc.reduce(function(a,b){ return a+b.c; }, 0);
  document.getElementById('ccTotal').textContent = '共 ' + fmt(ccTotal);
  document.getElementById('ccLegend').innerHTML = cc.map(function(x, i) {
    var pct = ccTotal > 0 ? (x.c*100/ccTotal).toFixed(1) : '0';
    return '<span style="display:inline-block;margin-right:10px"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + CC_COLORS[i % CC_COLORS.length] + ';margin-right:3px"></i>' + esc(x.cc||'?') + ' ' + pct + '%</span>';
  }).join('') || '<span style="color:#54626f">暂无数据</span>';
}

/* ---- Tracker 全量渲染（10s，独立端点；保留滚动位置 + 支持过滤） ---- */
function renderTrackers() {
  var body = document.getElementById('trkListBody');
  var countEl = document.getElementById('trkListCount');
  var filtered = trkCache;
  if (trkFilterText) {
    var f = trkFilterText.toLowerCase();
    filtered = trkCache.filter(function(t){ return t.url.toLowerCase().indexOf(f) >= 0; });
  }
  var aliveN = trkCache.filter(function(t){ return t.alive === true; }).length;
  countEl.textContent = trkCache.length ? ('共 ' + fmt(trkCache.length) + ' 条 · 存活 ' + fmt(aliveN) + (trkFilterText ? ' · 过滤 ' + filtered.length : '')) : '';
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="5" class="loading">' + (trkCache.length ? '无匹配' : '未启动 TrackerManager') + '</td></tr>';
    return;
  }
  // 保留滚动位置（更新 innerHTML 后恢复），用户可滚轮查看全部
  var scrollEl = document.getElementById('trkScroll');
  var st = scrollEl.scrollTop;
  body.innerHTML = filtered.map(function(t) {
    var st2 = t.alive === true ? '<span style="color:#3fb950">● 存活</span>'
      : t.alive === false ? '<span style="color:#f85149">● 死亡</span>'
      : '<span style="color:#7d8a99">○ 未检</span>';
    var lat = t.latency > 0 ? (t.latency + 'ms') : '—';
    return '<tr><td class="mono" style="word-break:break-all">' + esc(t.url) + '</td><td style="white-space:nowrap">' + st2 + '</td><td class="mono">' + lat + '</td><td class="mono">' + (t.fails||0) + '</td><td class="mono">' + fmtAgo(t.lastCheck) + '</td></tr>';
  }).join('');
  scrollEl.scrollTop = st;
}

function renderNodes(d) {
  var body = document.getElementById('nodesBody');
  document.getElementById('nodeCount').textContent = d.nodes.length ? ('(' + fmt(d.nodes.length) + ')') : '';
  if (!d.nodes.length) { body.innerHTML = '<tr><td colspan="4" class="loading">DHT 未运行</td></tr>'; return; }
  body.innerHTML = d.nodes.map(function(n) {
    return '<tr><td class="mono">' + n.id + '</td><td class="mono">' + n.address + '</td><td>' + (n.family === 'ipv6' ? 'v6' : 'v4') + '</td><td>' + n.ageSec + 's</td></tr>';
  }).join('');
}

/* ---- 分步加载调度：轻量高频 / 重量低频，互不阻塞防卡死 ---- */
function refreshStats() {
  fetch('/api/stats').then(function(r){return r.json();}).then(renderStats).catch(function(){});
}
function refreshCharts() {
  fetch('/api/charts?mins=' + curMins).then(function(r){return r.json();}).then(renderCharts).catch(function(){});
}
function refreshTrackers() {
  fetch('/api/trackers').then(function(r){return r.json();}).then(function(d){
    trkCache = d.list || [];
    renderTrackers();
  }).catch(function(){});
}
function refreshNodes() {
  fetch('/api/nodes').then(function(r){return r.json();}).then(renderNodes).catch(function(){});
}

document.addEventListener('click', function(e) {
  if (e.target.classList && e.target.classList.contains('tw-btn')) {
    document.querySelectorAll('.tw-btn').forEach(function(b){ b.classList.remove('active'); });
    e.target.classList.add('active');
    curMins = parseInt(e.target.getAttribute('data-mins'), 10);
    refreshCharts();
  }
});
document.getElementById('trkFilter').addEventListener('input', function(e) {
  trkFilterText = e.target.value || '';
  renderTrackers();
});

/* 分步首屏加载：stats(0ms) → charts(300ms) → trackers(800ms) → nodes(1500ms)
   之后各自独立轮询，大负荷请求与主流程脱离 */
refreshStats();
setTimeout(refreshCharts, 300);
setTimeout(refreshTrackers, 800);
setTimeout(refreshNodes, 1500);
setInterval(refreshStats, 2000);
setInterval(refreshCharts, 5000);
setInterval(refreshTrackers, 10000);
setInterval(refreshNodes, 10000);
</script>
</body>
</html>`;
}

let _server = null;

function start(port) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[monitor]', e);
      try { res.writeHead(500); res.end('Internal error'); } catch (_) {}
    });
  });
  server.listen(port, () => {
    console.log(`[monitor] 监控 WebUI: http://localhost:${port}/`);
  });
  _server = server;
  return server;
}

function stop() {
  if (_server) { try { _server.close(); } catch (_) {} _server = null; }
}

module.exports = { start, stop, init };
