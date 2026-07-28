'use strict';
/* 后台监控 WEBUI：/admin/ —— 数据抓取与 DHT 节点连接状态的可视化面板。 */
const db = require('./db');
const { esc, formatSize, fmtUTC } = require('../common/util');

let service = null;
function init(svc) { service = svc; }

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

/* 时间桶统计：最近 minutes 分钟内每分钟事件数 */
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

/* 来源分布 */
function sourceBreakdown() {
  return db.get().prepare('SELECT source, COUNT(*) AS c FROM obs_log GROUP BY source ORDER BY c DESC').all();
}

/* 最近事件（带种子名） */
function recentNamed(recent) {
  const d = db.get();
  const stmt = d.prepare('SELECT name FROM torrents WHERE infohash=?');
  return recent.map(e => {
    const t = stmt.get(e.infohash);
    return { ...e, name: (t && t.name) || e.infohash.slice(0, 16) + '…' };
  });
}

async function route(req, res, pathname, query, readBody) {
  if (!service) { json(res, 503, { error: 'collector service not initialized' }); return true; }

  if (pathname === '/admin/' || pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml());
    return true;
  }
  if (pathname === '/admin/api/stats') {
    const s = service.getStats();
    s.recent = recentNamed(s.recent);
    s.perMinute = perMinuteBuckets(30);
    s.sources = sourceBreakdown();
    json(res, 200, s);
    return true;
  }
  if (pathname === '/admin/api/nodes') {
    json(res, 200, service.getNodes());
    return true;
  }
  if (pathname === '/admin/api/collector' && req.method === 'POST') {
    const body = await readBody(req);
    let action = '';
    try { action = JSON.parse(body).action; } catch (_) {}
    let result;
    if (action === 'start-sim') result = service.startSim();
    else if (action === 'start-live') result = service.startLive({ tracker: true });
    else if (action === 'stop') result = service.stop();
    else { json(res, 400, { error: 'INVALID_ACTION', message: 'action must be start-sim | start-live | stop' }); return true; }
    json(res, 200, result);
    return true;
  }
  if (pathname === '/admin/api/burst' && req.method === 'POST') {
    const body = await readBody(req);
    let count = 100;
    try { count = Math.min(Math.max(parseInt(JSON.parse(body).count, 10) || 100, 1), 100000); } catch (_) {}
    json(res, 200, service.burst(count));
    return true;
  }
  return false; // 非 admin 路由
}

