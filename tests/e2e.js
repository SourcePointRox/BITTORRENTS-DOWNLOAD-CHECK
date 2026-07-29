'use strict';
/* 全链路 E2E 测试：
   独立测试库 → 模拟采集 → 启动服务 → HTTP 断言（API/页面/短链闭环/错误处理）。
   运行：node tests/e2e.js ；退出码 0=全部通过。 */
process.env.IKWYD_DB = require('path').join(__dirname, '..', 'data', 'test.db');

const db = require('../src/server/db');
const simulator = require('../src/collector/simulator');

const PORT = 18080;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function getJSON(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json() };
}
async function getText(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function main() {
  console.log('== 1. 准备独立测试库并模拟采集 ==');
  db.open();
  const tables = ['obs_log', 'observations', 'peers', 'torrents', 'daily_stats', 'torrent_daily', 'country_daily', 'ip_geo', 'track_links', 'meta'];
  for (const t of tables) db.get().exec(`DROP TABLE IF EXISTS ${t}`);
  db.close(); db.open();

  const sim = simulator.simulate({ days: 20, eventsPerDay: 400, ipPoolSize: 500, seed: 42 });
  ok('模拟器生成数据', sim.events > 5000 && sim.torrents >= 50, JSON.stringify(sim));
  ok('观测事件入库', db.scalar('SELECT COUNT(*) FROM obs_log') === sim.events);
  ok('日聚合生效', db.scalar('SELECT COUNT(*) FROM daily_stats') > 100);

  // 选一个数据丰富的 IP（模拟器设计：前 30 个 IP 为重度用户）
  const busyIp = db.get().prepare('SELECT ip, SUM(hits) c FROM observations GROUP BY ip ORDER BY c DESC LIMIT 1').get().ip;
  const oneHash = db.get().prepare('SELECT infohash FROM observations WHERE ip=? LIMIT 1').get(busyIp).infohash;
  const imdbId = db.get().prepare("SELECT imdb_id FROM torrents WHERE imdb_id IS NOT NULL LIMIT 1").get().imdb_id;
  const latestDay = db.get().prepare('SELECT MAX(day) d FROM daily_stats').get().d;

  console.log('== 2. 启动服务 ==');
  const { start } = require('../src/server/index');
  const server = start(PORT);
  await new Promise(r => setTimeout(r, 500));

  console.log('== 3. API: 官方结构 + 增强字段 ==');
  const ov = await getJSON('/api/overview');
  ok('/api/overview 总量正确', ov.status === 200 && ov.body.totalTorrents >= 50 && ov.body.totalPeers === 500);

  const hist = await getJSON(`/api/history/peer?ip=${busyIp}&days=30&contents=100`);
  ok('/api/history/peer 200', hist.status === 200);
  ok('官方字段完整 (isp/geoData/hasPorno)', hist.body.isp !== undefined && hist.body.geoData && typeof hist.body.hasPorno === 'boolean');
  const c0 = hist.body.contents[0];
  ok('contents 非空', hist.body.contents.length > 0);
  ok('content 含官方字段 (category/name/startDate/endDate)',
    c0.category !== undefined && c0.name !== undefined && c0.startDate && c0.endDate);
  ok('torrent.infohash 为 40 位 hex', /^[0-9a-f]{40}$/.test(c0.torrent.infohash));
  ok('torrent.magnet 与 infohash 一致', c0.torrent.magnet.startsWith('magnet:?xt=urn:btih:' + c0.torrent.infohash));
  ok('顶层 magnet 冗余字段存在', typeof c0.magnet === 'string' && c0.magnet.startsWith('magnet:'));
  ok('firstSeen (最早记录) 存在且不晚于 endDate',
    !!c0.firstSeen && Date.parse(c0.firstSeen) <= Date.parse(c0.endDate));
  ok('startDate <= endDate', hist.body.contents.every(c => Date.parse(c.startDate) <= Date.parse(c.endDate)));

  const badIp = await getJSON('/api/history/peer?ip=999.1.1.1');
  ok('非法 IP 返回 INVALID_IP', badIp.status === 400 && badIp.body.error === 'INVALID_IP');

  const exist = await getJSON(`/api/history/exist?ip=${busyIp}`);
  ok('/api/history/exist 命中', exist.body.exists === true && !!exist.body.date);
  const notExist = await getJSON('/api/history/exist?ip=203.0.113.250');
  ok('/api/history/exist 未命中', notExist.body.exists === false);

  const parts = busyIp.split('.').slice(0, 3).join('.');
  const cidrRes = await getJSON(`/api/history/peers?cidr=${parts}.0/24`);
  ok('/api/history/peers CIDR 查询', cidrRes.status === 200 && cidrRes.body.peers.some(p => p.ip === busyIp));

  const tinfo = await getJSON(`/api/torrent/info/${oneHash}`);
  ok('/api/torrent/info 200', tinfo.status === 200);
  ok('torrent 含 magnet+dateAdded+firstSeen+files',
    tinfo.body.magnet.includes(oneHash) && !!tinfo.body.dateAdded && !!tinfo.body.firstSeen && Array.isArray(tinfo.body.files));
  ok('dateAdded 即最早记录发布时间', Date.parse(tinfo.body.dateAdded) <= Date.now());

  const noHash = await getJSON('/api/torrent/info/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  ok('未知 infohash 返回 INFOHASH_NOT_FOUND', noHash.status === 404 && noHash.body.error === 'INFOHASH_NOT_FOUND');

  const tpeers = await getJSON(`/api/torrent/peers/${oneHash}?day=${latestDay}`);
  ok('/api/torrent/peers 报告', tpeers.status === 200 && tpeers.body.totalPeers >= 0 && Array.isArray(tpeers.body.countries));

  const imdbList = await getJSON(`/api/torrent/list/imdb/${imdbId}`);
  ok('/api/torrent/list/imdb', imdbList.status === 200 && imdbList.body.torrents.length > 0 && imdbList.body.torrents.every(t => t.magnet.startsWith('magnet:')));

  const summary = await getJSON(`/api/content/summary?day=${latestDay}`);
  ok('/api/content/summary', summary.status === 200 && summary.body.totalPeers > 0 && summary.body.contents.length > 0);
  const downloads = await getJSON(`/api/content/downloads?day=${latestDay}`);
  ok('/api/content/downloads', downloads.status === 200 && downloads.body.totalDownloads > 0);

  const statDaily = await getJSON(`/api/stat/daily?date=${latestDay}`);
  ok('/api/stat/daily', statDaily.status === 200 && statDaily.body.categories.length > 0);

  console.log('== 4. 页面 SSR ==');
  const home = await fetch(BASE + '/', { redirect: 'manual' });
  ok('首页 302 到 peer 页', home.status === 302 && (home.headers.get('location') || '').startsWith('/en/peer/?ip='));

  const peerPage = await getText(`/en/peer/?ip=${busyIp}`);
  ok('peer 页标题', peerPage.text.includes(`Torrent downloads and distributions for IP ${busyIp}`));
  ok('peer 页地理标签', peerPage.text.includes('badge bg-primary'));
  ok('peer 页含 Info hash 列', peerPage.text.includes('Info hash'));
  ok('peer 页含 Magnet 列', peerPage.text.includes('>Magnet<'));
  ok('peer 页含 Published (UTC) 列（最早记录发布时间）', peerPage.text.includes('Published (UTC)'));
  ok('peer 页表格含磁力链接', peerPage.text.includes('magnet:?xt=urn:btih:'));
  ok('peer 页表格含完整 infohash', peerPage.text.includes(oneHash.slice(0, 12)));
  ok('peer 页相似 IP 段落', peerPage.text.includes('similar IPs') || peerPage.text.includes('none yet'));
  ok('peer 页官方文案 (spy link)', peerPage.text.includes('spy on them via special generated link'));

  const daily = await getText('/en/stat/daily');
  ok('日统计页标题', daily.text.includes('Daily Torrents Statistics'));
  ok('日统计页饼图容器', daily.text.includes('chart-area'));
  ok('日统计页三项比率', daily.text.includes('per million population download Torrents daily') && daily.text.includes('of population have Internet'));
  ok('日统计页 Top 选项卡', daily.text.includes('Top Torrents') && daily.text.includes('Top Movies') && daily.text.includes('Top XXX') && daily.text.includes('Top Games') && daily.text.includes('Top Software') && daily.text.includes('Top Music'));
  ok('日统计页国家/日期弹窗', daily.text.includes('countryModal') && daily.text.includes('dayModal'));
  ok('日统计页海报墙', daily.text.includes('Top 12 Movies') && daily.text.includes('Top 12 Series'));

  const cnDaily = await getText(`/en/stat/CN/daily/q?statDate=${latestDay}`);
  ok('分国家日统计页', cnDaily.status === 200 && cnDaily.text.includes('Daily Torrents Statistics in'));

  const annual = await getText('/en/stat/annual');
  ok('年度统计页', annual.status === 200 && annual.text.includes('Annual Torrents Statistics') && annual.text.includes('annual-chart'));

  const tpage = await getText(`/en/torrent/${oneHash}/some_slug`);
  ok('种子详情页 200', tpage.status === 200);
  ok('种子页 Info hash + Magnet link', tpage.text.includes('Info hash') && tpage.text.includes('Magnet link') && tpage.text.includes('magnet:?xt=urn:btih:' + oneHash));
  ok('种子页 First recorded (published)', tpage.text.includes('First recorded (published)'));
  ok('种子页 peer 曲线 + 最近 peer 表', tpage.text.includes('Peers per day') && tpage.text.includes('Recent peers'));
  ok('种子页文件列表', tpage.text.includes('Files ('));

  const apiPage = await getText('/en/api/');
  ok('API 文档页', apiPage.status === 200 && apiPage.text.includes('/api/history/peer') && apiPage.text.includes('/api/torrent/info/'));
  const contacts = await getText('/en/contacts/');
  ok('About Us 页', contacts.status === 200 && contacts.text.includes('About Us'));
  const notFound = await getText('/en/whatever/');
  ok('404 页', notFound.status === 404 && notFound.text.includes('Page not found'));

  console.log('== 5. Track Downloads 短链闭环 ==');
  const form = new URLSearchParams({ url: 'https://example.com/news' }).toString();
  const create = await fetch(BASE + '/en/link/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const createText = await create.text();
  const tokenMatch = createText.match(/\/link\/go\/([0-9a-f]{16})/);
  ok('生成追踪链接', !!tokenMatch);
  const token = tokenMatch[1];
  const checkBefore = await getJSON(`/link/check/${token}`);
  ok('访问前 visited=false', checkBefore.body.visited === false);
  const go = await fetch(BASE + `/link/go/${token}`, { redirect: 'manual' });
  ok('短链 302 跳转目标', go.status === 302 && go.headers.get('location') === 'https://example.com/news');
  const checkAfter = await getJSON(`/link/check/${token}`);
  ok('访问后 visited=true 且带 visitorIp', checkAfter.body.visited === true && typeof checkAfter.body.visitorIp === 'string');

  console.log('== 6. 其他端点 ==');
  const key = await fetch(BASE + '/en/createKey', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=test%40example.com' });
  const keyBody = await key.json();
  ok('Demo Key 签发', keyBody.success === true && keyBody.message.includes('IKWYD-DEMO-'));
  const poster = await getText(`/poster/${imdbId}?t=Test`);
  ok('动态海报 SVG', poster.status === 200 && (poster.headers.get('content-type') || '').includes('image/svg'));
  const css = await getText('/assets/css/v2.css');
  ok('静态资源', css.status === 200 && css.text.includes('header-torrents'));

  server.close();
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('E2E 运行异常:', e); process.exit(1); });
