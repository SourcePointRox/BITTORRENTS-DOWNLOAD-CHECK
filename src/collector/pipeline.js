'use strict';
/* 采集管道：所有数据源（DHT/Tracker/PEX/模拟器）统一入口。
   事件：{ ip, port?, infohash, ts?, source }
   职责：入库 obs_log → 聚合 peers/observations/torrents → 日粒度统计 → 元数据补全回调。 */
const db = require('../server/db');
const geo = require('../server/geo');
const { fmtDay, normalizeInfohash } = require('../common/util');

const CATEGORIES = ['Movies', 'TV', 'Anime', 'Music', 'Games', 'Software', 'Books', 'XXX', 'Unsorted'];

let stmts = null;
let onNewInfohash = null; // 元数据补全回调（由 metadata fetcher 挂接）
let seenThisRun = new Set(); // 去重: ip|infohash|day
const torrentsTouched = new Set(); // 日节流: infohash|day → 每天最多更新一次 last_seen
const peersTouched = new Set();    // 日节流: ip|day

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
  d.prepare(`INSERT INTO torrents(infohash,name,size,category,title,imdb_id,first_seen,last_seen,alive,metadata_ok,files_json)
             VALUES(@infohash,@name,@size,@category,@title,@imdb_id,@first_seen,@last_seen,@alive,@metadata_ok,@files_json)
             ON CONFLICT(infohash) DO UPDATE SET
               name=COALESCE(excluded.name, torrents.name),
               size=COALESCE(excluded.size, torrents.size),
               category=CASE WHEN excluded.category IS NOT NULL THEN excluded.category ELSE torrents.category END,
               title=COALESCE(excluded.title, torrents.title),
               imdb_id=COALESCE(excluded.imdb_id, torrents.imdb_id),
               first_seen=MIN(COALESCE(torrents.first_seen, excluded.first_seen), COALESCE(excluded.first_seen, torrents.first_seen)),
               last_seen=MAX(COALESCE(torrents.last_seen,0), COALESCE(excluded.last_seen,0)),
               alive=excluded.alive,
               metadata_ok=MAX(torrents.metadata_ok, excluded.metadata_ok),
               files_json=COALESCE(excluded.files_json, torrents.files_json)`)
    .run({
      infohash: m.infohash,
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
    });
}

/* 单条观测事件 */
function ingest(ev) {
  const d = db.get();
  if (!stmts) init();
  const infohash = normalizeInfohash(ev.infohash);
  if (!infohash || !ev.ip) return false;
  const ts = ev.ts || Date.now();

  try {
    // 日粒度去重：同一 (ip, infohash, day) 仅计一次。
    const day = fmtDay(ts);
    const dayStart = Date.parse(day + 'T00:00:00Z');
    const key = ev.ip + '|' + infohash + '|' + day;
    let firstToday = false;
    if (!seenThisRun.has(key)) {
      seenThisRun.add(key);
      const pair = stmts.getObsPair.get(ev.ip, infohash);
      firstToday = !pair || pair.last_seen < dayStart;
    }

    // torrents/peers 的 last_seen 按 (key, day) 节流更新
    const tKey = infohash + '|' + day;
    let isNew = false;
    if (!torrentsTouched.has(tKey)) {
      torrentsTouched.add(tKey);
      isNew = stmts.insTorrent.run(infohash, ts, ts).changes > 0;
      if (!isNew) stmts.touchTorrent.run(ts, infohash);
    }
    stmts.insLog.run(ev.ip, ev.port ?? null, infohash, ts, ev.source || 'unknown');
    const pKey = ev.ip + '|' + day;
    if (!peersTouched.has(pKey)) {
      peersTouched.add(pKey);
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
  torrentsTouched.add(infohash + '|' + fmtDay(ts));
  let isNew = false;
  try {
    isNew = stmts.insTorrent.run(infohash, ts, ts).changes > 0; // INSERT OR IGNORE
  } catch (e) {
    if (e && e.errcode === 5) return false; // database is locked — skip
    throw e;
  }
  if (isNew && onNewInfohash) { try { onNewInfohash(infohash); } catch (_) {} }
  return isNew;
}

module.exports = { ingest, batch, upsertTorrentMeta, setMetadataCallback, registerInfohash, CATEGORIES };
