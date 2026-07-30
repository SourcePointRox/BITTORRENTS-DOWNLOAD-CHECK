'use strict';
/* 冷存储进程模块：独立进程，从主库 torrents 表提取种子信息写入冷存储数据库。
   与主进程分离，避免拖累主进程。状态信息可通过 getStats() 在监控 WEBUI 中展示。

   只录入：name / size / magnet / infohash_v1 / infohash_v2
   版本检测：infohash 长度 40 hex = v1 (SHA1)，64 hex = v2 (SHA256)
   主库无 hash_version/cold_synced 字段，故通过长度判断版本、通过冷库自身去重追踪同步状态。 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { magnetURI } = require('../common/util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS torrents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  infohash_v1 TEXT,
  infohash_v2 TEXT,
  name TEXT,
  size INTEGER,
  magnet TEXT,
  first_seen INTEGER,
  stored_at INTEGER DEFAULT (strftime('%s','now')*1000),
  UNIQUE(infohash_v1, infohash_v2)
);
CREATE INDEX IF NOT EXISTS idx_cold_name ON torrents(name);
CREATE INDEX IF NOT EXISTS idx_cold_v1 ON torrents(infohash_v1);
CREATE INDEX IF NOT EXISTS idx_cold_v2 ON torrents(infohash_v2);
`;

const DEFAULT_POLL = 3000;  // 3s（v0.8.5：从 10s 缩短，加速初始全量同步）
const SYNC_BATCH = 10000;   // 每次同步拉取的主库行数（v0.8.5：从 1000 提升 10x，加速初始全量同步）
const SYNC_BATCH_FAST = 50000; // 初始全量扫描阶段使用更大批次
const BACKFILL_BATCH = 500; // 每次回填最多处理的空 name 行数（v0.8.5：从 100 提升）

class ColdStorage {
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || path.join(__dirname, '..', '..', 'data', 'cold-storage.db');
    this.mainDbPath = opts.mainDbPath || process.env.IKWYD_DB || path.join(__dirname, '..', '..', 'data', 'ikwyd.db');
    this.pollInterval = opts.pollInterval || DEFAULT_POLL;
    this.unref = opts.unref !== false; // 默认 unref，worker 进程传 false 保持存活
    this.timer = null;
    this.running = false;
    this.lastSync = null;
    this.syncedCount = 0;
    this._coldDb = null;
    this._mainDb = null;
    this._stmts = null;
    this._syncedSet = null; // 已同步 infohash 集合（内存缓存）
    this._initRowid = 0;   // 初始全量扫描的 rowid 游标（null = 初始扫描完成）
  }

  /* ---------- 连接管理 ---------- */
  _open() {
    if (this._coldDb) return;
    if (!fs.existsSync(this.mainDbPath)) {
      throw new Error(`主库不存在: ${this.mainDbPath}`);
    }
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    // 冷库：读写
    this._coldDb = new DatabaseSync(this.dbPath);
    this._coldDb.exec('PRAGMA journal_mode = WAL;');
    this._coldDb.exec('PRAGMA synchronous = NORMAL;');
    this._coldDb.exec('PRAGMA busy_timeout = 5000;');
    this._coldDb.exec(SCHEMA);

    // 主库：读写连接（与主进程共享 WAL，readOnly 模式下无法读取 WAL 中的最新数据）
    this._mainDb = new DatabaseSync(this.mainDbPath);
    this._mainDb.exec('PRAGMA journal_mode = WAL;');
    this._mainDb.exec('PRAGMA busy_timeout = 5000;');

    this._stmts = {
      // 冷库语句
      insCold: this._coldDb.prepare(
        `INSERT INTO torrents(infohash_v1, infohash_v2, name, size, magnet, first_seen)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(infohash_v1, infohash_v2) DO NOTHING`
      ),
      updColdById: this._coldDb.prepare(
        'UPDATE torrents SET name=?, size=?, magnet=? WHERE id=?'
      ),
      countCold: this._coldDb.prepare('SELECT COUNT(*) AS c FROM torrents'),
      getSyncedV1: this._coldDb.prepare('SELECT infohash_v1 FROM torrents WHERE infohash_v1 IS NOT NULL'),
      getSyncedV2: this._coldDb.prepare('SELECT infohash_v2 FROM torrents WHERE infohash_v2 IS NOT NULL'),
      getColdNullName: this._coldDb.prepare(
        'SELECT id, infohash_v1, infohash_v2 FROM torrents WHERE name IS NULL LIMIT ?'
      ),
      // 主库语句（含 infohash_v2 用于 hybrid 种子同步）
      countMain: this._mainDb.prepare('SELECT COUNT(*) AS c FROM torrents'),
      getMainByRowid: this._mainDb.prepare(
        'SELECT rowid, infohash, infohash_v2, name, size, first_seen FROM torrents WHERE rowid > ? ORDER BY rowid ASC LIMIT ?'
      ),
      getMainSince: this._mainDb.prepare(
        'SELECT infohash, infohash_v2, name, size, first_seen FROM torrents WHERE first_seen > ? ORDER BY first_seen ASC LIMIT ?'
      ),
      getMainOne: this._mainDb.prepare('SELECT infohash, infohash_v2, name, size, first_seen FROM torrents WHERE infohash=?'),
    };
  }

  _close() {
    if (this._coldDb) { try { this._coldDb.close(); } catch (_) {} this._coldDb = null; }
    if (this._mainDb) { try { this._mainDb.close(); } catch (_) {} this._mainDb = null; }
    this._stmts = null;
    this._syncedSet = null;
    this._initRowid = 0;
  }

  /* ---------- 工具 ---------- */
  /* 从主库行提取 v1/v2 infohash。
     hybrid 种子：infohash(40hex) + infohash_v2(64hex) 同时存在
     纯 v1：infohash(40hex), infohash_v2=null
     纯 v2：infohash(64hex), infohash_v2=null */
  _splitHashFromRow(row) {
    const ih = row.infohash ? String(row.infohash).trim().toLowerCase() : null;
    const ih2 = row.infohash_v2 ? String(row.infohash_v2).trim().toLowerCase() : null;
    if (ih && /^[0-9a-f]{40}$/.test(ih)) {
      // v1 as PK（可能带 v2 = hybrid）
      return { v1: ih, v2: ih2 };
    }
    if (ih && /^[0-9a-f]{64}$/.test(ih)) {
      // v2 as PK
      return { v1: null, v2: ih };
    }
    return { v1: ih, v2: ih2 };
  }

  /* 兼容旧接口：检测单个 infohash 版本 */
  _splitHash(infohash) {
    if (!infohash) return { v1: null, v2: null };
    const h = String(infohash).trim().toLowerCase();
    if (/^[0-9a-f]{40}$/.test(h)) return { v1: h, v2: null };
    if (/^[0-9a-f]{64}$/.test(h)) return { v1: null, v2: h };
    return { v1: h, v2: null };
  }

  /* 生成磁力链接。
     hybrid (v1+v2)：磁链同时携带 btih(v1) 和 btmh(v2)，符合 BEP-52
     v2 only：btmh multihash base32
     v1 only：btih hex */
  _buildMagnet(v1, v2, name) {
    if (v1 && v2) {
      // hybrid：同时携带 v1 和 v2
      return magnetURI(v1, name, { infohashV1: v1 });
    }
    if (v2) {
      // BEP-52 / multihash: 0x12 (sha2-256) + 0x20 (length 32) + 32 字节摘要，base32 编码
      const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), Buffer.from(v2, 'hex')]);
      const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let bits = 0, value = 0, b32 = '';
      for (let i = 0; i < multihash.length; i++) {
        value = (value << 8) | multihash[i]; bits += 8;
        while (bits >= 5) { b32 += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
      }
      if (bits > 0) b32 += B32[(value << (5 - bits)) & 31];
      let m = 'magnet:?xt=urn:btmh:' + b32;
      if (name) m += '&dn=' + encodeURIComponent(name);
      const trackers = [
        'udp://tracker.openbittorrent.com:6969/announce',
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://open.stealth.si:80/announce',
      ];
      for (const t of trackers) m += '&tr=' + encodeURIComponent(t);
      return m;
    }
    // v1：调用 util.magnetURI
    return magnetURI(v1, name);
  }

  _loadSyncedSet() {
    this._syncedSet = new Set();
    for (const r of this._stmts.getSyncedV1.all()) this._syncedSet.add(r.infohash_v1);
    for (const r of this._stmts.getSyncedV2.all()) this._syncedSet.add(r.infohash_v2);
  }

  /* ---------- 同步 ---------- */
  /* 执行一次同步：从主库拉取新种子写入冷存储，并回填缺失元数据。
     初始全量扫描使用 rowid 游标分批（避免 O(n) OFFSET），完成后切换为增量模式。 */
  syncOnce() {
    this._open();
    if (!this._syncedSet) this._loadSyncedSet();

    let rows;
    let isInitial = this._initRowid !== null;

    if (isInitial) {
      // 初始全量扫描：按 rowid 游标分批拉取（使用更大批次加速）
      rows = this._stmts.getMainByRowid.all(this._initRowid, SYNC_BATCH_FAST);
      if (rows.length === 0) {
        // 初始扫描完成，切换到增量模式
        this._initRowid = null;
        isInitial = false;
        rows = [];
      } else {
        // 推进游标到本批最后一行
        this._initRowid = rows[rows.length - 1].rowid;
      }
    }

    if (!isInitial) {
      // 增量模式：拉取上次同步后新增的种子（留 60s 重叠窗口防止遗漏）
      const since = this.lastSync ? this.lastSync - 60000 : 0;
      rows = this._stmts.getMainSince.all(since, SYNC_BATCH);
    }

    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      // 使用 hybrid-aware 解析：hybrid 种子的 v1 在 infohash 列、v2 在 infohash_v2 列
      const { v1, v2 } = this._splitHashFromRow(row);
      const magnet = this._buildMagnet(v1, v2, row.name);
      // 已同步判定：v1 或 v2 任一命中即视为已写入冷库
      const alreadySynced = (v1 && this._syncedSet.has(v1)) || (v2 && this._syncedSet.has(v2));

      if (alreadySynced) {
        // 已同步：初始扫描阶段跳过，增量阶段尝试回填 name
        if (!isInitial && row.name != null) {
          const col = v1 ? 'infohash_v1' : 'infohash_v2';
          const val = v1 || v2;
          const idRow = this._coldDb.prepare(`SELECT id FROM torrents WHERE ${col}=?`).get(val);
          if (idRow) {
            const res = this._stmts.updColdById.run(row.name ?? null, row.size ?? null, magnet, idRow.id);
            if (res.changes > 0) updated++;
          }
        }
        continue;
      }

      const res = this._stmts.insCold.run(v1, v2, row.name ?? null, row.size ?? null, magnet, row.first_seen ?? null);
      if (res.changes > 0) {
        inserted++;
        if (v1) this._syncedSet.add(v1);
        if (v2) this._syncedSet.add(v2);
      }
    }

    // 回填：初始扫描完成后，对冷库中 name 为空的行从主库补全
    let backfilled = 0;
    if (!isInitial) {
      const nullNameRows = this._stmts.getColdNullName.all(BACKFILL_BATCH);
      for (const c of nullNameRows) {
        const ih = c.infohash_v1 || c.infohash_v2;
        if (!ih) continue;
        const main = this._stmts.getMainOne.get(ih);
        if (main && main.name) {
          // hybrid-aware：从主库行提取 v1/v2 构建正确磁链
          const { v1, v2 } = this._splitHashFromRow(main);
          const magnet = this._buildMagnet(v1, v2, main.name);
          const res = this._stmts.updColdById.run(main.name, main.size ?? null, magnet, c.id);
          if (res.changes > 0) { updated++; backfilled++; }
        }
      }
    }

    this.syncedCount += inserted;
    this.lastSync = Date.now();
    return { inserted, updated, backfilled, scanned: rows.length, initial: isInitial };
  }

  /* ---------- 生命周期 ---------- */
  start() {
    if (this.running) return;
    this._open();
    this.running = true;
    const mainCount = this._stmts.countMain.get().c;
    const coldCount = this._stmts.countCold.get().c;
    console.log(`[cold-storage] started: main=${mainCount} cold=${coldCount} poll=${this.pollInterval}ms`);
    // 立即同步一次
    this._tick();
    this.timer = setInterval(() => this._tick(), this.pollInterval);
    if (this.unref && this.timer.unref) this.timer.unref();
  }

  _tick() {
    try {
      const r = this.syncOnce();
      if (r.inserted > 0 || r.updated > 0 || r.initial) {
        console.log(`[cold-storage] synced +${r.inserted} updated ${r.updated} backfilled ${r.backfilled} (scanned ${r.scanned}, initial=${r.initial})`);
      }
    } catch (e) {
      console.error('[cold-storage] sync error:', e.message);
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.running = false;
    this._close();
  }

  getStats() {
    let total = 0;
    let mainTotal = 0;
    if (this._coldDb) {
      try { total = this._stmts.countCold.get().c; } catch (_) {}
    }
    if (this._mainDb) {
      try { mainTotal = this._stmts.countMain.get().c; } catch (_) {}
    }
    return {
      total,
      synced: total,
      pending: Math.max(0, mainTotal - total),
      lastSync: this.lastSync,
      dbPath: this.dbPath,
      running: this.running,
    };
  }
}

/* 独立进程入口：由 scripts/cold-storage-worker.js 调用 */
function startWorker(opts = {}) {
  const cs = new ColdStorage({ ...opts, unref: false });
  cs.start();
  console.log(`[cold-storage] worker started, db=${cs.dbPath}`);
  console.log(`[cold-storage] main db=${cs.mainDbPath}, poll=${cs.pollInterval}ms`);

  // 定期输出状态
  const statsTimer = setInterval(() => {
    const s = cs.getStats();
    console.log(`[cold-storage] total=${s.total} synced=${s.synced} pending=${s.pending} running=${s.running}`);
  }, 60000);

  // 优雅退出
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[cold-storage] received ${sig}, shutting down...`);
    cs.stop();
    clearInterval(statsTimer);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return cs;
}

module.exports = { ColdStorage, startWorker };
