'use strict';
/* HTTP 服务：静态资源 + REST API + SSR 页面 + 追踪短链 + 动态海报。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const geo = require('./geo');
const api = require('./api');
const pages = require('./pages');
const admin = require('./admin');
const { CollectorService } = require('../collector/service');
const { isIPv4, randomHex, esc } = require('../common/util');

let collectorService = null;

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

/* 访客 IP：直连场景取 socket 地址；沙箱本机访问映射到“演示 IP”（库中最活跃 peer），
   使首页直接呈现丰富数据（与官网"打开即见自己 IP 数据"的体验一致）。 */
function visitorIp(req) {
  let ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (isIPv4(ip) && !isPrivate(ip)) return ip;
  const row = db.get().prepare(`
    SELECT ip, COUNT(*) AS c FROM observations GROUP BY ip ORDER BY c DESC LIMIT 1`).get();
  return row ? row.ip : (isIPv4(ip) ? ip : '127.0.0.1');
}
function isPrivate(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);
}

/* 动态海报（SVG 占位：IMDB 风格深色海报 + 标题首字母） */
function posterSvg(title) {
  const t = String(title || '?').trim();
  const initials = t.split(/\s+/).slice(0, 2).map(w => w[0] ? w[0].toUpperCase() : '').join('');
  let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue},45%,28%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},50%,14%)"/>
  </linearGradient></defs>
  <rect width="160" height="240" fill="url(#g)"/>
  <text x="80" y="118" font-family="Arial" font-size="44" font-weight="bold" fill="rgba(255,255,255,0.9)" text-anchor="middle">${esc(initials)}</text>
  <text x="80" y="228" font-family="Arial" font-size="9" fill="rgba(255,255,255,0.5)" text-anchor="middle">IKWYD SANDBOX</text>
