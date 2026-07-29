'use strict';
/* 存储层：node:sqlite（WAL 模式）。提供连接管理、schema 迁移与常用查询。 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS torrents (
  infohash         TEXT PRIMARY KEY,
  hash_version     INTEGER DEFAULT 1,    -- 1 = v1(SHA-1/20字节), 2 = v2(SHA-256/32字节), 3 = hybrid
  infohash_v2      TEXT,                 -- v2 infohash (64 hex)，hybrid 种子同时有 v1 和 v2
  name             TEXT,
  size             INTEGER,
  category         TEXT DEFAULT 'Unsorted',
  title            TEXT,
  imdb_id          TEXT,
  first_seen       INTEGER,              -- 最早有记录的发布时间（UTC ms）
  last_seen        INTEGER,
  alive            INTEGER DEFAULT 1,
  metadata_ok      INTEGER DEFAULT 0,
  files_json       TEXT,
  piece_layers_json TEXT,               -- BEP-52 v2 的 piece layers（Merkle 哈希层）
  file_tree_json   TEXT,                -- BEP-52 v2 的 file tree 结构
  cold_synced      INTEGER DEFAULT 0    -- 冷存储同步标记
);
CREATE INDEX IF NOT EXISTS idx_torrents_category ON torrents(category);
CREATE INDEX IF NOT EXISTS idx_torrents_firstseen ON torrents(first_seen);
CREATE INDEX IF NOT EXISTS idx_torrents_hashver ON torrents(hash_version);
CREATE INDEX IF NOT EXISTS idx_torrents_v2 ON torrents(infohash_v2) WHERE infohash_v2 IS NOT NULL;

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
  isp        TEXT,
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

/* 旧库兼容：基础表结构（不含 v2/冷存储列）—— 用于迁移已存在的 torrents 表。
   运行 ALTER TABLE 添加缺失列后再创建依赖这些列的索引。 */
const SCHEMA_LEGACY_BASE = `
CREATE TABLE IF NOT EXISTS torrents (
  infohash         TEXT PRIMARY KEY,
  name             TEXT,
  size             INTEGER,
  category         TEXT DEFAULT 'Unsorted',
  title            TEXT,
  imdb_id          TEXT,
  first_seen       INTEGER,
  last_seen        INTEGER,
  alive            INTEGER DEFAULT 1,
  metadata_ok      INTEGER DEFAULT 0,
  files_json       TEXT
);
CREATE TABLE IF NOT EXISTS peers (
  ip         TEXT PRIMARY KEY,
  first_seen INTEGER,
  last_seen  INTEGER
);
CREATE TABLE IF NOT EXISTS observations (
  ip         TEXT NOT NULL,
  infohash   TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  hits       INTEGER DEFAULT 1,
  PRIMARY KEY (ip, infohash)
);
CREATE TABLE IF NOT EXISTS obs_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ip       TEXT NOT NULL,
  port     INTEGER,
  infohash TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  source   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_stats (
  day       TEXT NOT NULL,
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
  city      TEXT,
  lat       REAL,
  lon       REAL,
  isp        TEXT
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

/* 迁移后需要补建的索引（依赖 ALTER TABLE 后才存在的列） */
const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_torrents_category ON torrents(category);
CREATE INDEX IF NOT EXISTS idx_torrents_firstseen ON torrents(first_seen);
CREATE INDEX IF NOT EXISTS idx_torrents_hashver ON torrents(hash_version);
CREATE INDEX IF NOT EXISTS idx_torrents_v2 ON torrents(infohash_v2) WHERE infohash_v2 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_peers_lastseen ON peers(last_seen);
CREATE INDEX IF NOT EXISTS idx_obs_hash ON observations(infohash);
CREATE INDEX IF NOT EXISTS idx_obslog_hash_ts ON obs_log(infohash, ts);
CREATE INDEX IF NOT EXISTS idx_obslog_ts ON obs_log(ts);
CREATE INDEX IF NOT EXISTS idx_obslog_ts_source ON obs_log(ts, source);
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
  // 先用兼容旧库的基础表结构创建（避免旧库已存在但缺新列时 CREATE TABLE 失败）
  db.exec(SCHEMA_LEGACY_BASE);
  // 兼容旧库：为 ip_geo 补充新增列（已存在则忽略）
  for (const col of ['region', 'timezone', 'continent', 'resolved_at']) {
    try { db.exec(`ALTER TABLE ip_geo ADD COLUMN ${col} ${col === 'resolved_at' ? 'INTEGER' : 'TEXT'}`); } catch (_) {}
  }
  // 兼容旧库：为 torrents 补充 v2 + 冷存储列
  for (const [col, type] of [['hash_version','INTEGER'],['infohash_v2','TEXT'],['piece_layers_json','TEXT'],['file_tree_json','TEXT'],['cold_synced','INTEGER']]) {
    try { db.exec(`ALTER TABLE torrents ADD COLUMN ${col} ${type}${col === 'hash_version' ? ' DEFAULT 1' : col === 'cold_synced' ? ' DEFAULT 0' : ''}`); } catch (_) {}
  }
  // 列补全后再创建依赖这些列的索引
  db.exec(SCHEMA_INDEXES);
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

/* obs_log TTL 清理：保留最近 N 天的日志，删除旧数据并回收空间。
   使用 DELETE + 增量 VACUUM 避免全表锁；observations/peers/daily_stats 不受影响。
   线性追加写的 obs_log 表是长跑主要增长源，定期清理防止无限膨胀。 */
function pruneObsLog(retentionDays = 30) {
  const cutoff = Date.now() - retentionDays * 86400000;
  try {
    const r = get().prepare('DELETE FROM obs_log WHERE ts < ?').run(cutoff);
    // 增量回收：WAL 模式下 DELETE 不会自动收缩文件，定期 VACUUM
    if (r.changes > 10000) get().exec('PRAGMA wal_checkpoint(TRUNCATE);');
    return r.changes || 0;
  } catch (_) { return 0; }
}

module.exports = { open, close, get, scalar, pruneObsLog, SCHEMA, SCHEMA_LEGACY_BASE, SCHEMA_INDEXES };
