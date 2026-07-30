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
<script src="/assets/js/chart.umd.min.js"></script>
<script src="/assets/js/vue.global.prod.js"></script>
<script src="/assets/js/tailwind.js"></script>
<script>
  /* TailwindCSS 暗色主题配置 */
  tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        colors: {
          // 暗色主题色板（与原外观完全一致）
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

<script>
const { createApp, ref, reactive, computed, onMounted, nextTick } = Vue;

/* 常量 */
const CC_COLORS = ['#36a2eb','#ff6384','#ff9f40','#4bc0c0','#9966ff','#ffcd56','#3fb950','#58a6ff','#d29922','#c9cbcf'];
const SRC_DEFS = [
  { key: 'dht_passive', label: 'DHT被动', color: '#9966ff' },
  { key: 'dht_active', label: 'DHT主动', color: '#4bc0c0' },
  { key: 'dht_sample', label: 'DHT采样', color: '#36a2eb' },
  { key: 'dht_getpeers', label: 'DHT查询', color: '#ff7dd1' },
  { key: 'tracker', label: 'Tracker', color: '#ff9f40' },
  { key: 'pex', label: 'PEX', color: '#ff6384' },
  { key: 'swarm_merge', label: 'Swarm合并', color: '#7de8ff' },
  { key: 'simulator', label: '模拟', color: '#a0a0a0' }
];
const TIME_WINDOWS = [15, 60, 180, 360, 720, 1440];
const TIME_LABELS = { 15:'15m', 60:'1h', 180:'3h', 360:'6h', 720:'12h', 1440:'24h' };

/* 格式化工具 */
function fmt(n) { return (n||0).toLocaleString('en-US'); }
function fmtMB(b) { return (b/1048576).toFixed(1) + ' MB'; }
function fmtSize(b) { if (!b||b<=0) return '—'; if (b<1024) return b+'B'; if (b<1048576) return (b/1024).toFixed(1)+'KB'; if (b<1073741824) return (b/1048576).toFixed(1)+'MB'; return (b/1073741824).toFixed(2)+'GB'; }
function fmtTime(ts) { return new Date(ts).toTimeString().slice(0,8); }
function fmtAgo(ts) { if (!ts) return '—'; var s = Math.floor((Date.now()-ts)/1000); if (s<60) return s+'s前'; if (s<3600) return Math.floor(s/60)+'m前'; return Math.floor(s/3600)+'h前'; }
function fmtDur(s) { if (s<60) return s+'s'; if (s<3600) return Math.floor(s/60)+'m'+s%60+'s'; return Math.floor(s/3600)+'h'+Math.floor((s%3600)/60)+'m'; }
function esc(s) { return String(s==null?'':s); }

const App = {
  setup() {
    /* 响应式状态 */
    const stats = ref({ mode:'off', db:{torrents:0,peers:0,observations:0,obsLog:0}, todayEvents:0, ratePerMin:0, uptimeSec:0,
      dht:{running:false,nodes:0,rx:0,tx:0,peers:0,announces:0,samples:0,ipv6Peers:0,nodes6:0,utpPeers:0,instances:1,hasV6:false,ports:[]},
      counters:{ingested:0,newTorrents:0,metaResolved:0,metaFailed:0,metaEnriched:0,trackerPeers:0,pexPeers:0},
      meta:{total:0,withName:0,withSize:0,withMeta:0,versions:{v1:0,v2:0,hybrid:0}},
      metaQueue:0, metaSuccessRate:0,
      ipv6:{peers6_total:0,peers4_total:0,peers6_1h:0,peers6_24h:0,pct:0},
      coldStorage:null, tracker:null, recent:[], system:{rss:0,heapUsed:0,uptime:0,nodeVersion:''}, health:0, sitePort:null });
    const charts = ref({ peakRate:0, avgRate:0, perMinuteBySource:[], sources:[], topCountries:[] });
    const trkList = ref([]);
    const trkFilter = ref('');
    const curMins = ref(60);
    const nodes = ref([]);
    const showAddModal = ref(false);
    const trkInput = ref('');
    const addResult = ref(null);
    const memHistory = ref([]);
    let rateChart = null, ccChart = null, memChart = null;

    /* 计算属性 */
    const healthClass = computed(() => stats.value.health >= 70 ? 'health-good' : stats.value.health >= 30 ? 'health-warn' : 'health-bad');
    const healthText = computed(() => stats.value.health >= 70 ? '健康' : stats.value.health >= 30 ? '警告' : '异常');
    const filteredTrackers = computed(() => {
      if (!trkFilter.value) return trkList.value;
      const f = trkFilter.value.toLowerCase();
      return trkList.value.filter(t => t.url.toLowerCase().includes(f));
    });
    const trkAliveCount = computed(() => trkList.value.filter(t => t.alive === true).length);
    const srcTotal = computed(() => charts.value.sources.reduce((a,b) => a+b.c, 0));
    const ccTotal = computed(() => charts.value.topCountries.reduce((a,b) => a+b.c, 0));
    const sizeRate = computed(() => stats.value.meta.total > 0 ? Math.round(stats.value.meta.withSize * 100 / stats.value.meta.total) : 0);
    const v2Rate = computed(() => {
      const v = stats.value.meta.versions || {};
      const total = stats.value.meta.total || 0;
      return total > 0 ? ((v.v2||0) + (v.hybrid||0)) * 100 / total : 0;
    });
    const coldRate = computed(() => {
      const cs = stats.value.coldStorage;
      if (!cs || !cs.total) return 0;
      return Math.round((cs.total - cs.pending) * 100 / cs.total);
    });
    const trkRate = computed(() => {
      const t = stats.value.tracker;
      return t && t.total > 0 ? (t.alive * 100 / t.total) : 0;
    });

    /* 图表初始化 */
    function ensureRateChart() {
      if (rateChart) return rateChart;
      const el = document.getElementById('rateChart');
      if (!el) return null;
      rateChart = new Chart(el.getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: SRC_DEFS.map(s => ({ label: s.label, data: [], borderColor: s.color, backgroundColor: s.color+'33', fill: true, pointRadius: 0, borderWidth: 1.2, lineTension: 0.35 })) },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } }, animation: { duration: 400, easing: 'easeOutQuart' }, scales: { x: { ticks: { color: '#7d8a99', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: '#1c2530' } }, y: { stacked: true, ticks: { color: '#7d8a99', beginAtZero: true, font: { size: 10 } }, grid: { color: '#1c2530' } } } }
      });
      return rateChart;
    }
    function ensureCcChart() {
      if (ccChart) return ccChart;
      const el = document.getElementById('ccChart');
      if (!el) return null;
      ccChart = new Chart(el.getContext('2d'), {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], backgroundColor: CC_COLORS, borderColor: '#161d27', borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '58%', plugins: { legend: { display: true, position: 'right', labels: { color: '#c9d1d9', font: { size: 10 }, boxWidth: 10, padding: 6 } }, tooltip: { callbacks: { label: function(item) { const total = item.dataset.data.reduce((a,b)=>a+b,0)||1; return ' ' + item.label + ': ' + fmt(item.raw) + ' (' + (item.raw*100/total).toFixed(1) + '%)'; } } } }, animation: { duration: 500 } }
      });
      return ccChart;
    }
    function ensureMemChart() {
      if (memChart) return memChart;
      const el = document.getElementById('memChart');
      if (!el) return null;
      memChart = new Chart(el.getContext('2d'), {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: '#d29922', backgroundColor: 'rgba(210,153,34,0.15)', fill: true, pointRadius: 0, borderWidth: 1 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, animation: { duration: 400 }, scales: { x: { display: false }, y: { ticks: { color: '#7d8a99', font: { size: 9 }, callback: v => (v/1048576).toFixed(0)+'M' }, grid: { color: '#1c2530' } } } }
      });
      return memChart;
    }

    /* 数据更新 */
    function applyStats(s) {
      if (!s || typeof s.mode === 'undefined') return;
      stats.value = s;
      if (s.system) {
        memHistory.value.push(s.system.rss);
        if (memHistory.value.length > 60) memHistory.value.shift();
        nextTick(() => {
          const mc = ensureMemChart();
          if (mc) { mc.data.labels = memHistory.value.map((_,i)=>i); mc.data.datasets[0].data = memHistory.value; mc.update(); }
        });
      }
      nextTick(() => {
        const c = ensureRateChart();
        if (c && charts.value.perMinuteBySource.length) updateRateChart(c);
      });
    }
    function updateRateChart(c) {
      const bucketMs = curMins.value > 360 ? 3600000 : 60000;
      c.data.labels = charts.value.perMinuteBySource.map(b => {
        const d = new Date(b.t);
        if (bucketMs >= 3600000) { const mm=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0'),hh=String(d.getHours()).padStart(2,'0'); return mm+'/'+dd+' '+hh+':00'; }
        return d.toTimeString().slice(0,5);
      });
      SRC_DEFS.forEach((sd, i) => { c.data.datasets[i].data = charts.value.perMinuteBySource.map(b => b[sd.key] || 0); });
      c.update();
    }
    function applyCharts(c) {
      if (!c || !Array.isArray(c.perMinuteBySource)) return;
      charts.value = c;
      nextTick(() => { const rc = ensureRateChart(); if (rc) updateRateChart(rc);
        const cc = ensureCcChart();
        if (cc) { cc.data.labels = c.topCountries.map(x => x.cc || '?'); cc.data.datasets[0].data = c.topCountries.map(x => x.c); cc.update(); }
      });
    }
    function srcDef(key) { return SRC_DEFS.find(d => d.key === key) || { color: '#c9cbcf', label: key }; }
    function srcPct(x) { return srcTotal.value > 0 ? (x.c * 100 / srcTotal.value).toFixed(1) : '0'; }
    function ccPct(x) { return ccTotal.value > 0 ? (x.c*100/ccTotal.value).toFixed(1) : '0'; }
    function ccColor(i) { return CC_COLORS[i % CC_COLORS.length]; }

    /* 添加 Tracker */
    function openAddModal() { showAddModal.value = true; }
    function closeAddModal() { showAddModal.value = false; }
    function submitAddTrackers() {
      if (!trkInput.value.trim()) return;
      addResult.value = { loading: true };
      fetch('/api/trackers/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackers: trkInput.value }) })
        .then(r => r.json()).then(d => {
          addResult.value = d;
          if (d.added > 0) setTimeout(() => { refreshTrackers(); showAddModal.value = false; trkInput.value = ''; addResult.value = null; }, 2000);
        }).catch(e => { addResult.value = { error: e.message }; });
    }

    /* 轮询 */
    function refreshStats() { fetch('/api/stats').then(r=>r.ok?r.json():null).then(d=>{ if(d) applyStats(d); }).catch(()=>{}); }
    function refreshCharts() { fetch('/api/charts?mins=' + curMins.value).then(r=>r.ok?r.json():null).then(d=>{ if(d) applyCharts(d); }).catch(()=>{}); }
    function refreshTrackers() { fetch('/api/trackers').then(r=>r.ok?r.json():null).then(d => { if(d && Array.isArray(d.list)) trkList.value = d.list; }).catch(()=>{}); }
    function refreshNodes() { fetch('/api/nodes').then(r=>r.ok?r.json():null).then(d => { if(d && Array.isArray(d.nodes)) nodes.value = d.nodes; }).catch(()=>{}); }
    function setMins(m) { curMins.value = m; refreshCharts(); }

    onMounted(() => {
      /* 提前初始化图表（确保 canvas 存在后立即创建 Chart 实例，不等待数据） */
      setTimeout(() => { ensureRateChart(); ensureCcChart(); ensureMemChart(); }, 50);
      refreshStats();
      setTimeout(refreshCharts, 300);
      setTimeout(refreshTrackers, 800);
      setTimeout(refreshNodes, 1500);
      setInterval(refreshStats, 2000);
      setInterval(refreshCharts, 5000);
      setInterval(refreshTrackers, 10000);
      setInterval(refreshNodes, 10000);
    });

    return { stats, charts, trkList, trkFilter, curMins, nodes, showAddModal, trkInput, addResult, memHistory,
      healthClass, healthText, filteredTrackers, trkAliveCount, srcTotal, ccTotal, sizeRate, v2Rate, coldRate, trkRate,
      TIME_WINDOWS, TIME_LABELS, SRC_DEFS,
      fmt, fmtMB, fmtSize, fmtTime, fmtAgo, fmtDur, esc, srcDef, srcPct, ccPct, ccColor,
      setMins, submitAddTrackers, openAddModal, closeAddModal };
  },
  template: '<div class="fade-in">' +
    '<div style="background:linear-gradient(135deg,#161d27 0%,#0f1419 100%);border-bottom:2px solid #238636;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:0 2px 12px rgba(0,0,0,0.5)">' +
      '<h1 style="font-size:18px;color:#58a6ff;display:flex;align-items:center;gap:10px"><span style="width:26px;height:26px;background:linear-gradient(135deg,#238636,#2ea043);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;box-shadow:0 0 10px rgba(35,134,54,0.6)">B</span>BITTORRENTS 网络监控中心</h1>' +
      '<div style="display:flex;gap:14px;align-items:center;font-size:12px"><span :class="\'health-badge \' + healthClass" style="padding:3px 12px;border-radius:16px;font-weight:600;font-size:11px">{{ healthText }}</span><span style="color:#7d8a99">{{ stats.mode === \'off\' ? \'—\' : \'运行 \' + fmtDur(stats.uptimeSec) }}</span><a :href="\'http://localhost:\' + (stats.sitePort||8080) + \'/\'" target="_blank" style="font-size:11px;color:#58a6ff">主站点 →</a></div>' +
    '</div>' +
    '<div style="max-width:1680px;margin:0 auto;padding:14px">' +
      '<div style="display:grid;gap:12px;grid-template-columns:repeat(8,minmax(0,1fr))">' +
        '<div class="card"><div class="card-title">采集模式</div><div style="font-size:18px;font-weight:700;color:#fff">{{ stats.mode.toUpperCase() }}</div><div style="font-size:11px;color:#54626f;margin-top:3px">{{ stats.mode === \'off\' ? \'stopped\' : \'run \' + fmtDur(stats.uptimeSec) }}</div></div>' +
        '<div class="card"><div class="card-title">种子总数</div><div style="font-size:24px;font-weight:700;color:#fff">{{ fmt(stats.db.torrents) }}</div><div style="font-size:11px;color:#54626f;margin-top:3px">新增 {{ fmt(stats.counters.newTorrents) }}</div></div>' +
        '<div class="card"><div class="card-title">IP 节点</div><div style="font-size:24px;font-weight:700;color:#fff">{{ fmt(stats.db.peers) }}</div><div style="font-size:11px;color:#54626f;margin-top:3px">今日 {{ fmt(stats.todayEvents) }}</div></div>' +
        '<div class="card"><div class="card-title">当前速率</div><div style="font-size:24px;font-weight:700;color:#fff">{{ fmt(stats.ratePerMin) }}<span style="font-size:12px;color:#7d8a99">/min</span></div><div style="font-size:11px;color:#54626f;margin-top:3px">峰值 {{ fmt(charts.peakRate) }} · 均值 {{ fmt(charts.avgRate) }}</div></div>' +
        '<div class="card"><div class="card-title">DHT 节点</div><div style="font-size:24px;font-weight:700;color:#fff">{{ stats.dht.running ? fmt(stats.dht.nodes) : \'—\' }}</div><div style="font-size:11px;color:#54626f;margin-top:3px">{{ stats.dht.running ? (stats.dht.instances + \' 实例 · rx \' + fmt(stats.dht.rx) + \' / tx \' + fmt(stats.dht.tx)) : \'未运行\' }}</div></div>' +
        '<div class="card"><div class="card-title">元数据成功率</div><div style="font-size:24px;font-weight:700;color:#fff">{{ stats.metaSuccessRate }}%</div><div style="font-size:11px;color:#54626f;margin-top:3px">解析 {{ fmt(stats.counters.metaResolved) }} / 失败 {{ fmt(stats.counters.metaFailed) }}</div></div>' +
        '<div class="card"><div class="card-title">累计事件</div><div style="font-size:20px;font-weight:700;color:#fff">{{ fmt(stats.db.obsLog) }}</div><div style="font-size:11px;color:#54626f;margin-top:3px">观测 {{ fmt(stats.db.observations) }} · 日志 {{ fmt(stats.db.obsLog) }}</div></div>' +
        '<div class="card"><div class="card-title">健康度</div><div style="font-size:24px;font-weight:700;color:#fff">{{ stats.health }}</div><div style="width:100%;height:5px;background:#232c38;border-radius:3px;overflow:hidden;margin-top:6px"><div style="height:100%;background:linear-gradient(90deg,#238636,#3fb950);transition:width 0.6s" :style="{ width: stats.health + \'%\' }"></div></div></div>' +
      '</div>' +
      '<div style="display:grid;gap:12px;grid-template-columns:minmax(0,2fr) minmax(0,1fr);margin-top:12px">' +
        '<div class="card"><div class="card-title"><span>采集趋势 · 多来源堆叠</span><span style="display:flex;gap:4px"><button data-mins="15" @click="setMins(15)" :class="curMins===15 ? \'tw-active\' : \'tw-inactive\'" class="tw-btn">15m</button><button data-mins="60" @click="setMins(60)" :class="curMins===60 ? \'tw-active\' : \'tw-inactive\'" class="tw-btn">1h</button><button data-mins="180" @click="setMins(180)" :class="curMins===180 ? \'tw-active\' : \'tw-inactive\'" class="tw-btn">3h</button><button data-mins="360" @click="setMins(360)" :class="curMins===360 ? \'tw-active\' : \'tw-inactive\'" class="tw-btn">6h</button><button data-mins="720" @click="setMins(720)" :class="curMins===720 ? \'tw-active\' : \'tw-inactive\'" class="tw-btn">12h</button><button data-mins="1440" @click="setMins(1440)" :class="curMins===1440 ? \'tw-active\' : \'tw-inactive\'" class="tw-btn">24h</button></span></div><div style="position:relative;height:240px;margin-top:6px"><canvas id="rateChart"></canvas></div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;font-size:11px"><span v-for="s in SRC_DEFS" :key="s.key" style="display:flex;align-items:center;gap:4px"><i :style="{ background: s.color, width: \'10px\', height: \'10px\', borderRadius: \'2px\', display: \'inline-block\' }"></i>{{ s.label }}</span></div></div>' +
        '<div class="card"><div class="card-title"><span>Top 国家分布（近 24h）</span><span style="color:#54626f">共 {{ fmt(ccTotal) }}</span></div><div style="position:relative;height:210px"><canvas id="ccChart"></canvas></div><div style="margin-top:8px;font-size:11px"><span v-for="(x,i) in charts.topCountries" :key="i" style="display:inline-block;margin-right:10px"><i :style="{ background: ccColor(i), width:\'8px\',height:\'8px\',borderRadius:\'2px\',display:\'inline-block\',marginRight:\'3px\' }"></i>{{ x.cc || \'?\' }} {{ ccPct(x) }}%</span></div></div>' +
      '</div>' +
      '<div style="display:grid;gap:12px;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:12px">' +
        '<div class="card"><div class="card-title"><span>来源分布（近 1h）</span><span style="color:#54626f">共 {{ fmt(srcTotal) }}</span></div><div style="margin-top:8px"><div v-if="!charts.sources.length" style="color:#54626f;text-align:center;padding:20px;font-size:12px">暂无数据</div><div v-for="x in charts.sources" :key="x.source" style="margin-bottom:7px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px"><span><span :class="\'src-badge src-\' + x.source">{{ srcDef(x.source).label }}</span></span><span>{{ fmt(x.c) }} <span style="color:#54626f">({{ srcPct(x) }}%)</span></span></div><div style="display:inline-block;height:14px;border-radius:2px;transition:width 0.6s" :style="{ width: Math.max(2, srcPct(x)) + \'%\', background: srcDef(x.source).color, minWidth: \'8px\' }"></div></div></div></div>' +
        '<div class="card"><div class="card-title">采集器状态</div><div style="margin-top:8px;display:flex;flex-direction:column;gap:6px"><div><span :class="stats.dht.running ? \'pulse pulse-on\' : \'pulse pulse-off\'"></span>DHT {{ stats.dht.running ? \'集群运行中 ×\' + (stats.dht.instances||1) + (stats.dht.hasV6 ? \' (v4+v6)\' : \' (v4)\') : \'未运行\' }}</div><div><span :class="stats.mode===\'live\' ? \'pulse pulse-on\' : \'pulse pulse-off\'"></span>Tracker {{ stats.mode===\'live\' ? \'运行中\' : \'未运行\' }}</div><div><span :class="stats.mode===\'live\' ? \'pulse pulse-on\' : \'pulse pulse-off\'"></span>PEX {{ stats.mode===\'live\' ? \'运行中\' : \'未运行\' }}</div><div><span :class="(stats.mode===\'live\') ? \'pulse pulse-on\' : \'pulse pulse-off\'"></span>爬虫聚合 {{ (stats.mode===\'live\') ? \'运行中\' : \'未运行\' }}</div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px"><div class="mini-stat"><div class="l">DHT rx/tx</div><div class="v">{{ fmt(stats.dht.rx) }} / {{ fmt(stats.dht.tx) }}</div></div><div class="mini-stat"><div class="l">DHT peers</div><div class="v">{{ fmt(stats.dht.peers) }}</div></div><div class="mini-stat"><div class="l">Tracker peers</div><div class="v">{{ fmt(stats.counters.trackerPeers||0) }}</div></div><div class="mini-stat"><div class="l">PEX peers</div><div class="v">{{ fmt(stats.counters.pexPeers||0) }}</div></div></div></div>' +
        '<div class="card"><div class="card-title">元数据解析进度</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><div class="mini-stat"><div class="l">种子总数</div><div class="v">{{ fmt(stats.meta.total) }}</div></div><div class="mini-stat"><div class="l">已解析名</div><div class="v">{{ fmt(stats.meta.withName) }}</div></div><div class="mini-stat"><div class="l">已解析 size</div><div class="v">{{ fmt(stats.meta.withSize) }}</div></div><div class="mini-stat"><div class="l">聚合补全</div><div class="v" style="color:#d29922">{{ fmt(stats.counters.metaEnriched||0) }}</div></div></div><div style="margin-top:8px"><div style="font-size:10px;color:#54626f">size 落库率</div><div style="width:100%;height:5px;background:#232c38;border-radius:3px;overflow:hidden;margin-top:6px"><div style="height:100%;background:linear-gradient(90deg,#238636,#3fb950);transition:width 0.6s" :style="{ width: sizeRate + \'%\' }"></div></div></div><div style="margin-top:6px;font-size:11px;color:#54626f">队列 {{ fmt(stats.metaQueue) }} · 元数据 OK {{ fmt(stats.meta.withMeta) }}</div></div>' +
      '</div>' +
      '<div style="display:grid;gap:12px;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:12px">' +
        '<div class="card"><div class="card-title"><span>IPv6 采集统计</span><span style="color:#3fb950;font-weight:600">{{ stats.ipv6.pct }}%</span></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><div class="mini-stat"><div class="l">v6 peer 总数</div><div class="v">{{ fmt(stats.ipv6.peers6_total) }}</div></div><div class="mini-stat"><div class="l">v4 peer 总数</div><div class="v">{{ fmt(stats.ipv6.peers4_total) }}</div></div><div class="mini-stat"><div class="l">v6 (1h)</div><div class="v">{{ fmt(stats.ipv6.peers6_1h) }}</div></div><div class="mini-stat"><div class="l">v6 (24h)</div><div class="v">{{ fmt(stats.ipv6.peers6_24h) }}</div></div></div><div style="margin-top:8px"><div style="font-size:10px;color:#54626f">IPv6 占比</div><div style="width:100%;height:5px;background:#232c38;border-radius:3px;overflow:hidden;margin-top:6px"><div style="height:100%;background:linear-gradient(90deg,#1f6feb,#58a6ff);transition:width 0.6s" :style="{ width: Math.min(100, stats.ipv6.pct) + \'%\' }"></div></div></div><div style="margin-top:6px;font-size:11px;color:#54626f">DHT 直接捕获 <span style="color:#58a6ff">{{ fmt(stats.dht.ipv6Peers||0) }}</span> · v6 路由 <span style="color:#58a6ff">{{ fmt(stats.dht.nodes6||0) }}</span> · uTP <span style="color:#d29922">{{ fmt(stats.dht.utpPeers||0) }}</span></div></div>' +
        '<div class="card"><div class="card-title"><span>Info Hash v2 (BEP-52)</span><span style="color:#d29922;font-weight:600">{{ v2Rate.toFixed(1) }}%</span></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><div class="mini-stat"><div class="l">v1 种子</div><div class="v">{{ fmt(stats.meta.versions.v1) }}</div></div><div class="mini-stat"><div class="l">v2 种子</div><div class="v" style="color:#d29922">{{ fmt(stats.meta.versions.v2) }}</div></div><div class="mini-stat"><div class="l">hybrid 种子</div><div class="v" style="color:#d29922">{{ fmt(stats.meta.versions.hybrid) }}</div></div><div class="mini-stat"><div class="l">piece layers</div><div class="v">{{ fmt(stats.meta.withPieceLayers||0) }}</div></div></div><div style="margin-top:8px"><div style="font-size:10px;color:#54626f">v2 落库率</div><div style="width:100%;height:5px;background:#232c38;border-radius:3px;overflow:hidden;margin-top:6px"><div style="height:100%;background:linear-gradient(90deg,#bb8009,#d29922);transition:width 0.6s" :style="{ width: Math.min(100, v2Rate) + \'%\' }"></div></div></div><div style="margin-top:6px;font-size:11px;color:#54626f">file tree {{ fmt(stats.meta.withFileTree||0) }}</div></div>' +
        '<div class="card"><div class="card-title"><span>冷存储状态</span><span :style="{ color: (stats.coldStorage && stats.coldStorage.running) ? \'#3fb950\' : \'#f85149\' }">{{ (stats.coldStorage && stats.coldStorage.running) ? \'运行中\' : \'未启动\' }}</span></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><div class="mini-stat"><div class="l">冷库总数</div><div class="v">{{ fmt(stats.coldStorage ? stats.coldStorage.total : 0) }}</div></div><div class="mini-stat"><div class="l">已同步</div><div class="v" style="color:#3fb950">{{ fmt(stats.coldStorage ? stats.coldStorage.synced : 0) }}</div></div><div class="mini-stat"><div class="l">待同步</div><div class="v" style="color:#d29922">{{ fmt(stats.coldStorage ? stats.coldStorage.pending : 0) }}</div></div><div class="mini-stat"><div class="l">同步率</div><div class="v">{{ coldRate }}%</div></div></div><div style="margin-top:8px;font-size:10px;color:#54626f">数据库路径：</div><div style="font-size:10px;color:#7d8a99;word-break:break-all;margin-top:2px;font-family:Consolas,monospace">{{ stats.coldStorage ? (stats.coldStorage.dbPath||\'—\') : \'—\' }}</div><div style="margin-top:6px;font-size:11px;color:#54626f">最近同步 {{ stats.coldStorage ? (stats.coldStorage.lastSync ? fmtTime(stats.coldStorage.lastSync) : \'—\') : \'—\' }}</div></div>' +
        '<div class="card"><div class="card-title"><span>Tracker 健康度</span><span style="color:#3fb950;font-weight:600">{{ fmt(stats.tracker ? stats.tracker.alive : 0) }}/{{ fmt(stats.tracker ? stats.tracker.total : 0) }}</span></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><div class="mini-stat"><div class="l">总 tracker</div><div class="v">{{ fmt(stats.tracker ? stats.tracker.total : 0) }}</div></div><div class="mini-stat"><div class="l">存活</div><div class="v" style="color:#3fb950">{{ fmt(stats.tracker ? stats.tracker.alive : 0) }}</div></div><div class="mini-stat"><div class="l">死亡/未检</div><div class="v" style="color:#f85149">{{ fmt(stats.tracker ? stats.tracker.dead : 0) }}/{{ fmt(stats.tracker ? stats.tracker.unchecked : 0) }}</div></div><div class="mini-stat"><div class="l">平均延迟</div><div class="v">{{ stats.tracker ? (stats.tracker.avgLatency||0) : 0 }}ms</div></div></div><div style="margin-top:8px;font-size:10px;color:#54626f">存活率</div><div style="width:100%;height:5px;background:#232c38;border-radius:3px;overflow:hidden;margin-top:6px"><div style="height:100%;background:linear-gradient(90deg,#238636,#3fb950);transition:width 0.6s" :style="{ width: trkRate + \'%\' }"></div></div><div style="margin-top:6px;font-size:11px;color:#54626f">{{ stats.tracker ? (stats.tracker.checking ? \'全量健康检查进行中…\' : (\'共 \' + fmt(stats.tracker.sources||0) + \' 个列表源\')) : \'详情见下方列表\' }}</div></div>' +
      '</div>' +
      '<div style="display:grid;gap:12px;grid-template-columns:minmax(0,2fr) minmax(0,1fr);margin-top:12px">' +
        '<div class="card"><div class="card-title"><span>Tracker 详情（全量 · 存活在前 · 滚动查看）</span><span style="display:flex;align-items:center;gap:4px"><input v-model="trkFilter" placeholder="过滤 URL…" style="width:180px;background:#0f1419;border:1px solid #232c38;border-radius:4px;color:#c9d1d9;padding:3px 8px;font-size:11px;outline:none"><button @click="openAddModal" style="background:#238636;color:#fff;border:none;border-radius:4px;padding:2px 10px;cursor:pointer;font-size:12px;margin-left:4px">+ 添加 Tracker</button><span style="color:#54626f;margin-left:8px">共 {{ fmt(trkList.length) }} 条 · 存活 {{ fmt(trkAliveCount) }}{{ trkFilter ? \' · 过滤 \' + filteredTrackers.length : \'\' }}</span></span></div><div style="max-height:420px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th>Tracker URL</th><th>状态</th><th>延迟</th><th>失败</th><th>最近检查</th></tr></thead><tbody><tr v-if="!filteredTrackers.length"><td colspan="5" style="color:#54626f;text-align:center;padding:20px;font-size:12px">{{ trkList.length ? \'无匹配\' : \'未启动 TrackerManager\' }}</td></tr><tr v-for="t in filteredTrackers" :key="t.url"><td style="padding:4px 8px;border-bottom:1px solid #1a2230;color:#c3ccd6;font-family:Consolas,monospace;font-size:11px;word-break:break-all">{{ esc(t.url) }}</td><td style="padding:4px 8px;border-bottom:1px solid #1a2230;white-space:nowrap"><span v-if="t.alive===true" style="color:#3fb950">● 存活</span><span v-else-if="t.alive===false" style="color:#f85149">● 死亡</span><span v-else style="color:#7d8a99">○ 未检</span></td><td style="padding:4px 8px;border-bottom:1px solid #1a2230;font-family:Consolas,monospace;font-size:11px">{{ t.latency > 0 ? t.latency + \'ms\' : \'—\' }}</td><td style="padding:4px 8px;border-bottom:1px solid #1a2230;font-family:Consolas,monospace;font-size:11px">{{ t.fails||0 }}</td><td style="padding:4px 8px;border-bottom:1px solid #1a2230;font-family:Consolas,monospace;font-size:11px">{{ fmtAgo(t.lastCheck) }}</td></tr></tbody></table></div></div>' +
        '<div class="card"><div class="card-title">采集器综合统计</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><div class="mini-stat"><div class="l">会话累计</div><div class="v">{{ fmt(stats.counters.ingested||0) }}</div></div><div class="mini-stat"><div class="l">本次新增</div><div class="v">{{ fmt(stats.counters.newTorrents||0) }}</div></div><div class="mini-stat"><div class="l">DHT announce</div><div class="v">{{ fmt(stats.dht.announces||0) }}</div></div><div class="mini-stat"><div class="l">DHT sample</div><div class="v">{{ fmt(stats.dht.samples||0) }}</div></div></div><div style="margin-top:8px"><div style="font-size:10px;color:#54626f">DHT 集群端口</div><div style="font-size:11px;color:#7d8a99;margin-top:2px;font-family:Consolas,monospace">{{ stats.dht.running ? (\'UDP \' + (stats.dht.ports||[]).join(\' / \')) : \'—\' }}</div></div></div>' +
      '</div>' +
      '<div style="display:grid;gap:12px;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:12px">' +
        '<div class="card"><div class="card-title">实时事件流（最近 30 条）</div><div style="max-height:320px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th>时间</th><th>IP</th><th>资源名</th><th>大小</th><th>来源</th></tr></thead><tbody><tr v-if="!stats.recent.length"><td colspan="5" style="color:#54626f;text-align:center;padding:20px;font-size:12px">暂无数据</td></tr><tr v-for="(e,i) in stats.recent" :key="i"><td class="mono-td">{{ fmtTime(e.ts) }}</td><td class="mono-td">{{ esc(e.ip) }}</td><td :title="esc(e.name)">{{ esc(e.name && e.name.length > 28 ? e.name.slice(0,28) + \'…\' : (e.name || e.infohash.slice(0,12) + \'…\')) }}</td><td class="mono-td">{{ fmtSize(e.size) }}</td><td><span :class="\'src-badge src-\' + e.source">{{ e.source }}</span></td></tr></tbody></table></div></div>' +
        '<div class="card"><div class="card-title">DHT 路由表节点 <span style="font-size:10px;color:#54626f">{{ nodes.length ? \'(\' + fmt(nodes.length) + \')\' : \'\' }}</span></div><div style="max-height:320px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th>Node ID</th><th>地址</th><th>族</th><th>年龄</th></tr></thead><tbody><tr v-if="!nodes.length"><td colspan="4" style="color:#54626f;text-align:center;padding:20px;font-size:12px">DHT 未运行</td></tr><tr v-for="(n,i) in nodes" :key="i"><td class="mono-td">{{ n.id }}</td><td class="mono-td">{{ n.address }}</td><td>{{ n.family === \'ipv6\' ? \'v6\' : \'v4\' }}</td><td>{{ n.ageSec }}s</td></tr></tbody></table></div></div>' +
        '<div class="card"><div class="card-title">系统资源</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><div class="mini-stat"><div class="l">内存 RSS</div><div class="v">{{ fmtMB(stats.system.rss) }}</div></div><div class="mini-stat"><div class="l">堆使用</div><div class="v">{{ fmtMB(stats.system.heapUsed) }}</div></div><div class="mini-stat"><div class="l">运行时长</div><div class="v">{{ fmtDur(stats.system.uptime) }}</div></div><div class="mini-stat"><div class="l">Node 版本</div><div class="v" style="font-size:12px">{{ stats.system.nodeVersion }}</div></div></div><div style="margin-top:8px"><div style="font-size:10px;color:#54626f">内存占用趋势</div><div style="position:relative;height:80px;margin-top:4px"><canvas id="memChart"></canvas></div></div></div>' +
      '</div>' +
    '</div>' +
    '<div style="text-align:center;padding:14px;color:#54626f;font-size:11px">BITTORRENTS Network Monitor · DHT 集群 + PEX + Tracker + 爬虫聚合 + WebSeed 全网络接入 · 分步加载 · 平滑过渡</div>' +
    '<div v-if="showAddModal" @click.self="closeAddModal" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center"><div style="background:#1c2331;border:1px solid #30363d;border-radius:8px;padding:20px;width:560px;max-width:90vw"><div style="color:#c9d1d9;font-size:15px;font-weight:600;margin-bottom:10px">手动添加 Tracker</div><div style="color:#7d8a99;font-size:11px;margin-bottom:8px">输入一个或多个 tracker URL（每行一个，或用逗号/空格分隔）。支持 udp:// 和 http(s):// 协议。重复的自动忽略。</div><textarea v-model="trkInput" style="width:100%;height:140px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;padding:8px;font-family:monospace;font-size:12px;resize:vertical" placeholder="udp://tracker.example.com:6969/announce"></textarea><div v-if="addResult" style="margin-top:8px;font-size:12px"><div v-if="addResult.loading" style="color:#7d8a99">正在添加并触发健康检查…</div><div v-else-if="addResult.added !== undefined" style="color:#3fb950">✓ 添加 {{ addResult.added }} 个<span v-if="addResult.duplicates > 0">，重复 {{ addResult.duplicates }} 个</span><span v-if="addResult.errors && addResult.errors.length">，错误 {{ addResult.errors.length }} 个</span></div><div v-else-if="addResult.error" style="color:#f85149">添加失败: {{ addResult.error }}</div></div><div style="margin-top:12px;text-align:right"><button @click="closeAddModal" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:6px 16px;cursor:pointer;margin-right:8px">取消</button><button @click="submitAddTrackers" style="background:#238636;color:#fff;border:none;border-radius:4px;padding:6px 16px;cursor:pointer">添加并检查</button></div></div></div>' +
  '</div>'
};

