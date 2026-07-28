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

/* 时间桶统计 */
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

/* 来源分布（近 1 小时） */
function sourceBreakdown() {
  const since = Date.now() - 3600000;
  return db.get().prepare('SELECT source, COUNT(*) AS c FROM obs_log WHERE ts >= ? GROUP BY source ORDER BY c DESC').all(since);
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
    s.perMinute = perMinuteBuckets(60);
    s.sources = sourceBreakdown();
    s.system = systemMetrics();
    s.health = healthScore(s);
    s.sitePort = sitePort;
    // 给最近事件补名
    const d = db.get();
    const stmt = d.prepare('SELECT name FROM torrents WHERE infohash=?');
    s.recent = s.recent.map(e => {
      const t = stmt.get(e.infohash);
      return { ...e, name: (t && t.name) || e.infohash.slice(0, 16) + '…' };
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

/* 监控仪表盘 HTML */
function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BITTORRENTS 网络监控中心</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0e14; color: #c9d1d9; font-family: 'Segoe UI', 'Consolas', monospace; min-height: 100vh; }
  .header { background: linear-gradient(135deg, #161d27 0%, #0f1419 100%); border-bottom: 2px solid #238636; padding: 16px 28px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 20px; color: #58a6ff; display: flex; align-items: center; gap: 10px; }
  .header h1 .icon { width: 28px; height: 28px; background: #238636; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 16px; }
  .header .status-bar { display: flex; gap: 16px; align-items: center; font-size: 13px; }
  .health-badge { padding: 4px 14px; border-radius: 20px; font-weight: 600; font-size: 12px; }
  .health-good { background: rgba(35,134,54,0.2); color: #3fb950; border: 1px solid #238636; }
  .health-warn { background: rgba(187,128,9,0.2); color: #d29922; border: 1px solid #bb8009; }
  .health-bad { background: rgba(248,81,73,0.2); color: #f85149; border: 1px solid #f85149; }
  .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
  .grid { display: grid; gap: 16px; }
  .grid-6 { grid-template-columns: repeat(6, 1fr); }
  .grid-3 { grid-template-columns: repeat(3, 1fr); }
  .grid-2 { grid-template-columns: repeat(2, 1fr); }
  @media (max-width: 900px) { .grid-6, .grid-3, .grid-2 { grid-template-columns: 1fr; } }
  .card { background: #161d27; border: 1px solid #232c38; border-radius: 10px; padding: 16px 18px; }
  .card-title { font-size: 11px; color: #7d8a99; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .stat-value { font-size: 28px; font-weight: 700; color: #fff; }
  .stat-sub { font-size: 12px; color: #54626f; margin-top: 4px; }
  .stat-icon { float: right; font-size: 20px; opacity: 0.3; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { color: #7d8a99; font-weight: 600; text-transform: uppercase; font-size: 11px; padding: 8px 10px; text-align: left; border-bottom: 1px solid #232c38; }
  td { padding: 6px 10px; border-bottom: 1px solid #1a2230; color: #c3ccd6; }
  tr:hover td { background: #18202c; }
  .mono { font-family: 'Consolas', monospace; font-size: 12px; }
  .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .pulse-on { background: #3fb950; box-shadow: 0 0 8px #3fb950; animation: pulse 2s infinite; }
  .pulse-off { background: #555; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  .src-badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .src-dht_passive { background: #3d2a5c; color: #c49aff; }
  .src-dht_active { background: #2a5c46; color: #8affc1; }
  .src-tracker { background: #5c4a24; color: #ffd77d; }
  .src-pex { background: #5c2424; color: #ff9a9a; }
  .src-simulator { background: #24425c; color: #7dc4ff; }
  .chart-container { position: relative; height: 200px; margin-top: 10px; }
  .bar { display: inline-block; height: 20px; border-radius: 3px; vertical-align: middle; transition: width 0.5s; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer { text-align: center; padding: 20px; color: #54626f; font-size: 12px; }
  .progress-bar { width: 100%; height: 6px; background: #232c38; border-radius: 3px; overflow: hidden; margin-top: 8px; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #238636, #3fb950); transition: width 0.5s; }
</style>
</head>
<body>
<div class="header">
  <h1><span class="icon">B</span>BITTORRENTS 网络监控中心</h1>
  <div class="status-bar">
    <span id="healthBadge" class="health-badge health-bad">—</span>
    <span id="uptimeText" style="color:#7d8a99">—</span>
    <a href="/" id="siteLink" target="_blank" style="font-size:12px">主站点 →</a>
  </div>
</div>

<div class="container">
  <!-- 核心指标卡片 -->
  <div class="grid grid-6">
    <div class="card">
      <div class="card-title">采集模式</div>
      <div class="stat-value" id="mode" style="font-size:22px">—</div>
      <div class="stat-sub" id="modeSub">collector stopped</div>
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
      <div class="card-title">采集速率</div>
      <div class="stat-value" id="rate">0<span style="font-size:14px;color:#7d8a99">/min</span></div>
      <div class="stat-sub" id="totalEvents">累计 0</div>
    </div>
    <div class="card">
      <div class="card-title">DHT 节点</div>
      <div class="stat-value" id="dhtNodes">—</div>
      <div class="stat-sub" id="dhtStats">未运行</div>
    </div>
    <div class="card">
      <div class="card-title">健康度</div>
      <div class="stat-value" id="health">—</div>
      <div class="progress-bar"><div class="progress-fill" id="healthBar" style="width:0%"></div></div>
    </div>
  </div>

  <!-- 图表区 -->
  <div class="grid grid-2" style="margin-top:16px">
    <div class="card">
      <div class="card-title">采集趋势（近 60 分钟 · 每分钟事件数）</div>
      <div class="chart-container"><canvas id="rateChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">来源分布（近 1 小时）</div>
      <div id="sourceList" style="margin-top:12px"></div>
    </div>
  </div>

  <!-- 采集器状态 -->
  <div class="grid grid-3" style="margin-top:16px">
    <div class="card">
      <div class="card-title">DHT 采集器</div>
      <div id="dhtStatus" style="margin-top:8px"><span class="pulse pulse-off"></span>未运行</div>
      <div id="dhtDetail" class="stat-sub" style="margin-top:8px"></div>
    </div>
    <div class="card">
      <div class="card-title">Tracker 采集器</div>
      <div id="trackerStatus" style="margin-top:8px"><span class="pulse pulse-off"></span>未运行</div>
      <div id="trackerDetail" class="stat-sub" style="margin-top:8px">已发现 0 个 peer</div>
    </div>
    <div class="card">
      <div class="card-title">PEX 采集器</div>
      <div id="pexStatus" style="margin-top:8px"><span class="pulse pulse-off"></span>未运行</div>
      <div id="pexDetail" class="stat-sub" style="margin-top:8px">已发现 0 个 peer</div>
    </div>
  </div>

  <!-- 实时事件流 + DHT 路由表 -->
  <div class="grid grid-2" style="margin-top:16px">
    <div class="card">
      <div class="card-title">实时事件流（最近 30 条）</div>
      <table>
        <thead><tr><th>时间</th><th>IP</th><th>Infohash</th><th>资源名</th><th>来源</th></tr></thead>
        <tbody id="recentBody"><tr><td colspan="5" style="color:#54626f;text-align:center">等待数据...</td></tr></tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-title">DHT 路由表节点 <span id="nodeCount" style="font-size:11px;color:#54626f"></span></div>
      <div style="max-height:400px;overflow-y:auto">
      <table>
        <thead><tr><th>Node ID</th><th>地址</th><th>活跃</th></tr></thead>
        <tbody id="nodesBody"><tr><td colspan="3" style="color:#54626f;text-align:center">DHT 未运行</td></tr></tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- 系统资源 -->
  <div class="grid grid-3" style="margin-top:16px">
    <div class="card">
      <div class="card-title">内存占用 (RSS)</div>
      <div class="stat-value" id="rss" style="font-size:20px">— MB</div>
      <div class="stat-sub" id="heapDetail">堆 — / —</div>
    </div>
    <div class="card">
      <div class="card-title">运行时长</div>
      <div class="stat-value" id="sysUptime" style="font-size:20px">—</div>
      <div class="stat-sub" id="sysPlatform">—</div>
    </div>
    <div class="card">
      <div class="card-title">元数据处理</div>
      <div class="stat-value" id="metaStat" style="font-size:20px">0 / 0</div>
      <div class="stat-sub" id="metaQueue">队列 0</div>
    </div>
  </div>
</div>

<div class="footer">BITTORRENTS Network Monitor · DHT + PEX + Tracker + P2P 全网络接入 · 自动刷新 2s</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@2.9.4/dist/Chart.min.js"></script>
<script>
var rateChart = null;
var SRC_COLORS = { dht_passive: '#9966ff', dht_active: '#4bc0c0', tracker: '#ff9f40', pex: '#ff6384', simulator: '#36a2eb' };

function fmt(n) { return (n||0).toLocaleString('en-US'); }
function fmtMB(b) { return (b/1048576).toFixed(1) + ' MB'; }
function fmtTime(ts) { return new Date(ts).toTimeString().slice(0,8); }
function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function updateHealth(score) {
  var el = document.getElementById('healthBadge');
  var bar = document.getElementById('healthBar');
  var val = document.getElementById('health');
  val.textContent = score;
  bar.style.width = score + '%';
  el.className = 'health-badge ' + (score >= 70 ? 'health-good' : score >= 30 ? 'health-warn' : 'health-bad');
  el.textContent = score >= 70 ? '健康' : score >= 30 ? '警告' : '异常';
}

function renderStats(s) {
  document.getElementById('mode').textContent = s.mode.toUpperCase();
  document.getElementById('modeSub').textContent = s.mode === 'off' ? 'collector stopped' : ('running ' + s.uptimeSec + 's');
  document.getElementById('torrents').textContent = fmt(s.db.torrents);
  document.getElementById('newTorrents').textContent = '新增 ' + fmt(s.counters.newTorrents);
  document.getElementById('peers').textContent = fmt(s.db.peers);
  document.getElementById('todayEvents').textContent = '今日 ' + fmt(s.todayEvents);
  document.getElementById('rate').innerHTML = fmt(s.ratePerMin) + '<span style="font-size:14px;color:#7d8a99">/min</span>';
  document.getElementById('totalEvents').textContent = '累计 ' + fmt(s.db.obsLog);
  document.getElementById('dhtNodes').textContent = s.dht.running ? fmt(s.dht.nodes) : '—';
  document.getElementById('dhtStats').textContent = s.dht.running ? ('rx ' + fmt(s.dht.rx) + ' / tx ' + fmt(s.dht.tx)) : '未运行';
  document.getElementById('health').textContent = s.health;
  document.getElementById('healthBar').style.width = s.health + '%';

  // 采集器状态
  var dhtEl = document.getElementById('dhtStatus');
  if (s.dht.running) {
    dhtEl.innerHTML = '<span class="pulse pulse-on"></span>DHT 运行中 (UDP ' + (s.dht.port||6881) + ')';
    document.getElementById('dhtDetail').textContent = 'peers ' + fmt(s.dht.peers) + ' / announce ' + fmt(s.dht.announces);
  } else {
    dhtEl.innerHTML = '<span class="pulse pulse-off"></span>未运行';
  }
  var trackEl = document.getElementById('trackerStatus');
  if (s.mode === 'live') {
    trackEl.innerHTML = '<span class="pulse pulse-on"></span>Tracker 运行中';
    document.getElementById('trackerDetail').textContent = '已发现 ' + fmt(s.counters.trackerPeers||0) + ' 个 peer';
  } else {
    trackEl.innerHTML = '<span class="pulse pulse-off"></span>未运行';
  }
  var pexEl = document.getElementById('pexStatus');
  if (s.mode === 'live') {
    pexEl.innerHTML = '<span class="pulse pulse-on"></span>PEX 运行中';
    document.getElementById('pexDetail').textContent = '已发现 ' + fmt(s.counters.pexPeers||0) + ' 个 peer';
  } else {
    pexEl.innerHTML = '<span class="pulse pulse-off"></span>未运行';
  }

  // 元数据
  document.getElementById('metaStat').textContent = fmt(s.counters.metaResolved) + ' / ' + fmt(s.counters.metaFailed);
  document.getElementById('metaQueue').textContent = '队列 ' + fmt(s.metaQueue);

  // 系统
  if (s.system) {
    document.getElementById('rss').textContent = fmtMB(s.system.rss);
    document.getElementById('heapDetail').textContent = '堆 ' + fmtMB(s.system.heapUsed) + ' / ' + fmtMB(s.system.heapTotal);
    document.getElementById('sysUptime').textContent = fmt(s.system.uptime) + 's';
    document.getElementById('sysPlatform').textContent = s.system.platform + ' / ' + s.system.nodeVersion;
  }

  // 健康度
  updateHealth(s.health);
  document.getElementById('uptimeText').textContent = s.mode === 'off' ? '—' : ('运行 ' + s.uptimeSec + 's');

  // 速率图
  var labels = s.perMinute.map(function(b){ return new Date(b.t).toTimeString().slice(0,5); });
  var data = s.perMinute.map(function(b){ return b.c; });
  var ctx = document.getElementById('rateChart').getContext('2d');
  if (rateChart) rateChart.destroy();
  rateChart = new Chart(ctx, {
    type: 'line',
    data: { labels: labels, datasets: [{ label: 'events/min', data: data, borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.1)', fill: true, pointRadius: 0, borderWidth: 1.5 }] },
    options: { responsive: true, maintainAspectRatio: false, legend: { display: false }, scales: { xAxes: [{ ticks: { fontColor: '#7d8a99', maxTicksLimit: 8 }, gridLines: { color: '#1c2530' } }], yAxes: [{ ticks: { fontColor: '#7d8a99', beginAtZero: true }, gridLines: { color: '#1c2530' } }] } }
  });

  // 来源分布
  var srcHtml = s.sources.map(function(x) {
    var pct = s.sources.length > 0 ? '' : '';
    var color = SRC_COLORS[x.source] || '#c9cbcf';
    return '<div style="margin-bottom:8px"><span class="src-badge src-' + x.source + '">' + x.source + '</span> <span style="float:right">' + fmt(x.c) + '</span><div style="clear:both;margin-top:4px"><div class="bar" style="width:' + Math.min(100, x.c * 2) + 'px;background:' + color + '"></div></div></div>';
  }).join('');
  document.getElementById('sourceList').innerHTML = srcHtml || '<div style="color:#54626f">暂无数据</div>';

  // 实时事件
  var body = document.getElementById('recentBody');
  if (!s.recent.length) { body.innerHTML = '<tr><td colspan="5" style="color:#54626f;text-align:center">暂无数据</td></tr>'; }
  else {
    body.innerHTML = s.recent.map(function(e) {
      var name = e.name && e.name.length > 40 ? e.name.slice(0,40) + '…' : (e.name || e.infohash.slice(0,16) + '…');
      return '<tr><td class="mono">' + fmtTime(e.ts) + '</td><td class="mono">' + esc(e.ip) + '</td><td class="mono" title="' + e.infohash + '">' + e.infohash.slice(0,10) + '…</td><td>' + esc(name) + '</td><td><span class="src-badge src-' + e.source + '">' + e.source + '</span></td></tr>';
    }).join('');
  }
}

function renderNodes(d) {
  var body = document.getElementById('nodesBody');
  document.getElementById('nodeCount').textContent = d.nodes.length ? ('(' + d.nodes.length + ' 个)') : '';
  if (!d.nodes.length) { body.innerHTML = '<tr><td colspan="3" style="color:#54626f;text-align:center">DHT 未运行或暂无节点</td></tr>'; return; }
  body.innerHTML = d.nodes.map(function(n) {
    return '<tr><td class="mono">' + n.id + '</td><td class="mono">' + n.address + '</td><td>' + n.ageSec + 's</td></tr>';
  }).join('');
}

function refresh() {
  fetch('/api/stats').then(function(r){return r.json();}).then(renderStats).catch(function(){});
  fetch('/api/nodes').then(function(r){return r.json();}).then(renderNodes).catch(function(){});
}
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
