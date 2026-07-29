'use strict';
/* REST API 层：路由与官方 Peer/Torrent/Content API 对齐，响应字段增强（magnet / firstSeen）。 */
const db = require('./db');
const geo = require('./geo');
const { magnetURI, isIPv4, ipToInt, intToIp, fmtDay } = require('../common/util');

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function err(res, code, error, message) { json(res, code, { error, message }); }

/* 组装单个 content 条目（含增强字段） */
function contentItem(row) {
  const magnet = magnetURI(row.infohash, row.torrent_name || row.name);
  return {
    category: row.category || 'Unsorted',
    imdbId: row.imdb_id || undefined,
    name: row.torrent_name || row.name || row.infohash,
    startDate: new Date(row.first_seen_pair).toISOString(),
    endDate: new Date(row.last_seen_pair).toISOString(),
    firstSeen: new Date(row.t_first_seen || row.first_seen_pair).toISOString(), // 增强：资源最早记录发布时间
    torrent: {
      infohash: row.infohash,
      size: row.size || 0,
      name: row.torrent_name || row.name || row.infohash,
      magnet,                                                                       // 增强：磁力链接
    },
    magnet,                                                                         // 增强：顶层冗余，便于直接使用
  };
}

const handlers = {
  /* 官方 Peer API: /api/history/peer?ip=&days=&contents= */
  'GET /api/history/peer': (req, res, q) => {
    const ip = q.get('ip');
    if (!isIPv4(ip)) return err(res, 400, 'INVALID_IP', 'value of ip is invalid');
    let days = parseInt(q.get('days') || '14', 10);
    let contents = parseInt(q.get('contents') || '100', 10);
    if (isNaN(days) || days < 1 || days > 3650) return err(res, 400, 'INVALID_DAYS', 'value of days is invalid');
    if (isNaN(contents) || contents < 1) contents = 100;
    contents = Math.min(contents, 500);

    const d = db.get();
    const since = Date.now() - days * 86400000;
    const rows = d.prepare(`
      SELECT o.infohash, o.first_seen AS first_seen_pair, o.last_seen AS last_seen_pair,
             t.name AS torrent_name, t.size, t.category, t.title, t.imdb_id, t.first_seen AS t_first_seen
      FROM observations o JOIN torrents t ON t.infohash = o.infohash
      WHERE o.ip = ? AND o.last_seen >= ?
      ORDER BY o.last_seen DESC LIMIT ?`).all(ip, since, contents);

    const g = geo.lookup(ip);
    const hasPorno = rows.some(r => r.category === 'XXX');
    json(res, 200, {
      ip,
      isp: g.isp,
      hasPorno,
      hasChildPorno: false,
      geoData: { country: g.country, city: g.city, latitude: g.lat, longitude: g.lon },
      contents: rows.map(contentItem),
    });
  },

  /* 官方: /api/history/peers?cidr= */
  'GET /api/history/peers': (req, res, q) => {
    const cidr = q.get('cidr');
    const m = cidr && cidr.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
    if (!m) return err(res, 400, 'INVALID_CIDR', 'value of cidr is invalid');
    const base = m[1], bits = parseInt(m[2], 10);
    if (!isIPv4(base) || bits < 18 || bits > 32) return err(res, 400, 'INVALID_CIDR', 'CIDR min /18');
    const d = db.get();
    const start = ipToInt(base) & (0xFFFFFFFF << (32 - bits));
    const count = 1 << (32 - bits);
    const peers = [];
    // 受限展开（/18 最多 16384）
    const limit = Math.min(count, 20000);
    const stmt = d.prepare('SELECT ip,last_seen FROM peers WHERE ip=?');
    for (let i = 0; i < limit; i++) {
      const ip = intToIp((start + i) >>> 0);
      const row = stmt.get(ip);
      if (row) peers.push({ ip, date: new Date(row.last_seen).toISOString() });
    }
    json(res, 200, { CIDR: cidr, peers });
  },

  /* 官方: /api/history/exist?ip= */
  'GET /api/history/exist': (req, res, q) => {
    const ip = q.get('ip');
    if (!isIPv4(ip)) return err(res, 400, 'INVALID_IP', 'value of ip is invalid');
    const row = db.get().prepare('SELECT last_seen FROM peers WHERE ip=?').get(ip);
    json(res, 200, row
      ? { ip, exists: true, date: new Date(row.last_seen).toISOString() }
      : { ip, exists: false });
  },

  /* 官方 Torrent API: /api/torrent/info/{infohash} */
  'GET /api/torrent/info': (req, res, q, infohash) => {
    const d = db.get();
    const t = d.prepare('SELECT * FROM torrents WHERE infohash=?').get(infohash);
    if (!t) return err(res, 404, 'INFOHASH_NOT_FOUND', 'torrent with infohash not found in our database');
    json(res, 200, {
      infohash: t.infohash,
      torrentName: t.name || t.infohash,
      size: t.size || 0,
      category: t.category || 'Unsorted',
      title: t.title || t.name || t.infohash,
      imdbId: t.imdb_id || undefined,
      dateAdded: t.first_seen ? new Date(t.first_seen).toISOString() : undefined, // 最早记录发布时间
      firstSeen: t.first_seen ? new Date(t.first_seen).toISOString() : undefined, // 增强别名
      alive: !!t.alive,
      magnet: magnetURI(t.infohash, t.name),                                      // 增强
      files: t.files_json ? JSON.parse(t.files_json) : undefined,
    });
  },

  /* 官方: /api/torrent/peers/{infohash}?day=&countryCode= */
  'GET /api/torrent/peers': (req, res, q, infohash) => {
    const d = db.get();
    const t = d.prepare('SELECT infohash FROM torrents WHERE infohash=?').get(infohash);
    if (!t) return err(res, 404, 'INFOHASH_NOT_FOUND', 'torrent with infohash not found in our database');
    let day = q.get('day');
    if (!day) {
      const r = d.prepare('SELECT MAX(day) AS day FROM torrent_daily WHERE infohash=?').get(infohash);
      day = (r && r.day) || fmtDay(Date.now());
    }
    const cc = q.get('countryCode');
    // 当日该种子 peer 的 IP 列表（供详情页与报告共用）
    const dayStart = Date.parse(day + 'T00:00:00Z');
    const ips = d.prepare(`SELECT DISTINCT ip FROM obs_log WHERE infohash=? AND ts>=? AND ts<? LIMIT 20000`)
      .all(infohash, dayStart, dayStart + 86400000).map(r => r.ip);
    const byCountry = new Map();
    for (const ip of ips) {
      const g = geo.lookup(ip);
      if (cc && g.cc !== cc) continue;
      byCountry.set(g.cc, (byCountry.get(g.cc) || 0) + 1);
    }
    const countries = [...byCountry.entries()].map(([code, peers]) => ({ code, peers })).sort((a, b) => b.peers - a.peers);
    json(res, 200, {
      day, infohash,
      totalPeers: countries.reduce((a, c) => a + c.peers, 0),
      countries,
    });
  },

  /* 官方: /api/torrent/list/imdb/{imdbId} */
  'GET /api/torrent/list/imdb': (req, res, q, imdbId) => {
    if (!/^tt\d{5,10}$/.test(imdbId || '')) return err(res, 400, 'INVALID_IMDB', 'value of imdb is invalid');
    const rows = db.get().prepare('SELECT * FROM torrents WHERE imdb_id=? ORDER BY size DESC').all(imdbId);
    json(res, 200, {
      imdb: imdbId,
      title: rows.length ? (rows[0].title || rows[0].name) : undefined,
      torrents: rows.map(t => ({
        infohash: t.infohash, size: t.size || 0,
        dateAdded: t.first_seen ? new Date(t.first_seen).toISOString() : undefined,
        name: t.name || t.infohash, alive: !!t.alive,
        magnet: magnetURI(t.infohash, t.name),
      })),
    });
  },

  /* 官方 Content API: /api/content/summary?day= */
  'GET /api/content/summary': (req, res, q) => contentReport(req, res, q, 'summary'),
  /* 官方 Content API: /api/content/downloads?day= */
  'GET /api/content/downloads': (req, res, q) => contentReport(req, res, q, 'downloads'),

  /* 日统计页数据: /api/stat/daily?date=&cc= */
  'GET /api/stat/daily': (req, res, q) => {
    const d = db.get();
    const day = q.get('date') || latestDay();
    const pie = d.prepare('SELECT category, downloads FROM daily_stats WHERE day=? ORDER BY downloads DESC').all(day);
    json(res, 200, { day, categories: pie });
  },

  /* 全局概览（首页横幅数字） */
  'GET /api/overview': (req, res) => {
    json(res, 200, {
      totalTorrents: db.scalar('SELECT COUNT(*) FROM torrents'),
      totalPeers: db.scalar('SELECT COUNT(*) FROM peers'),
      totalObservations: db.scalar('SELECT COUNT(*) FROM obs_log'),
      lastDay: latestDay(),
    });
  },
};