/* ---------- 仪表盘页面（暗色后台风格） ---------- */
function dashboardHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IKWYD Collector Admin</title>
<link rel="stylesheet" href="/assets/css/bootstrap.min.css">
<link rel="stylesheet" href="/assets/css/font-awesome.min.css">
<script src="/assets/js/jquery.min.js"></script>
<script src="/assets/js/bootstrap.min.js"></script>
<script src="/assets/js/chart.bundle.min.js"></script>
<style>
  body { background: #0f1419; color: #d7dde4; font-family: "Segoe UI", Arial, sans-serif; }
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 22px; background: #161d27; border-bottom: 1px solid #232c38; }
  .topbar h1 { font-size: 18px; margin: 0; color: #e8eef5; }
  .topbar h1 .fa { color: #36a2eb; margin-right: 8px; }
  .badge-mode { font-size: 12px; padding: 4px 12px; border-radius: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .badge-off { background: #37424f; color: #aeb8c2; }
  .badge-sim { background: #1f5c35; color: #7dffa9; }
  .badge-live { background: #5c3a1f; color: #ffbe7d; }
  .container-fluid { padding: 20px 22px; }
  .card { background: #161d27; border: 1px solid #232c38; border-radius: 8px; padding: 16px 18px; margin-bottom: 18px; }
  .stat-num { font-size: 26px; font-weight: 700; color: #fff; }
  .stat-label { font-size: 12px; color: #7d8a99; text-transform: uppercase; letter-spacing: .5px; margin-top: 2px; }
  .stat-sub { font-size: 12px; color: #54626f; margin-top: 4px; }
  .card h3 { margin: 0 0 12px; font-size: 14px; color: #9fb0c0; text-transform: uppercase; letter-spacing: .5px; }
  .btn-ctl { margin-right: 8px; }
  table.dark { width: 100%; font-size: 12.5px; }
  table.dark th { color: #7d8a99; font-weight: 600; text-transform: uppercase; font-size: 11px; padding: 6px 8px; border-bottom: 1px solid #232c38; }
  table.dark td { padding: 5px 8px; border-bottom: 1px solid #1a2230; color: #c3ccd6; vertical-align: middle; }
  table.dark tr:hover td { background: #18202c; }
  .mono { font-family: Consolas, monospace; font-size: 12px; }
  .src-badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .src-simulator { background: #24425c; color: #7dc4ff; }
  .src-dht_passive { background: #3d2a5c; color: #c49aff; }
  .src-dht_active { background: #2a5c46; color: #8affc1; }
  .src-tracker { background: #5c4a24; color: #ffd77d; }
  .src-pex { background: #5c2424; color: #ff9a9a; }
  a { color: #6db3f2; }
  .chart-box { position: relative; height: 220px; }
  .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .pulse-on { background: #4caf50; box-shadow: 0 0 6px #4caf50; }
  .pulse-off { background: #555; }
  .form-inline .form-control { background: #0f1419; border: 1px solid #2a3542; color: #d7dde4; }
</style>
</head>
<body>
<div class="topbar">
  <h1><i class="fa fa-satellite-dish"></i>IKWYD Collector Admin</h1>
  <div>
    <span id="modeBadge" class="badge-mode badge-off">OFF</span>
    <a class="btn btn-default btn-xs" href="/" target="_blank" style="margin-left:10px"><i class="fa fa-external-link"></i> 打开站点</a>
  </div>
</div>

<div class="container-fluid">
  <!-- 控制 -->
  <div class="card">
    <div class="form-inline">
      <span class="pulse pulse-off" id="pulse"></span><span id="uptime" class="grey-text">collector stopped</span>
      <span style="float:right">
        <button class="btn btn-success btn-sm btn-ctl" onclick="ctl('start-sim')"><i class="fa fa-play"></i> 启动模拟采集</button>
        <button class="btn btn-warning btn-sm btn-ctl" onclick="ctl('start-live')"><i class="fa fa-broadcast-tower"></i> 启动真实 DHT 采集</button>
        <button class="btn btn-danger btn-sm btn-ctl" onclick="ctl('stop')"><i class="fa fa-stop"></i> 停止</button>
        <input type="number" id="burstCount" class="form-control input-sm" value="200" style="width:90px" min="1" max="100000">
        <button class="btn btn-info btn-sm" onclick="burst()"><i class="fa fa-bolt"></i> 立即灌入</button>
      </span>
    </div>
  </div>

  <!-- 统计卡片 -->
  <div class="row" id="statCards"></div>

  <div class="row">
    <div class="col-md-8">
      <div class="card"><h3>每分钟抓取事件（近 30 分钟）</h3><div class="chart-box"><canvas id="rateChart"></canvas></div></div>
    </div>
    <div class="col-md-4">
      <div class="card"><h3>事件来源分布</h3><div class="chart-box"><canvas id="srcChart"></canvas></div></div>
    </div>
  </div>

  <div class="row">
    <div class="col-md-7">
      <div class="card">
        <h3>实时事件流（最近 30 条）</h3>
        <table class="dark">
          <thead><tr><th>时间</th><th>IP</th><th>Infohash</th><th>资源名</th><th>来源</th></tr></thead>
          <tbody id="recentBody"><tr><td colspan="5" style="color:#54626f">暂无数据</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="col-md-5">
      <div class="card">
        <h3>DHT 路由表节点 <span id="nodeCount" class="stat-sub"></span></h3>
        <div style="max-height:420px;overflow-y:auto">
        <table class="dark">
          <thead><tr><th>Node ID</th><th>地址</th><th>最后活跃</th></tr></thead>
          <tbody id="nodesBody"><tr><td colspan="3" style="color:#54626f">DHT 未运行</td></tr></tbody>
        </table>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
var rateChart = null, srcChart = null;
var SRC_COLORS = { simulator: '#36a2eb', dht_passive: '#9966ff', dht_active: '#4bc0c0', tracker: '#ff9f40', pex: '#ff6384', dht_sample: '#c9cbcf', test: '#c9cbcf' };

function fmtNum(n) { return (n || 0).toLocaleString('en-US'); }
function fmtTime(ts) { var d = new Date(ts); return d.toTimeString().slice(0, 8); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function ctl(action) {
  fetch('/admin/api/collector', { method: 'POST', body: JSON.stringify({ action: action }) })
    .then(function (r) { return r.json(); }).then(function () { refresh(); });
}
function burst() {
  var count = parseInt(document.getElementById('burstCount').value, 10) || 100;
  fetch('/admin/api/burst', { method: 'POST', body: JSON.stringify({ count: count }) })
    .then(function (r) { return r.json(); }).then(function () { refresh(); });
}

function renderCards(s) {
  var dht = s.dht;
  var cards = [
    ['种子总数', fmtNum(s.db.torrents), '新增 ' + fmtNum(s.counters.newTorrents)],
    ['IP 节点', fmtNum(s.db.peers), ''],
    ['观测事件', fmtNum(s.db.obsLog), '今日 ' + fmtNum(s.todayEvents)],
    ['速率/分钟', fmtNum(s.ratePerMin), '会话累计 ' + fmtNum(s.counters.ingested)],
    ['DHT 节点', dht.running ? fmtNum(dht.nodes) : '—', dht.running ? ('rx ' + fmtNum(dht.rx) + ' / tx ' + fmtNum(dht.tx)) : '未运行'],
    ['DHT 捕获', dht.running ? fmtNum(dht.peers + dht.announces) : '—', dht.running ? ('peers ' + fmtNum(dht.peers) + ' / announce ' + fmtNum(dht.announces)) : '元数据队列 ' + s.metaQueue],
  ];
  document.getElementById('statCards').innerHTML = cards.map(function (c) {
    return '<div class="col-xs-6 col-sm-4 col-md-2"><div class="card"><div class="stat-num">' + c[1] +
      '</div><div class="stat-label">' + c[0] + '</div><div class="stat-sub">' + (c[2] || '&nbsp;') + '</div></div></div>';
  }).join('');

  var badge = document.getElementById('modeBadge');
  badge.className = 'badge-mode badge-' + s.mode;
  badge.textContent = s.mode.toUpperCase();
  var pulse = document.getElementById('pulse');
  pulse.className = 'pulse ' + (s.mode === 'off' ? 'pulse-off' : 'pulse-on');
  document.getElementById('uptime').textContent = s.mode === 'off' ? 'collector stopped' : ('running ' + s.uptimeSec + 's · 元数据已解析 ' + s.counters.metaResolved + ' / 失败 ' + s.counters.metaFailed);
}

function renderCharts(s) {
  var labels = s.perMinute.map(function (b) { return fmtTime(b.t).slice(0, 5); });
  var data = s.perMinute.map(function (b) { return b.c; });
  if (rateChart) { rateChart.destroy(); }
  rateChart = new Chart(document.getElementById('rateChart').getContext('2d'), {
    type: 'line',
    data: { labels: labels, datasets: [{ label: 'events/min', data: data, borderColor: '#36a2eb', backgroundColor: 'rgba(54,162,235,0.12)', fill: true, pointRadius: 0, borderWidth: 1.5 }] },
    options: {
      responsive: true, maintainAspectRatio: false, legend: { display: false },
      scales: { xAxes: [{ ticks: { fontColor: '#7d8a99', maxTicksLimit: 10 }, gridLines: { color: '#1c2530' } }], yAxes: [{ ticks: { fontColor: '#7d8a99', beginAtZero: true }, gridLines: { color: '#1c2530' } }] }
    }
  });
  var sl = s.sources.map(function (x) { return x.source + ' (' + x.c + ')'; });
  var sd = s.sources.map(function (x) { return x.c; });
  var sc = s.sources.map(function (x) { return SRC_COLORS[x.source] || '#c9cbcf'; });
  if (srcChart) { srcChart.destroy(); }
  srcChart = new Chart(document.getElementById('srcChart').getContext('2d'), {
    type: 'doughnut',
    data: { labels: sl, datasets: [{ data: sd, backgroundColor: sc }] },
    options: { responsive: true, maintainAspectRatio: false, legend: { position: 'bottom', labels: { fontColor: '#9fb0c0', boxWidth: 12, fontSize: 11 } } }
  });
}

function renderRecent(s) {
  var body = document.getElementById('recentBody');
  if (!s.recent.length) { body.innerHTML = '<tr><td colspan="5" style="color:#54626f">暂无数据</td></tr>'; return; }
  body.innerHTML = s.recent.map(function (e) {
    var name = e.name.length > 42 ? e.name.slice(0, 42) + '…' : e.name;
    return '<tr><td class="mono">' + fmtTime(e.ts) + '</td>' +
      '<td class="mono"><a href="/en/peer/?ip=' + e.ip + '" target="_blank">' + e.ip + '</a></td>' +
      '<td class="mono" title="' + e.infohash + '">' + e.infohash.slice(0, 10) + '…</td>' +
      '<td title="' + esc(e.name) + '"><a href="/en/torrent/' + e.infohash + '/x" target="_blank">' + esc(name) + '</a></td>' +
      '<td><span class="src-badge src-' + e.source + '">' + e.source + '</span></td></tr>';
  }).join('');
}

function refreshNodes() {
  fetch('/admin/api/nodes').then(function (r) { return r.json(); }).then(function (d) {
    var body = document.getElementById('nodesBody');
    document.getElementById('nodeCount').textContent = d.nodes.length ? ('共 ' + d.nodes.length + ' 个') : '';
    if (!d.nodes.length) { body.innerHTML = '<tr><td colspan="3" style="color:#54626f">DHT 未运行或暂无节点</td></tr>'; return; }
    body.innerHTML = d.nodes.map(function (n) {
      return '<tr><td class="mono">' + n.id + '</td><td class="mono">' + n.address + '</td><td>' + n.ageSec + 's 前</td></tr>';
    }).join('');
  });
}

function refresh() {
  fetch('/admin/api/stats').then(function (r) { return r.json(); }).then(function (s) {
    renderCards(s); renderCharts(s); renderRecent(s);
  });
  refreshNodes();
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

module.exports = { init, route };