</svg>`;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  const q = u.searchParams;

  // ---- 后台监控 WEBUI ----
  if (pathname.startsWith('/admin')) {
    const handled = await admin.route(req, res, pathname, q, readBody);
    if (handled) return;
  }

  // ---- API ----
  if (pathname.startsWith('/api/')) return api.route(req, res, pathname, q);

  // ---- 追踪短链 ----
  let m;
  if ((m = pathname.match(/^\/link\/go\/([0-9a-f]{16})$/))) {
    const d = db.get();
    const link = d.prepare('SELECT * FROM track_links WHERE token=?').get(m[1]);
    if (!link) return html(res, 404, pages.page404('Link not found'));
    let ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (!isIPv4(ip) || isPrivate(ip)) {
      // 沙箱：本机访问时记为演示访客 IP（模拟外部点击）
      const demo = db.get().prepare('SELECT ip FROM peers WHERE ip NOT LIKE ? ORDER BY last_seen DESC LIMIT 1').get('127.%');
      ip = demo ? demo.ip : ip;
    }
    d.prepare('UPDATE track_links SET visited=1, visitor_ip=? WHERE token=?').run(ip, m[1]);
    return redirect(res, link.target_url);
  }
  if ((m = pathname.match(/^\/link\/check\/([0-9a-f]{16})$/))) {
    const link = db.get().prepare('SELECT visited, visitor_ip FROM track_links WHERE token=?').get(m[1]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(link
      ? { visited: !!link.visited, visitorIp: link.visitor_ip }
      : { visited: false }));
  }

  // ---- 表单 POST ----
  if (req.method === 'POST') {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    if (pathname === '/en/link/') {
      let url = (params.get('url') || '').trim();
      if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
      if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) return html(res, 400, pages.page404('Invalid URL'));
      const token = randomHex(8);
      db.get().prepare('INSERT INTO track_links(token,target_url,created_at) VALUES(?,?,?)').run(token, url, Date.now());
      return html(res, 200, pages.pageLinkResult(token, url));
    }
    if (pathname === '/en/createKey') {
      const email = (params.get('email') || '').trim();
      const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ok
        ? { success: true, message: 'Demo Key sent: IKWYD-DEMO-' + randomHex(8).toUpperCase() + ' (sandbox: key is not actually required)' }
        : { success: false, message: 'Invalid email address' }));
    }
    return html(res, 404, pages.page404());
  }

  // ---- 动态海报 ----
  if ((m = pathname.match(/^\/poster\/(tt\d{5,10})$/))) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    return res.end(posterSvg(q.get('t') || m[1]));
  }

  // ---- 页面路由 ----
  const vip = visitorIp(req);
  if (pathname === '/') return redirect(res, '/en/peer/?ip=' + encodeURIComponent(vip));
  if (pathname === '/en/' || pathname === '/en') return redirect(res, '/en/peer/?ip=' + encodeURIComponent(vip));
  if (pathname === '/en/peer/' || pathname === '/en/peer') {
    const ip = q.get('ip') || vip;
    return html(res, 200, pages.pagePeer(ip, vip));
  }
  if (pathname === '/en/link/') return html(res, 200, pages.pageLink());
  if (pathname === '/en/stat/daily' || pathname === '/en/stat/daily/') {
    return html(res, 200, pages.pageStatDaily(q.get('cc') || 'GL', q.get('statDate')));
  }
  if ((m = pathname.match(/^\/en\/stat\/([A-Za-z]{2})\/daily\/?$/))) {
    return html(res, 200, pages.pageStatDaily(m[1], null));
  }
  if ((m = pathname.match(/^\/en\/stat\/([A-Za-z]{2})\/daily\/q$/))) {
    return html(res, 200, pages.pageStatDaily(m[1], q.get('statDate')));
  }
  if (pathname === '/en/stat/annual' || pathname === '/en/stat/annual/') {
    return html(res, 200, pages.pageStatAnnual(q.get('year')));
  }
  // v2 infohash 路由（64 hex）+ v1（40 hex）
  if ((m = pathname.match(/^\/en\/torrent\/([0-9a-fA-F]{40}|[0-9a-fA-F]{64})(?:\/[^\/]*)?\/?$/))) {
    const body = pages.pageTorrent(m[1].toLowerCase());
    const exists = db.get().prepare('SELECT 1 AS x FROM torrents WHERE infohash=?').get(m[1].toLowerCase());
    return html(res, exists ? 200 : 404, body);
  }
  // 冷存储信息页面
  if (pathname === '/en/cold-storage/' || pathname === '/en/cold-storage') {
    return html(res, 200, pages.pageColdStorage());
  }
  if (pathname === '/en/api/') return html(res, 200, pages.pageApi());
  if (pathname === '/en/contacts/') return html(res, 200, pages.pageContacts());

  // ---- 静态资源 ----
  if (pathname.startsWith('/assets/')) {
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return html(res, 404, pages.page404());
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    return fs.createReadStream(file).pipe(res);
  }

  return html(res, 404, pages.page404());
}

function start(port, opts = {}) {
  db.open();
  if (!collectorService) {
    collectorService = new CollectorService();
    admin.init(collectorService);
  }
  const p = port || Number(process.env.PORT) || 8080;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[server]', e);
      try { html(res, 500, pages.page404('Internal error')); } catch (_) { res.end(); }
    });
  });
  server.listen(p, () => {
    console.log(`[ikwyd] site   : http://localhost:${p}`);
    console.log(`[ikwyd] admin  : http://localhost:${p}/admin/`);
    if (opts.collector === 'sim') { collectorService.startSim(); console.log('[ikwyd] collector: sim mode'); }
    if (opts.collector === 'live') { collectorService.startLive({ tracker: true, pex: true }); console.log('[ikwyd] collector: live DHT+PEX+Tracker mode'); }
  });
  return server;
}

function getCollector() { return collectorService; }

if (require.main === module) {
  const args = process.argv.slice(2);
  const collector = args.includes('--live') ? 'live' : args.includes('--sim') ? 'sim' : undefined;
  start(undefined, { collector });
}

module.exports = { start, visitorIp, getCollector };
