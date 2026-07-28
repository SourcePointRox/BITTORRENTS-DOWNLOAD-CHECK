'use strict';
/* 独立监控 WebUI：专门监控后端运行状态的独立 HTTP 服务。
   运行在独立端口上，与主站点分离，提供：
   - 各服务运行状态（主站点 / 采集器 / DHT / Tracker / PEX）
   - 实时采集速率与事件流
   - DHT 路由表节点详情
   - 来源分布（DHT / Tracker / PEX / 模拟器）
   - 系统资源占用（内存 / uptime）
   - 历史采集趋势图表 */
const http = require('http');
const os = require('os');
const db = require('./db');

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

/* 时间桶统计（总量） */
function perMinuteBuckets(minutes) {
  const now = Date.now();
  const from = now - minutes * 60000;
  const rows = db.get().prepare(
    'SELECT (ts/60000)*60000 AS bucket, COUNT(*) AS c FROM obs_log WHERE ts >= ? GROUP BY bucket ORDER BY bucket'
  ).all(from);
  const map = new Map(rows.map(r => [Number(r.bucket), r.c]));
  const out = [];
  for (let t = Math.floor(from / 60000) * 60000; t <= now; t += 60000) {
    out.push({ t, c: map.get(t) || 0 });
  }
  return out;
}

