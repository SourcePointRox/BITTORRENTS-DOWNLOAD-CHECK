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
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(obj));
}

/* 读取 POST 请求体 */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
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
      healthProgress: s.tracker.healthProgress || null,
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
    // dashboard.js 禁止缓存：避免浏览器使用旧版 Vue 应用（修复后立即生效）
    const cacheCtrl = pathname.endsWith('/dashboard.js')
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cacheCtrl });
    return fs.createReadStream(file).pipe(res);
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
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
  // 手动添加 tracker（POST /api/trackers/add，body: { trackers: "url1\nurl2,..." }）
  if (pathname === '/api/trackers/add' && req.method === 'POST') {
    if (!collectorRef || !collectorRef.trackerMgr) return json(res, 503, { error: 'tracker manager not running' });
    const body = await readBody(req);
    let input = '';
    try { input = JSON.parse(body).trackers || ''; } catch (_) { input = body; }
    const result = collectorRef.trackerMgr.addTrackers(input);
    return json(res, 200, result);
  }
  // 手动删除 tracker（POST /api/trackers/remove，body: { url: "..." }）
  if (pathname === '/api/trackers/remove' && req.method === 'POST') {
    if (!collectorRef || !collectorRef.trackerMgr) return json(res, 503, { error: 'tracker manager not running' });
    const body = await readBody(req);
    let url = '';
    try { url = JSON.parse(body).url || ''; } catch (_) { url = body; }
    const ok = collectorRef.trackerMgr.removeTracker(url);
    return json(res, 200, { removed: ok });
  }
  // 手动检查指定 tracker 健康状态（POST /api/trackers/check，body: { urls: "url1\nurl2" | ["url1","url2"] }）
  if (pathname === '/api/trackers/check' && req.method === 'POST') {
    if (!collectorRef || !collectorRef.trackerMgr) return json(res, 503, { error: 'tracker manager not running' });
    const body = await readBody(req);
    let urls;
    try { urls = JSON.parse(body).urls; } catch (_) { urls = body; }
    if (typeof urls === 'string') urls = urls.split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(urls) || !urls.length) return json(res, 400, { error: 'urls required' });
    try {
      const results = await collectorRef.trackerMgr.checkTrackers(urls);
      return json(res, 200, { results });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  // 从 URL 拉取 tracker 列表并添加（POST /api/trackers/fetch-url，body: { url: "https://..." }）
  if (pathname === '/api/trackers/fetch-url' && req.method === 'POST') {
    if (!collectorRef || !collectorRef.trackerMgr) return json(res, 503, { error: 'tracker manager not running' });
    const body = await readBody(req);
    let srcUrl = '';
    try { srcUrl = JSON.parse(body).url || ''; } catch (_) { srcUrl = body; }
    if (!srcUrl || !/^https?:\/\//i.test(srcUrl)) return json(res, 400, { error: 'valid url required' });
    try {
      const result = await collectorRef.trackerMgr.fetchFromUrl(srcUrl);
      return json(res, 200, result);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (pathname === '/api/nodes') {
    if (!collectorRef) return json(res, 503, { error: 'collector not initialized' });
    return json(res, 200, collectorRef.getNodes());
  }
  // 采集器控制（启动/停止 sim/live 模式）—— 前端按钮调用
  if (pathname === '/api/collector' && req.method === 'POST') {
    if (!collectorRef) return json(res, 503, { error: 'collector not initialized' });
    const body = await readBody(req);
    let action = '';
    try { action = JSON.parse(body).action; } catch (_) { action = body; }
    let result;
    try {
      if (action === 'start-sim') result = collectorRef.startSim();
      else if (action === 'start-live') result = collectorRef.startLive({ tracker: true, pex: true });
      else if (action === 'stop') result = collectorRef.stop();
      else return json(res, 400, { error: 'INVALID_ACTION', message: 'action must be start-sim | start-live | stop' });
      // 返回最新统计供前端立即刷新
      result = { ...result, ...lightStats() };
    } catch (e) { return json(res, 500, { error: e.message }); }
    return json(res, 200, result);
  }
  // 批量注入事件（sim 模式压力测试）
  if (pathname === '/api/burst' && req.method === 'POST') {
    if (!collectorRef) return json(res, 503, { error: 'collector not initialized' });
    const body = await readBody(req);
    let count = 100;
    try { count = Math.min(Math.max(parseInt(JSON.parse(body).count, 10) || 100, 1), 100000); } catch (_) {}
    return json(res, 200, collectorRef.burst(count));
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
<script src="/assets/js/chart.umd.min.js"></script>
<script src="/assets/js/vue.global.js"></script>
<script src="/assets/js/tailwind.js"></script>
<script>
  /* TailwindCSS 暗色主题配置 */
  tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        colors: {
          'bg-base': '#0a0e14',
          'bg-card': '#161d27',
          'bg-input': '#0f1419',
          'border-base': '#232c38',
          'border-hover': '#2d3a4a',
          'text-primary': '#c9d1d9',
          'text-secondary': '#7d8a99',
          'text-muted': '#54626f',
          'accent-green': '#238636',
          'accent-green-light': '#3fb950',
          'accent-blue': '#58a6ff',
          'accent-yellow': '#d29922',
          'accent-red': '#f85149',
        },
        fontFamily: {
          mono: ['Consolas', 'monospace'],
          sans: ['Segoe UI', 'Consolas', 'monospace'],
        },
      }
    }
  };
</script>
<style>
  body { background: #0a0e14; color: #c9d1d9; font-family: 'Segoe UI', 'Consolas', monospace; min-height: 100vh; font-size: 13px; }
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
  .fade-in { animation: fadeIn 0.4s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-thumb { background: #2d3a4a; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #3d4a5a; }
</style>
</head>
<body>
<div id="app"></div>
<script src="/assets/js/dashboard.js"></script>
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
