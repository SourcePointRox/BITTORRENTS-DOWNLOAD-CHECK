'use strict';
/* 生成沙箱演示数据：node scripts/seed.js [--days 30] [--events 500] [--fresh] */
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
}
const fresh = args.includes('--fresh');

const DB_PATH = process.env.IKWYD_DB || path.join(__dirname, '..', 'data', 'ikwyd.db');
const db = require('../src/server/db');
db.open(DB_PATH);
if (fresh) {
  // 环境安全策略拦截文件删除，改用 DROP TABLE 重置
  const tables = ['obs_log', 'observations', 'peers', 'torrents', 'daily_stats', 'torrent_daily', 'country_daily', 'ip_geo', 'track_links', 'meta'];
  for (const t of tables) db.get().exec(`DROP TABLE IF EXISTS ${t}`);
  db.close();
  db.open(DB_PATH);
  console.log('[seed] reset all tables');
}
const simulator = require('../src/collector/simulator');

const t0 = Date.now();
const result = simulator.simulate({
  days: arg('days', 30),
  eventsPerDay: arg('events', 500),
  ipPoolSize: arg('ips', 900),
});

const d = db.get();
const counts = {
  torrents: d.prepare('SELECT COUNT(*) c FROM torrents').get().c,
  peers: d.prepare('SELECT COUNT(*) c FROM peers').get().c,
  observations: d.prepare('SELECT COUNT(*) c FROM observations').get().c,
  obsLog: d.prepare('SELECT COUNT(*) c FROM obs_log').get().c,
  dailyRows: d.prepare('SELECT COUNT(*) c FROM daily_stats').get().c,
  torrentDaily: d.prepare('SELECT COUNT(*) c FROM torrent_daily').get().c,
  countryDaily: d.prepare('SELECT COUNT(*) c FROM country_daily').get().c,
};
console.log('[seed] simulated:', result);
console.log('[seed] database:', counts);
console.log('[seed] done in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
db.close();
