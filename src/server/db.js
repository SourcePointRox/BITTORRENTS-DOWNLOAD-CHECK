'use strict';
/* 存储层：node:sqlite（WAL 模式）。提供连接管理、schema 迁移与常用查询。 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS torrents (
  infohash     TEXT PRIMARY KEY,
  name         TEXT,
  size         INTEGER,
  category     TEXT DEFAULT 'Unsorted',
  title        TEXT,
  imdb_id      TEXT,
  first_seen   INTEGER,           -- 最早有记录的发布时间（UTC ms）
  last_seen    INTEGER,
  alive        INTEGER DEFAULT 1,
  metadata_ok  INTEGER DEFAULT 0,
  files_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_torrents_category ON torrents(category);
CREATE INDEX IF NOT EXISTS idx_torrents_firstseen ON torrents(first_seen);

CREATE TABLE IF NOT EXISTS peers (
  ip         TEXT PRIMARY KEY,
  first_seen INTEGER,
  last_seen  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_peers_lastseen ON peers(last_seen);

CREATE TABLE IF NOT EXISTS observations (
  ip         TEXT NOT NULL,
  infohash   TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  hits       INTEGER DEFAULT 1,
  PRIMARY KEY (ip, infohash)
);
CREATE INDEX IF NOT EXISTS idx_obs_hash ON observations(infohash);
-- 注：observations 主键 (ip,infohash) 前缀已覆盖按 ip 查询，不再建 idx_obs_ip（每条写入少维护一个索引）

CREATE TABLE IF NOT EXISTS obs_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ip       TEXT NOT NULL,
  port     INTEGER,
  infohash TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  source   TEXT NOT NULL          -- dht_passive | dht_active | tracker | pex | simulator
);
CREATE INDEX IF NOT EXISTS idx_obslog_hash_ts ON obs_log(infohash, ts);
-- 注：按 (ip,infohash) 的当日去重判定改走 observations 主键查询，obs_log 不再建 pair_ts；
--     全天扫描（content 报告）沙箱量级全表扫即可，生产建议按日分区。

CREATE TABLE IF NOT EXISTS daily_stats (
  day       TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
  category  TEXT NOT NULL,
  downloads INTEGER DEFAULT 0,
  PRIMARY KEY (day, category)
);

CREATE TABLE IF NOT EXISTS torrent_daily (
  infohash TEXT NOT NULL,
  day      TEXT NOT NULL,
  peers    INTEGER DEFAULT 0,
  PRIMARY KEY (infohash, day)
);

CREATE TABLE IF NOT EXISTS country_daily (
  cc    TEXT NOT NULL,
  day   TEXT NOT NULL,
  peers INTEGER DEFAULT 0,
  PRIMARY KEY (cc, day)
);

CREATE TABLE IF NOT EXISTS ip_geo (
  ip        TEXT PRIMARY KEY,
  cc        TEXT,
  country   TEXT,
  region    TEXT,
  city      TEXT,
  lat       REAL,
  lon       REAL,
  timezone  TEXT,
  continent TEXT,
  isp       TEXT,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS track_links (
  token      TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  visited    INTEGER DEFAULT 0,
  visitor_ip TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

let db = null;
let dbPath = null;

function open(file) {
  if (db) return db;
  dbPath = file || process.env.IKWYD_DB || path.join(__dirname, '..', '..', 'data', 'ikwyd.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;'); // 等待锁最多 5 秒
  db.exec(SCHEMA);
  // 兼容旧库：为 ip_geo 补充新增列（已存在则忽略）
  for (const col of ['region', 'timezone', 'continent', 'resolved_at']) {
    try { db.exec(`ALTER TABLE ip_geo ADD COLUMN ${col} ${col === 'resolved_at' ? 'INTEGER' : 'TEXT'}`); } catch (_) {}
  }
  return db;
}

function close() {
  if (db) { try { db.close(); } catch (_) {} db = null; }
}

function get() {
  if (!db) throw new Error('DB not opened. Call open() first.');
  return db;
}

/* 计数辅助 */
function scalar(sql, ...args) {
  const row = get().prepare(sql).get(...args);
  return row ? Number(Object.values(row)[0]) : 0;
}

module.exports = { open, close, get, scalar, SCHEMA };
