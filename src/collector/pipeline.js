'use strict';
/* 采集管道：所有数据源（DHT/Tracker/PEX/模拟器）统一入口。
   事件：{ ip, port?, infohash, ts?, source }
   职责：入库 obs_log → 聚合 peers/observations/torrents → 日粒度统计 → 元数据补全回调。

   长跑优化：
   - seenThisRun / torrentsTouched / peersTouched 每小时清理过期条目（跨日）
   - 写队列批处理：事件先入内存队列，定时批量写入 SQLite，减少锁冲突
   - obs_log 定期 TTL 清理（30 天保留） */
const db = require('../server/db');
const geo = require('../server/geo');
const { fmtDay, normalizeInfohash } = require('../common/util');

const CATEGORIES = ['Movies', 'TV', 'Anime', 'Music', 'Games', 'Software', 'Books', 'XXX', 'Unsorted'];

let stmts = null;
let onNewInfohash = null; // 元数据补全回调（由 metadata fetcher 挂接）

/* 去重 Set：带时间戳，每小时清理过期条目（避免长跑内存无限增长） */
const seenThisRun = new Map();    // key -> ts
const torrentsTouched = new Map(); // key -> ts
const peersTouched = new Map();    // key -> ts
const CLEANUP_INTERVAL = 3600000;   // 1 小时清理一次
const ENTRY_TTL = 90000000;        // 25 小时（跨一天后过期）

/* 写队列：事件先缓冲，定时批量写入减少 SQLite 锁竞争 */
const writeQueue = [];
const WRITE_BATCH_SIZE = 50;
const WRITE_INTERVAL = 500; // 500ms 批量写入
let writeTimer = null;

function init() {
  const d = db.get();
  stmts = {
    insLog: d.prepare('INSERT INTO obs_log(ip,port,infohash,ts,source) VALUES(?,?,?,?,?)'),
    upPeer: d.prepare(`INSERT INTO peers(ip,first_seen,last_seen) VALUES(?,?,?)
                       ON CONFLICT(ip) DO UPDATE SET last_seen=MAX(last_seen, excluded.last_seen)`),
    upObs: d.prepare(`INSERT INTO observations(ip,infohash,first_seen,last_seen,hits) VALUES(?,?,?,?,1)
                      ON CONFLICT(ip,infohash) DO UPDATE SET
                        last_seen=MAX(last_seen, excluded.last_seen), hits=hits+1`),
    getObsPair: d.prepare('SELECT last_seen FROM observations WHERE ip=? AND infohash=?'),
    insTorrent: d.prepare('INSERT OR IGNORE INTO torrents(infohash,first_seen,last_seen) VALUES(?,?,?)'),
    touchTorrent: d.prepare('UPDATE torrents SET last_seen=MAX(COALESCE(last_seen,0), ?) WHERE infohash=?'),
    upTorrentDaily: d.prepare(`INSERT INTO torrent_daily(infohash,day,peers) VALUES(?,?,1)
                               ON CONFLICT(infohash,day) DO UPDATE SET peers=peers+1`),
    upCountryDaily: d.prepare(`INSERT INTO country_daily(cc,day,peers) VALUES(?,?,1)
                               ON CONFLICT(cc,day) DO UPDATE SET peers=peers+1`),
    upDailyStats: d.prepare(`INSERT INTO daily_stats(day,category,downloads) VALUES(?,?,1)
                             ON CONFLICT(day,category) DO UPDATE SET downloads=downloads+1`),
    getCategory: d.prepare('SELECT category FROM torrents WHERE infohash=?'),
  };
}

/* 元数据写入（采集器 metadata.js / 模拟器共用） */
function upsertTorrentMeta(m) {
  const d = db.get();
  d.prepare(`INSERT INTO torrents(infohash,hash_version,infohash_v2,name,size,category,title,imdb_id,
                                    first_seen,last_seen,alive,metadata_ok,files_json,
                                    piece_layers_json,file_tree_json)
             VALUES(@infohash,@hash_version,@infohash_v2,@name,@size,@category,@title,@imdb_id,
                    @first_seen,@last_seen,@alive,@metadata_ok,@files_json,
                    @piece_layers_json,@file_tree_json)
             ON CONFLICT(infohash) DO UPDATE SET
               hash_version=COALESCE(excluded.hash_version, torrents.hash_version),
               infohash_v2=COALESCE(excluded.infohash_v2, torrents.infohash_v2),
               name=COALESCE(excluded.name, torrents.name),
               size=COALESCE(excluded.size, torrents.size),
               category=CASE WHEN excluded.category IS NOT NULL THEN excluded.category ELSE torrents.category END,
               title=COALESCE(excluded.title, torrents.title),
               imdb_id=COALESCE(excluded.imdb_id, torrents.imdb_id),
               first_seen=MIN(COALESCE(torrents.first_seen, excluded.first_seen), COALESCE(excluded.first_seen, torrents.first_seen)),
               last_seen=MAX(COALESCE(torrents.last_seen,0), COALESCE(excluded.last_seen,0)),
               alive=excluded.alive,
               metadata_ok=MAX(torrents.metadata_ok, excluded.metadata_ok),
               files_json=COALESCE(excluded.files_json, torrents.files_json),
               piece_layers_json=COALESCE(excluded.piece_layers_json, torrents.piece_layers_json),
               file_tree_json=COALESCE(excluded.file_tree_json, torrents.file_tree_json)`)
    .run({
      infohash: m.infohash,
      hash_version: m.hash_version ?? 1,
      infohash_v2: m.infohash_v2 ?? null,
      name: m.name ?? null,
      size: m.size ?? null,
      category: m.category ?? null,
      title: m.title ?? null,
      imdb_id: m.imdb_id ?? null,
      first_seen: m.first_seen ?? Date.now(),
      last_seen: m.last_seen ?? Date.now(),
      alive: m.alive ?? 1,
      metadata_ok: m.metadata_ok ? 1 : 0,
      files_json: m.files ? JSON.stringify(m.files) : null,
      piece_layers_json: m.piece_layers ? JSON.stringify(m.piece_layers) : null,
      file_tree_json: m.file_tree ? JSON.stringify(m.file_tree) : null,
    });
}

