'use strict';
/* 冷存储独立进程入口：node scripts/cold-storage-worker.js
   用法：
     node scripts/cold-storage-worker.js                       # 默认 10s 轮询
     node scripts/cold-storage-worker.js --poll 5000           # 5s 轮询
     node scripts/cold-storage-worker.js --db /path/cold.db    # 指定冷库路径
     node scripts/cold-storage-worker.js --main-db /path/main.db  # 指定主库路径
*/
const { startWorker } = require('../src/collector/cold-storage');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const opts = {};
const poll = arg('poll');
if (poll) opts.pollInterval = Number(poll);
const db = arg('db');
if (db) opts.dbPath = db;
const mainDb = arg('main-db');
if (mainDb) opts.mainDbPath = mainDb;

startWorker(opts);