/* 全局样式（补充 Vue 组件无法内联的通用样式） */
const styleEl = document.createElement('style');
styleEl.textContent = '.card{background:#161d27;border:1px solid #232c38;border-radius:8px;padding:12px 14px;box-shadow:0 1px 4px rgba(0,0,0,0.3);transition:border-color .2s;overflow:hidden}.card:hover{border-color:#2d3a4a}.card-title{font-size:10px;color:#7d8a99;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}.mini-stat{background:#0f1419;border-radius:4px;padding:6px 8px}.mini-stat .v{font-size:15px;font-weight:600;color:#fff}.mini-stat .l{font-size:10px;color:#54626f}table th{color:#7d8a99;font-weight:600;text-transform:uppercase;font-size:10px;padding:6px 8px;text-align:left;border-bottom:1px solid #232c38;position:sticky;top:0;background:#161d27;z-index:2}table td{padding:4px 8px;border-bottom:1px solid #1a2230;color:#c3ccd6}tr:hover td{background:#18202c}.mono-td{font-family:Consolas,monospace;font-size:11px}.tw-btn{padding:3px 10px;border-radius:4px;border:1px solid;cursor:pointer;font-size:11px}.tw-active{background:#238636;color:#fff;border-color:#238636}.tw-inactive{background:transparent;color:#7d8a99;border-color:#232c38}@media(max-width:1200px){[style*="repeat(8,minmax(0,1fr))"]{grid-template-columns:repeat(4,minmax(0,1fr))!important}[style*="minmax(0,2fr)"]{grid-template-columns:1fr!important}[style*="repeat(4,minmax(0,1fr))"]{grid-template-columns:repeat(2,minmax(0,1fr))!important}}@media(max-width:800px){[style*="grid-template-columns"]{grid-template-columns:1fr!important}}';
document.head.appendChild(styleEl);

const _app = createApp(App);
_app.config.errorHandler = function(err, vm, info) { console.error('[monitor Vue error]', err, info); };
_app.mount('#app');
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