/* 按来源分桶统计 —— 用于堆叠面积图，展示各采集器贡献 */
const SOURCES = ['dht_passive', 'dht_active', 'dht_sample', 'tracker', 'pex', 'simulator'];
function perMinuteBySource(minutes) {
  const now = Date.now();
  const from = now - minutes * 60000;
  const rows = db.get().prepare(
    'SELECT (ts/60000)*60000 AS bucket, source, COUNT(*) AS c FROM obs_log WHERE ts >= ? GROUP BY bucket, source ORDER BY bucket'
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
  for (let t = Math.floor(from / 60000) * 60000; t <= now; t += 60000) {
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
function topCountries(limit = 8) {
  const since = fmtDay(Date.now() - 86400000);
  const rows = db.get().prepare(
    'SELECT cc, SUM(peers) AS c FROM country_daily WHERE day >= ? GROUP BY cc ORDER BY c DESC LIMIT ?'
  ).all(since, limit);
  return rows.map(r => ({ cc: r.cc, c: r.c }));
}

/* 元数据解析统计：已解析 size 的种子数 / 总种子数 */
function metaStats() {
  const d = db.get();
  const total = d.prepare('SELECT COUNT(*) AS c FROM torrents').get().c;
  const withMeta = d.prepare('SELECT COUNT(*) AS c FROM torrents WHERE metadata_ok=1').get().c;
  const withSize = d.prepare('SELECT COUNT(*) AS c FROM torrents WHERE size > 0').get().c;
  const withName = d.prepare('SELECT COUNT(*) AS c FROM torrents WHERE name IS NOT NULL').get().c;
  return { total, withMeta, withSize, withName };
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

/* 路由 */
async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;

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
  if (pathname === '/api/stats') {
    if (!collectorRef) return json(res, 503, { error: 'collector not initialized' });
    const s = collectorRef.getStats();
    const mins = parseInt(u.searchParams.get('mins') || '60', 10);
    s.perMinute = perMinuteBuckets(mins);
    s.perMinuteBySource = perMinuteBySource(mins);
    s.sources = sourceBreakdown();
    s.topCountries = topCountries(8);
    s.meta = metaStats();
    s.system = systemMetrics();
    s.health = healthScore(s);
    s.sitePort = sitePort;
    // 速率统计
    const vals = s.perMinute.map(b => b.c).filter(c => c > 0);
    s.peakRate = vals.length ? Math.max(...vals) : 0;
    s.avgRate = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    // 元数据成功率
    s.metaSuccessRate = s.counters.metaResolved + s.counters.metaFailed > 0
      ? Math.round(s.counters.metaResolved * 100 / (s.counters.metaResolved + s.counters.metaFailed)) : 0;
    // 给最近事件补名 + size
    const d = db.get();
    const stmt = d.prepare('SELECT name, size FROM torrents WHERE infohash=?');
    s.recent = s.recent.map(e => {
      const t = stmt.get(e.infohash);
      return { ...e, name: (t && t.name) || e.infohash.slice(0, 16) + '…', size: (t && t.size) || 0 };
    });
    return json(res, 200, s);
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

/* 监控仪表盘 HTML —— 高信息密度 + 平滑图表（update 而非 destroy 重建） */
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
  .header { background: linear-gradient(135deg, #161d27 0%, #0f1419 100%); border-bottom: 2px solid #238636; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 18px; color: #58a6ff; display: flex; align-items: center; gap: 10px; }
  .header h1 .icon { width: 26px; height: 26px; background: #238636; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; }
  .header .status-bar { display: flex; gap: 14px; align-items: center; font-size: 12px; }
  .health-badge { padding: 3px 12px; border-radius: 16px; font-weight: 600; font-size: 11px; }
  .health-good { background: rgba(35,134,54,0.2); color: #3fb950; border: 1px solid #238636; }
  .health-warn { background: rgba(187,128,9,0.2); color: #d29922; border: 1px solid #bb8009; }
  .health-bad { background: rgba(248,81,73,0.2); color: #f85149; border: 1px solid #f85149; }
  .container { max-width: 1600px; margin: 0 auto; padding: 14px; }
  .grid { display: grid; gap: 12px; }
  .grid-8 { grid-template-columns: repeat(8, 1fr); }
  .grid-4 { grid-template-columns: repeat(4, 1fr); }
  .grid-3 { grid-template-columns: repeat(3, 1fr); }
  .grid-2 { grid-template-columns: repeat(2, 1fr); }
  @media (max-width: 1200px) { .grid-8 { grid-template-columns: repeat(4, 1fr); } }
  @media (max-width: 800px) { .grid-8, .grid-4, .grid-3, .grid-2 { grid-template-columns: 1fr; } }
  .card { background: #161d27; border: 1px solid #232c38; border-radius: 8px; padding: 12px 14px; }
  .card-title { font-size: 10px; color: #7d8a99; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
  .stat-value { font-size: 24px; font-weight: 700; color: #fff; line-height: 1.1; }
  .stat-sub { font-size: 11px; color: #54626f; margin-top: 3px; }
  .stat-trend { font-size: 11px; }
  .up { color: #3fb950; }
  .down { color: #f85149; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { color: #7d8a99; font-weight: 600; text-transform: uppercase; font-size: 10px; padding: 6px 8px; text-align: left; border-bottom: 1px solid #232c38; }
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
  .src-tracker { background: #5c4a24; color: #ffd77d; }
  .src-pex { background: #5c2424; color: #ff9a9a; }
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
  .scroll::-webkit-scrollbar { width: 6px; }
  .scroll::-webkit-scrollbar-thumb { background: #232c38; border-radius: 3px; }
  .mini-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .mini-stat { background: #0f1419; border-radius: 4px; padding: 6px 8px; }
  .mini-stat .v { font-size: 15px; font-weight: 600; color: #fff; }
  .mini-stat .l { font-size: 10px; color: #54626f; }
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

  <!-- 主图表 + 来源分布 -->
  <div class="grid grid-2" style="margin-top:12px">
    <div class="card">
      <div class="card-title">
        <span>采集趋势 · 多来源堆叠</span>
        <span>
          <button class="tw-btn" data-mins="15">15m</button>
          <button class="tw-btn active" data-mins="60">1h</button>
          <button class="tw-btn" data-mins="180">3h</button>
          <button class="tw-btn" data-mins="360">6h</button>
        </span>
      </div>
      <div class="chart-container"><canvas id="rateChart"></canvas></div>
      <div class="legend" id="chartLegend"></div>
    </div>
    <div class="card">
      <div class="card-title"><span>来源分布（近 1h）</span><span id="srcTotal" style="color:#54626f"></span></div>
      <div id="sourceList" style="margin-top:8px"></div>
    </div>
  </div>

  <!-- 采集器状态 + 元数据 + 地理 -->
  <div class="grid grid-3" style="margin-top:12px">
    <div class="card">
      <div class="card-title">采集器状态</div>
      <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
        <div id="dhtStatus"><span class="pulse pulse-off"></span>DHT 未运行</div>
        <div id="trackerStatus"><span class="pulse pulse-off"></span>Tracker 未运行</div>
        <div id="pexStatus"><span class="pulse pulse-off"></span>PEX 未运行</div>
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
        <div class="mini-stat"><div class="l">元数据 OK</div><div class="v" id="metaOk">0</div></div>
      </div>
      <div style="margin-top:8px">
        <div class="l" style="font-size:10px;color:#54626f">size 落库率</div>
        <div class="progress-bar"><div class="progress-fill" id="sizeBar" style="width:0%"></div></div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:#54626f">队列 <span id="metaQueue">0</span></div>
    </div>
    <div class="card">
      <div class="card-title">Top 国家（近 24h）</div>
      <div id="countryList" style="margin-top:8px"></div>
    </div>
  </div>

  <!-- 实时事件流 + DHT 路由表 + 系统资源 -->
  <div class="grid grid-3" style="margin-top:12px">
    <div class="card">
      <div class="card-title">实时事件流（最近 30 条）</div>
      <div class="scroll">
      <table>
        <thead><tr><th>时间</th><th>IP</th><th>资源名</th><th>大小</th><th>来源</th></tr></thead>
        <tbody id="recentBody"><tr><td colspan="5" style="color:#54626f;text-align:center;padding:20px">等待数据...</td></tr></tbody>
      </table>
      </div>
    </div>
    <div class="card">
      <div class="card-title">DHT 路由表节点 <span id="nodeCount" style="font-size:10px;color:#54626f"></span></div>
      <div class="scroll">
      <table>
        <thead><tr><th>Node ID</th><th>地址</th><th>年龄</th></tr></thead>
        <tbody id="nodesBody"><tr><td colspan="3" style="color:#54626f;text-align:center;padding:20px">DHT 未运行</td></tr></tbody>
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

<div class="footer">BITTORRENTS Network Monitor · DHT + PEX + Tracker + P2P 全网络接入 · 自动刷新 2s · 平滑过渡</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@2.9.4/dist/Chart.min.js"></script>
<script>
var rateChart = null, memChart = null;
var curMins = 60;
var memHistory = [];
var SRC_DEFS = [
  { key: 'dht_passive', label: 'DHT被动', color: '#9966ff' },
  { key: 'dht_active', label: 'DHT主动', color: '#4bc0c0' },
  { key: 'dht_sample', label: 'DHT采样', color: '#36a2eb' },
  { key: 'tracker', label: 'Tracker', color: '#ff9f40' },
  { key: 'pex', label: 'PEX', color: '#ff6384' },
  { key: 'simulator', label: '模拟', color: '#a0a0a0' }
];

function fmt(n) { return (n||0).toLocaleString('en-US'); }
function fmtMB(b) { return (b/1048576).toFixed(1) + ' MB'; }
function fmtSize(b) { if (!b||b<=0) return '—'; if (b<1024) return b+'B'; if (b<1048576) return (b/1024).toFixed(1)+'KB'; if (b<1073741824) return (b/1048576).toFixed(1)+'MB'; return (b/1073741824).toFixed(2)+'GB'; }
function fmtTime(ts) { return new Date(ts).toTimeString().slice(0,8); }
function fmtDur(s) { if (s<60) return s+'s'; if (s<3600) return Math.floor(s/60)+'m'+s%60+'s'; return Math.floor(s/3600)+'h'+Math.floor((s%3600)/60)+'m'; }
function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function updateHealth(score) {
  var el = document.getElementById('healthBadge');
  document.getElementById('healthBar').style.width = score + '%';
  el.className = 'health-badge ' + (score >= 70 ? 'health-good' : score >= 30 ? 'health-warn' : 'health-bad');
  el.textContent = score >= 70 ? '健康' : score >= 30 ? '警告' : '异常';
}

/* 平滑更新图表：保留 Chart 实例，仅更新 data + labels 后调用 update()。
   Chart.js 内置过渡动画会让曲线顺滑变化，而非整图闪动重建。 */
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
      legend: { display: false },
      animation: { duration: 400, easing: 'easeOutQuart' },
      scales: {
        xAxes: [{ ticks: { fontColor: '#7d8a99', maxTicksLimit: 8, fontSize: 10 }, gridLines: { color: '#1c2530' } }],
        yAxes: [{ stacked: true, ticks: { fontColor: '#7d8a99', beginAtZero: true, fontSize: 10 }, gridLines: { color: '#1c2530' } }]
      },
      tooltips: { mode: 'index', intersect: false }
    }
  });
  // 图例
  document.getElementById('chartLegend').innerHTML = SRC_DEFS.map(function(s) {
    return '<span><i style="background:' + s.color + '"></i>' + s.label + '</span>';
  }).join('');
  return rateChart;
}

function ensureMemChart() {
  if (memChart) return memChart;
  var ctx = document.getElementById('memChart').getContext('2d');
  memChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#d29922', backgroundColor: 'rgba(210,153,34,0.15)', fill: true, pointRadius: 0, borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, legend: { display: false }, animation: { duration: 400 }, scales: { xAxes: [{ display: false }], yAxes: [{ ticks: { fontColor: '#7d8a99', fontSize: 9, callback: function(v){ return (v/1048576).toFixed(0)+'M'; } }, gridLines: { color: '#1c2530' } }] } }
  });
  return memChart;
}

function renderStats(s) {
  document.getElementById('mode').textContent = s.mode.toUpperCase();
  document.getElementById('modeSub').textContent = s.mode === 'off' ? 'stopped' : ('run ' + fmtDur(s.uptimeSec));
  document.getElementById('torrents').textContent = fmt(s.db.torrents);
  document.getElementById('newTorrents').textContent = '新增 ' + fmt(s.counters.newTorrents);
  document.getElementById('peers').textContent = fmt(s.db.peers);
  document.getElementById('todayEvents').textContent = '今日 ' + fmt(s.todayEvents);
  document.getElementById('rate').innerHTML = fmt(s.ratePerMin) + '<span style="font-size:12px;color:#7d8a99">/min</span>';
  document.getElementById('peakRate').textContent = fmt(s.peakRate);
  document.getElementById('avgRate').textContent = fmt(s.avgRate);
  document.getElementById('dhtNodes').textContent = s.dht.running ? fmt(s.dht.nodes) : '—';
  document.getElementById('dhtStats').textContent = s.dht.running ? ('rx ' + fmt(s.dht.rx) + ' / tx ' + fmt(s.dht.tx)) : '未运行';
  document.getElementById('totalEvents').textContent = fmt(s.db.obsLog);
  document.getElementById('obsDetail').textContent = '观测 ' + fmt(s.db.observations) + ' · 日志 ' + fmt(s.db.obsLog);

  // 元数据
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
  document.getElementById('metaQueue').textContent = fmt(s.metaQueue);

  // 采集器
  var dhtEl = document.getElementById('dhtStatus');
  if (s.dht.running) dhtEl.innerHTML = '<span class="pulse pulse-on"></span>DHT 运行中 (UDP ' + (s.dht.port||6881) + ')';
  else dhtEl.innerHTML = '<span class="pulse pulse-off"></span>DHT 未运行';
  document.getElementById('dhtRxTx').textContent = fmt(s.dht.rx) + ' / ' + fmt(s.dht.tx);
  document.getElementById('dhtPeers').textContent = fmt(s.dht.peers);
  document.getElementById('trkPeers').textContent = fmt(s.counters.trackerPeers||0);
  document.getElementById('pexPeers').textContent = fmt(s.counters.pexPeers||0);
  var trackEl = document.getElementById('trackerStatus');
  trackEl.innerHTML = s.mode === 'live' ? '<span class="pulse pulse-on"></span>Tracker 运行中' : '<span class="pulse pulse-off"></span>Tracker 未运行';
  var pexEl = document.getElementById('pexStatus');
  pexEl.innerHTML = s.mode === 'live' ? '<span class="pulse pulse-on"></span>PEX 运行中' : '<span class="pulse pulse-off"></span>PEX 未运行';

  // 健康
  document.getElementById('health').textContent = s.health;
  updateHealth(s.health);
  document.getElementById('uptimeText').textContent = s.mode === 'off' ? '—' : ('运行 ' + fmtDur(s.uptimeSec));

  // 主图：平滑更新（不销毁）
  var chart = ensureRateChart();
  var labels = s.perMinuteBySource.map(function(b){ return new Date(b.t).toTimeString().slice(0,5); });
  chart.data.labels = labels;
  SRC_DEFS.forEach(function(sd, i) {
    chart.data.datasets[i].data = s.perMinuteBySource.map(function(b){ return b[sd.key] || 0; });
  });
  chart.update();

  // 来源分布（百分比 + 进度条）
  var srcTotal = s.sources.reduce(function(a,b){ return a+b.c; }, 0);
  document.getElementById('srcTotal').textContent = '共 ' + fmt(srcTotal);
  var srcHtml = s.sources.map(function(x) {
    var pct = srcTotal > 0 ? (x.c * 100 / srcTotal).toFixed(1) : '0';
    var def = SRC_DEFS.find(function(d){ return d.key === x.source; }) || { color: '#c9cbcf', label: x.source };
    return '<div style="margin-bottom:7px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px"><span><span class="src-badge src-' + x.source + '">' + def.label + '</span></span><span>' + fmt(x.c) + ' <span style="color:#54626f">(' + pct + '%)</span></span></div><div class="bar" style="width:' + Math.max(2, pct) + '%;background:' + def.color + ';min-width:8px"></div></div>';
  }).join('');
  document.getElementById('sourceList').innerHTML = srcHtml || '<div style="color:#54626f">暂无数据</div>';

  // Top 国家
  var ccHtml = (s.topCountries||[]).map(function(c) {
    return '<div style="margin-bottom:5px;display:flex;justify-content:space-between;font-size:11px"><span>' + esc(c.cc||'?') + '</span><span>' + fmt(c.c) + '</span></div>';
  }).join('');
  document.getElementById('countryList').innerHTML = ccHtml || '<div style="color:#54626f">暂无数据</div>';

  // 实时事件（含 size 列）
  var body = document.getElementById('recentBody');
  if (!s.recent.length) { body.innerHTML = '<tr><td colspan="5" style="color:#54626f;text-align:center;padding:20px">暂无数据</td></tr>'; }
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
}

function renderNodes(d) {
  var body = document.getElementById('nodesBody');
  document.getElementById('nodeCount').textContent = d.nodes.length ? ('(' + fmt(d.nodes.length) + ')') : '';
  if (!d.nodes.length) { body.innerHTML = '<tr><td colspan="3" style="color:#54626f;text-align:center;padding:20px">DHT 未运行</td></tr>'; return; }
  body.innerHTML = d.nodes.map(function(n) {
    return '<tr><td class="mono">' + n.id + '</td><td class="mono">' + n.address + '</td><td>' + n.ageSec + 's</td></tr>';
  }).join('');
}

function refresh() {
  fetch('/api/stats?mins=' + curMins).then(function(r){return r.json();}).then(renderStats).catch(function(){});
  fetch('/api/nodes').then(function(r){return r.json();}).then(renderNodes).catch(function(){});
}

document.addEventListener('click', function(e) {
  if (e.target.classList && e.target.classList.contains('tw-btn')) {
    document.querySelectorAll('.tw-btn').forEach(function(b){ b.classList.remove('active'); });
    e.target.classList.add('active');
    curMins = parseInt(e.target.getAttribute('data-mins'), 10);
    refresh();
  }
});

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

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
  return server;
}

module.exports = { start, init };
