'use strict';
/* 第四轮：后台监控 WEBUI 全链路测试。
   采集服务(sim) → 实时统计 API → 仪表盘页面 → 控制接口(start/stop/burst)。
   运行：node tests/admin.js */
process.env.IKWYD_DB = require('path').join(__dirname, '..', 'data', 'admin-test.db');

const db = require('../src/server/db');
const simulator = require('../src/collector/simulator');

const PORT = 18083;
const BASE = `http://localhost:${PORT}`;
let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getJSON(path) { const r = await fetch(BASE + path); return { status: r.status, body: await r.json() }; }
async function postJSON(path, obj) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  return { status: r.status, body: await r.json() };
}

async function main() {
  console.log('== 1. 准备数据并启动（sim 采集模式）==');
  db.open();
  for (const t of ['obs_log', 'observations', 'peers', 'torrents', 'daily_stats', 'torrent_daily', 'country_daily', 'ip_geo', 'track_links', 'meta'])
    db.get().exec(`DROP TABLE IF EXISTS ${t}`);
  db.close(); db.open();
  simulator.simulate({ days: 5, eventsPerDay: 200, ipPoolSize: 200, seed: 99 });

  const { start, getCollector } = require('../src/server/index');
  const server = start(PORT, { collector: 'sim' });
  await sleep(500);

  console.log('== 2. 仪表盘页面 ==');
  const page = await fetch(BASE + '/admin/');
  const html = await page.text();
  ok('仪表盘 200', page.status === 200);
  ok('含实时监控元素', html.includes('每分钟抓取事件') && html.includes('实时事件流') && html.includes('DHT 路由表节点'));
  ok('含采集控制按钮', html.includes('start-sim') && html.includes('start-live') && html.includes('立即灌入'));

  console.log('== 3. 实时统计 API ==');
  const before = db.scalar('SELECT COUNT(*) FROM obs_log');
  await sleep(2600); // sim 每 2s 产生事件
  const after = db.scalar('SELECT COUNT(*) FROM obs_log');
  ok('sim 模式持续产生事件', after > before, `before=${before} after=${after}`);

  const s = await getJSON('/admin/api/stats');
  ok('stats 基本字段', s.status === 200 && s.body.mode === 'sim' && s.body.db.torrents > 0);
  ok('速率统计', typeof s.body.ratePerMin === 'number' && s.body.ratePerMin > 0);
  ok('来源分布含 simulator', s.body.sources.some(x => x.source === 'simulator'));
  ok('每分钟桶序列长度≈30', Array.isArray(s.body.perMinute) && s.body.perMinute.length >= 29);
  ok('实时事件流带资源名', s.body.recent.length > 0 && typeof s.body.recent[0].name === 'string');
  ok('DHT 状态字段存在', s.body.dht && s.body.dht.running === false);

  console.log('== 4. 控制接口 ==');
  const stop = await postJSON('/admin/api/collector', { action: 'stop' });
  ok('停止采集', stop.status === 200 && stop.body.mode === 'off');
  const b0 = db.scalar('SELECT COUNT(*) FROM obs_log');
  await sleep(2400);
  const b1 = db.scalar('SELECT COUNT(*) FROM obs_log');
  ok('停止后不再产生事件', b1 === b0, `b0=${b0} b1=${b1}`);

  const burst = await postJSON('/admin/api/burst', { count: 300 });
  ok('手动灌入 300 条', burst.status === 200 && burst.body.injected === 300);
  const b2 = db.scalar('SELECT COUNT(*) FROM obs_log');
  ok('灌入已入库', b2 - b1 === 300, `delta=${b2 - b1}`);

  const startSim = await postJSON('/admin/api/collector', { action: 'start-sim' });
  ok('重启 sim', startSim.status === 200 && startSim.body.mode === 'sim');
  await sleep(2200);
  const b3 = db.scalar('SELECT COUNT(*) FROM obs_log');
  ok('重启后恢复产出', b3 > b2);

  const bad = await postJSON('/admin/api/collector', { action: 'bogus' });
  ok('非法 action 拒绝', bad.status === 400 && bad.body.error === 'INVALID_ACTION');

  const nodes = await getJSON('/admin/api/nodes');
  ok('节点接口结构', nodes.status === 200 && Array.isArray(nodes.body.nodes));

  console.log('== 5. 独立监控 WebUI（静态资源 + 全面板数据）==');
  const monitor = require('../src/server/monitor');
  const MONITOR_PORT = 18090;
  monitor.init(getCollector(), PORT, MONITOR_PORT);
  monitor.start(MONITOR_PORT);
  await sleep(300);
  const MB = `http://localhost:${MONITOR_PORT}`;

  // 5.1 静态资源（Chart.js 等）—— 核心 bug 回归防护
  const chartJs = await fetch(MB + '/assets/js/chart.umd.min.js');
  ok('监控WebUI 提供 Chart.js 静态资源', chartJs.status === 200 && chartJs.headers.get('content-type').includes('javascript'),
    `status=${chartJs.status} type=${chartJs.headers.get('content-type')}`);
  const chartBody = await chartJs.text();
  ok('Chart.js 内容非空', chartBody.length > 10000, `len=${chartBody.length}`);

  // 5.2 仪表盘页面
  const dashPage = await fetch(MB + '/');
  ok('监控仪表盘 200', dashPage.status === 200);
  const dashHtml = await dashPage.text();
  ok('仪表盘含 24h 趋势按钮', dashHtml.includes('data-mins="1440"') && dashHtml.includes('24h'));

  // 5.3 /api/stats 轻量面板数据完整性（重图表数据已拆分到 /api/charts）
  const ms = await fetch(MB + '/api/stats?mins=60').then(r => r.json());
  ok('stats 含 meta 元数据进度', ms.meta && typeof ms.meta.total === 'number' && typeof ms.meta.withMeta === 'number');
  ok('stats 含 meta.versions 版本分布', ms.meta.versions && typeof ms.meta.versions.v1 === 'number');
  ok('stats 含 ipv6 统计', ms.ipv6 && typeof ms.ipv6.pct === 'number');
  ok('stats 含 system 系统资源', ms.system && typeof ms.system.rss === 'number');
  ok('stats 含 health 健康度', typeof ms.health === 'number');

  // 5.3b /api/charts 重量图表数据（分步加载端点）
  const mc = await fetch(MB + '/api/charts?mins=60').then(r => r.json());
  ok('charts 含 perMinuteBySource', Array.isArray(mc.perMinuteBySource) && mc.perMinuteBySource.length > 0);
  ok('charts 含 sources 来源分布', Array.isArray(mc.sources));
  ok('charts 含 topCountries', Array.isArray(mc.topCountries));

  // 5.4 24h 趋势查询（小时桶优化）
  const ms24 = await fetch(MB + '/api/charts?mins=1440').then(r => r.json());
  ok('24h 趋势返回小时桶（<=30 个）', ms24.perMinuteBySource.length <= 30 && ms24.perMinuteBySource.length > 0,
    `len=${ms24.perMinuteBySource.length}`);

  // 5.4b /api/trackers 全量 tracker 详情（存活排序在前）
  const mt = await fetch(MB + '/api/trackers').then(r => r.json());
  ok('trackers 接口返回全量列表', Array.isArray(mt.list) && typeof mt.total === 'number');
  if (mt.list.length > 1) {
    const rank = (a) => a.alive === true ? 0 : a.alive === false ? 2 : 1;
    let sorted = true;
    for (let i = 1; i < mt.list.length; i++) if (rank(mt.list[i]) < rank(mt.list[i - 1])) { sorted = false; break; }
    ok('tracker 列表存活在前死亡在后', sorted);
  }

  // 5.5 /api/nodes
  const mnodes = await fetch(MB + '/api/nodes').then(r => r.json());
  ok('监控 nodes 接口', Array.isArray(mnodes.nodes));

  monitor.stop();

  getCollector().stop();
  server.close();
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failures.length) failures.forEach(f => console.log('  - ' + f));
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('Admin 测试异常:', e); process.exit(1); });
