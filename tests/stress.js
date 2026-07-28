'use strict';
/* 第二轮：压力与边界测试。
   大规模数据（45 天 × 1500 事件/天 × 3000 IP）+ 边界场景（空数据 IP、XSS 名称、base32 哈希、CIDR /18）。
   运行：node tests/stress.js */
process.env.IKWYD_DB = require('path').join(__dirname, '..', 'data', 'stress.db');

const db = require('../src/server/db');
const simulator = require('../src/collector/simulator');
const { normalizeInfohash, magnetURI } = require('../src/common/util');
const pipeline = require('../src/collector/pipeline');

const PORT = 18081;
const BASE = `http://localhost:${PORT}`;
let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}
async function getJSON(path) { const r = await fetch(BASE + path); return { status: r.status, body: await r.json() }; }
async function getText(path) { const r = await fetch(BASE + path); return { status: r.status, text: await r.text() }; }

async function main() {
  console.log('== 1. 大规模数据灌入 ==');
  db.open();
  for (const t of ['obs_log', 'observations', 'peers', 'torrents', 'daily_stats', 'torrent_daily', 'country_daily', 'ip_geo', 'track_links', 'meta'])
    db.get().exec(`DROP TABLE IF EXISTS ${t}`);
  db.close(); db.open();

  const t0 = Date.now();
  const sim = simulator.simulate({ days: 45, eventsPerDay: 1500, ipPoolSize: 3000, seed: 777 });
  const ingestMs = Date.now() - t0;
  console.log(`  事件 ${sim.events} 条，灌入耗时 ${ingestMs}ms（${Math.round(sim.events / ingestMs * 1000)}/s）`);
  ok('灌入吞吐 > 5000 事件/s', sim.events / ingestMs * 1000 > 5000);

  // XSS 种子名 + 特殊字符
  const xssName = '<script>alert(1)</script> & "quotes" Movie.2024.1080p.WEB-DL';
  const xssHash = 'ab'.repeat(20);
  pipeline.upsertTorrentMeta({ infohash: xssHash, name: xssName, size: 1e9, category: 'Movies', first_seen: Date.now() - 86400000, last_seen: Date.now() });
  pipeline.ingest({ ip: '198.51.100.23', infohash: xssHash, ts: Date.now(), source: 'test' });

  const { start } = require('../src/server/index');
  const server = start(PORT);
  await new Promise(r => setTimeout(r, 400));

  console.log('== 2. 性能断言 ==');
  const busyIp = db.get().prepare('SELECT ip, SUM(hits) c FROM observations GROUP BY ip ORDER BY c DESC LIMIT 1').get().ip;
  let t1 = Date.now();
  const hist = await getJSON(`/api/history/peer?ip=${busyIp}&days=45&contents=500`);
  const apiMs = Date.now() - t1;
  ok(`Peer API P1 延迟 ${apiMs}ms < 500ms`, hist.status === 200 && apiMs < 500);
  t1 = Date.now();
  const daily = await getText('/en/stat/daily');
  const pageMs = Date.now() - t1;
  ok(`日统计页渲染 ${pageMs}ms < 1000ms`, daily.status === 200 && pageMs < 1000);
  t1 = Date.now();
  const summary = await getJSON(`/api/content/summary?day=${db.get().prepare('SELECT MAX(day) d FROM daily_stats').get().d}`);
  const sumMs = Date.now() - t1;
  ok(`Content summary ${sumMs}ms < 2000ms`, summary.status === 200 && sumMs < 2000);

  console.log('== 3. 边界与健壮性 ==');
  const empty = await getText('/en/peer/?ip=203.0.113.99');
  ok('无数据 IP 页面提示', empty.status === 200 && empty.text.includes('no data about torrents'));
  const badPage = await getText('/en/peer/?ip=not-an-ip');
  ok('非法 IP 页面安全降级', badPage.status === 200 || badPage.status === 404);

  const xssPage = await getText('/en/peer/?ip=198.51.100.23');
  ok('种子名 XSS 已转义', !xssPage.text.includes('<script>alert(1)</script>') && xssPage.text.includes('&lt;script&gt;'));
  const xssTorrent = await getJSON(`/api/torrent/info/${xssHash}`);
  ok('API 返回原始名称（JSON 不需要转义）', xssTorrent.body.torrentName === xssName);
  ok('magnet dn 参数已 URL 编码', !xssTorrent.body.magnet.includes('<script>'));

  // base32 infohash 规范化
  const ih40 = '77a9f4566ce5dd5ca6445300de50ec2f76d6b005';
  const { base32Encode } = require('../src/common/util');
  ok('40hex 规范化', normalizeInfohash(ih40) === ih40);
  // 权威向量（与 Python base64.b32encode 一致）
  ok('base32 规范化(权威向量)', normalizeInfohash('O6U7IVTM4XOVZJSEKMAN4UHMF53NNMAF') === ih40);
  ok('base32 往返', normalizeInfohash(base32Encode(Buffer.from(ih40, 'hex'))) === ih40);
  ok('非法哈希返回 null', normalizeInfohash('xyz') === null && normalizeInfohash('') === null);
  ok('magnet 构造', magnetURI(ih40).startsWith('magnet:?xt=urn:btih:' + ih40));

  // CIDR /18 上限
  const cidr = await getJSON(`/api/history/peers?cidr=${busyIp.split('.')[0]}.0.0.0/18`);
  ok('CIDR /18 可查询', cidr.status === 200);
  const cidrBad = await getJSON('/api/history/peers?cidr=1.2.3.4/17');
  ok('CIDR /17 被拒绝', cidrBad.status === 400 && cidrBad.body.error === 'INVALID_CIDR');

  // 未知种子页应为 404
  const t404 = await getText('/en/torrent/' + 'ff'.repeat(20) + '/x');
  ok('未知种子页 404', t404.status === 404);

  // days 参数边界
  const badDays = await getJSON(`/api/history/peer?ip=${busyIp}&days=99999`);
  ok('days 超限被拒', badDays.status === 400);

  server.close();
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failures.length) failures.forEach(f => console.log('  - ' + f));
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('Stress 运行异常:', e); process.exit(1); });
