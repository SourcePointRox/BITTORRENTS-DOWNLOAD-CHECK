'use strict';
/* 数据库驱动抽象层：封装 node:sqlite 实验性 API，提供稳定的数据库接口。
   如果未来 node:sqlite API 变动或需要切换到 better-sqlite3，
   只需修改此文件，不影响业务代码。

   当前后端：node:sqlite (DatabaseSync, Stability 1.2 - Release Candidate)
   未来可选：better-sqlite3（需 npm install）、node-sqlite3（异步） */

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  // 降级：尝试 better-sqlite3
  try {
    const better = require('better-sqlite3');
    DatabaseSync = class BetterSqliteAdapter {
      constructor(path, opts) {
        this._db = new better(path, opts);
      }
      exec(sql) { this._db.exec(sql); }
      prepare(sql) {
        const stmt = this._db.prepare(sql);
        return {
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
          run: (...args) => {
            const r = stmt.run(...args);
            return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
          },
        };
      }
      close() { this._db.close(); }
    };
  } catch (_) {
    throw new Error('No SQLite driver available: node:sqlite not found and better-sqlite3 not installed');
  }
}

/* 统一的数据库包装器：对外暴露与 node:sqlite.DatabaseSync 相同的接口 */
class Database {
  constructor(path, opts) {
    this._db = new DatabaseSync(path, opts);
  }
  exec(sql) { return this._db.exec(sql); }
  prepare(sql) { return this._db.prepare(sql); }
  close() { return this._db.close(); }
  get driver() { return 'node:sqlite'; }
}

module.exports = { Database, DatabaseSync };