function latestDay() {
  const d = db.get();
  const r = d.prepare('SELECT MAX(day) AS day FROM daily_stats').get();
  return (r && r.day) || fmtDay(Date.now());
}

function contentReport(req, res, q, kind) {
  const d = db.get();
  const day = q.get('day') || latestDay();
  const dayStart = Date.parse(day + 'T00:00:00Z');
  const cc = q.get('countryCode');
  // 按内容（title/imdb）聚合当日独立 IP 数
  const rows = d.prepare(`
    SELECT t.title, t.imdb_id, l.ip
    FROM obs_log l JOIN torrents t ON t.infohash = l.infohash
    WHERE l.ts >= ? AND l.ts < ?`).all(dayStart, dayStart + 86400000);
  const map = new Map(); // title -> {name, imdb, ips:Set, byCc:Map}
  for (const r of rows) {
    const key = r.imdb_id || r.title || '?';
    let e = map.get(key);
    if (!e) { e = { imdb: r.imdb_id, name: r.title, ips: new Set(), byCc: new Map() }; map.set(key, e); }
    e.ips.add(r.ip);
    if (!cc) {
      const g = geo.lookup(r.ip);
      e.byCc.set(g.cc, (e.byCc.get(g.cc) || new Set()).add(r.ip));
    }
  }
  const contents = [...map.values()]
    .map(e => ({
      imdb: e.imdb || undefined,
      name: e.name || 'Unknown',
      totalPeers: e.ips.size,
      countries: q.get('short') === 'true' ? undefined :
        [...e.byCc.entries()].map(([code, s]) => ({ code, peers: s.size })).sort((a, b) => b.peers - a.peers),
    }))
    .sort((a, b) => b.totalPeers - a.totalPeers)
    .slice(0, 200);
  const body = kind === 'summary'
    ? { day, totalPeers: contents.reduce((a, c) => a + c.totalPeers, 0), contents }
    : { day, totalDownloads: contents.reduce((a, c) => a + c.totalPeers, 0), contents };
  json(res, 200, body);
}

/* 简单路由器 */
function route(req, res, pathname, query) {
  // 带路径参数的端点
  let m;
  if ((m = pathname.match(/^\/api\/torrent\/info\/([0-9a-fA-F]{40}|[0-9a-fA-F]{64})\/?$/))) return handlers['GET /api/torrent/info'](req, res, query, m[1].toLowerCase());
  if ((m = pathname.match(/^\/api\/torrent\/peers\/([0-9a-fA-F]{40}|[0-9a-fA-F]{64})\/?$/))) return handlers['GET /api/torrent/peers'](req, res, query, m[1].toLowerCase());
  if ((m = pathname.match(/^\/api\/torrent\/list\/imdb\/(tt\d{5,10})\/?$/))) return handlers['GET /api/torrent/list/imdb'](req, res, query, m[1]);
  const h = handlers[`${req.method} ${pathname}`];
  if (h) return h(req, res, query);
  err(res, 404, 'NOT_FOUND', 'endpoint not found');
}

module.exports = { route, json, err, latestDay };