/* 清理过期的去重条目（防止 Map 无限增长） */
function cleanupExpiredSets() {
  const now = Date.now();
  const expire = (map) => {
    for (const [k, ts] of map) if (now - ts > ENTRY_TTL) map.delete(k);
  };
  expire(seenThisRun);
  expire(torrentsTouched);
  expire(peersTouched);
}

/* 定期启动清理 + obs_log TTL */
let cleanupTimer = null;
function startMaintenance() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupExpiredSets();
    // 每天清理一次 obs_log（保留 30 天）
    try { db.pruneObsLog(30); } catch (_) {}
  }, CLEANUP_INTERVAL);
  cleanupTimer.unref && cleanupTimer.unref();
}

/* 单条观测事件处理（无写队列模式，用于批量或需要立即可见的场景） */
function ingest(ev) {
  const d = db.get();
  if (!stmts) init();
  const infohash = normalizeInfohash(ev.infohash);
  if (!infohash || !ev.ip) return false;
  const ts = ev.ts || Date.now();

  try {
    const day = fmtDay(ts);
    const dayStart = Date.parse(day + 'T00:00:00Z');
    const key = ev.ip + '|' + infohash + '|' + day;
    let firstToday = false;
    if (!seenThisRun.has(key)) {
      seenThisRun.set(key, ts);
      const pair = stmts.getObsPair.get(ev.ip, infohash);
      firstToday = !pair || pair.last_seen < dayStart;
    }

    const tKey = infohash + '|' + day;
    let isNew = false;
    if (!torrentsTouched.has(tKey)) {
      torrentsTouched.set(tKey, ts);
      isNew = stmts.insTorrent.run(infohash, ts, ts).changes > 0;
      if (!isNew) stmts.touchTorrent.run(ts, infohash);
    }
    stmts.insLog.run(ev.ip, ev.port ?? null, infohash, ts, ev.source || 'unknown');
    const pKey = ev.ip + '|' + day;
    if (!peersTouched.has(pKey)) {
      peersTouched.set(pKey, ts);
      stmts.upPeer.run(ev.ip, ts, ts);
    }
    stmts.upObs.run(ev.ip, infohash, ts, ts);

    if (firstToday) {
      stmts.upTorrentDaily.run(infohash, day);
      const catRow = stmts.getCategory.get(infohash);
      stmts.upDailyStats.run(day, (catRow && catRow.category) || 'Unsorted');
      try {
        const g = geo.lookup(ev.ip);
        if (g && g.cc) stmts.upCountryDaily.run(g.cc, day);
      } catch (_) { /* geo 失败不阻断 */ }
    }

    if (isNew && onNewInfohash) {
      try { onNewInfohash(infohash); } catch (_) {}
    }
    return true;
  } catch (e) {
    if (e && e.errcode === 5) return false; // database is locked — skip
    throw e;
  }
}

/* 写队列批量写入：减少 SQLite 锁竞争，提高高并发吞吐 */
function queueIngest(ev) {
  writeQueue.push(ev);
  if (writeQueue.length >= WRITE_BATCH_SIZE) flushQueue();
}

/* 批量刷新写队列 */
function flushQueue() {
  if (writeQueue.length === 0) return;
  const batch = writeQueue.splice(0, WRITE_BATCH_SIZE * 2);
  try {
    const d = db.get();
    d.exec('BEGIN');
    for (const ev of batch) {
      try { ingest(ev); } catch (_) {} // 单条失败不影响整批
    }
    d.exec('COMMIT');
  } catch (e) {
    try { db.get().exec('ROLLBACK'); } catch (_) {}
    // 回退：逐条写入
    for (const ev of batch) { try { ingest(ev); } catch (_) {} }
  }
}

/* 启动写队列定时器 */
function startWriteQueue() {
  if (writeTimer) return;
  writeTimer = setInterval(flushQueue, WRITE_INTERVAL);
  writeTimer.unref && writeTimer.unref();
}

function batch(events) {
  const d = db.get();
  d.exec('BEGIN');
  try {
    for (const ev of events) ingest(ev);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function setMetadataCallback(fn) { onNewInfohash = fn; }

/* 仅登记 infohash 占位（无 peer 观测时使用，如 sample_infohashes 发现） */
function registerInfohash(ih) {
  const infohash = normalizeInfohash(ih);
  if (!infohash) return false;
  if (!stmts) init();
  const ts = Date.now();
  torrentsTouched.set(infohash + '|' + fmtDay(ts), ts);
  let isNew = false;
  try {
    isNew = stmts.insTorrent.run(infohash, ts, ts).changes > 0;
  } catch (e) {
    if (e && e.errcode === 5) return false;
    throw e;
  }
  if (isNew && onNewInfohash) { try { onNewInfohash(infohash); } catch (_) {} }
  return isNew;
}

/* 初始化长跑维护 + 写队列 */
function startPipeline() {
  init();
  startMaintenance();
  startWriteQueue();
}

module.exports = {
  ingest, batch, upsertTorrentMeta, setMetadataCallback, registerInfohash,
  queueIngest, flushQueue, startPipeline, CATEGORIES,
};
