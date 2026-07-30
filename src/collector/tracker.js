'use strict';
/* Tracker 抓取器（HTTP announce + UDP announce）。
   - HTTP tracker（BEP-3 / BEP-23 紧凑 peer 格式，BEP-7 peers6 IPv6）
   - HTTP tracker 同时支持 BEP-52 v2 的 32 字节 infohash announce
   - UDP tracker（BEP-15，UDP tracker 协议；udp6 socket 支持 IPv6 tracker）
   对已发现的 infohash 向公共 tracker 请求 peer 列表，事件进 pipeline。
   仅做 announce 级别的握手信息交换，不传输任何内容数据。 */
const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns');
const bencode = require('../common/bencode');
const { formatIPv6, isIPv6 } = require('../common/util');

const { lookup: dnsLookupRaw } = dns.promises;

/* ---------- DNS 缓存（5 分钟 TTL，避免健康检查时反复解析同一域名） ---------- */
const DNS_CACHE = new Map(); // host -> { addrs, expires }
const DNS_TTL = 300000; // 5 分钟

async function dnsLookup(host, opts) {
  const now = Date.now();
  const cached = DNS_CACHE.get(host);
  if (cached && cached.expires > now) return cached.addrs;
  const addrs = await dnsLookupRaw(host, opts);
  DNS_CACHE.set(host, { addrs, expires: now + DNS_TTL });
  return addrs;
}

/* ---------- HTTP keepalive 连接池（复用 TCP 连接，减少握手开销） ---------- */
const http = require('http');
const https = require('https');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 10000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, timeout: 10000 });

/* 全球公共 tracker 种子列表（HTTP + UDP，覆盖各地区）。
   已按 URL 去重：同一主机不同端口/路径/协议视为不同 tracker 端点（它们都是独立的服务实例）。 */
const RAW_TRACKERS = [
  // UDP trackers（优先，更快更稳）
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker2.dler.org:80/announce',
  'udp://tracker4.itzmx.com:2710/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://retracker01-msk-virt.corbina.net:80/announce',
  'udp://tracker1.bt.moack.co:80/announce',
  'udp://explodie.org:6969/announce',
  // HTTP / HTTPS trackers
  'http://open.tracker.cl:1337/announce',
  'http://tracker.tamersunion.org:443/announce',
  'http://bt1.archive.org:6969/announce',
  'http://bt2.archive.org:6969/announce',
  'http://tracker.bt4g.com:2095/announce',
];

function _hostOf(url) {
  const m = String(url).match(/^[a-z]+:\/\/([^:\/]+)/i);
  return m ? m[1].toLowerCase() : String(url).toLowerCase();
}

/* 按完整 URL 去重（scheme://host:port/path 每个端点都是独立 tracker 服务实例）。
   相比旧的 hostname 去重，URL 级去重保留了同一主机的多个端口/路径/协议端点，
   这些是真实存在的独立服务，全部值得探测。 */
const PUBLIC_TRACKERS = (() => {
  const seen = new Set();
  const out = [];
  for (const u of RAW_TRACKERS) {
    const key = u.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.trim());
  }
  return out;
})();

/* ---------- 紧凑 peer 解析 ---------- */
/* IPv4 compact peers：6 字节一组（4 IP + 2 port） */
function parseCompactPeers(buf) {
  const out = [];
  if (!Buffer.isBuffer(buf)) return out;
  for (let i = 0; i + 6 <= buf.length; i += 6) {
    out.push({
      ip: [...buf.slice(i, i + 4)].join('.'),
      port: buf.readUInt16BE(i + 4),
      family: 'ipv4',
    });
  }
  return out;
}

/* IPv6 compact6 peers：18 字节一组（16 IP + 2 port），见 BEP-7 peers6 */
function parseCompactPeers6(buf) {
  const out = [];
  if (!Buffer.isBuffer(buf)) return out;
  for (let i = 0; i + 18 <= buf.length; i += 18) {
    const ip = formatIPv6(buf.slice(i, i + 16));
    if (!isIPv6(ip)) continue; // 丢弃非法地址
    out.push({ ip, port: buf.readUInt16BE(i + 16), family: 'ipv6' });
  }
  return out;
}

/* 尽力解析可能混合 IPv4(6B)/IPv6(18B) 的 peer 缓冲区（用于 UDP announce 响应）。
   标准 BEP-15 仅定义 IPv4；此处兼容非标准的混合/纯 IPv6 响应。 */
function parseCompactPeersMixed(buf, familyHint) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { peers: [], peers6: [] };
  if (familyHint === 'ipv6' && buf.length % 18 === 0) {
    return { peers: [], peers6: parseCompactPeers6(buf) };
  }
  const peers = parseCompactPeers(buf);
  const consumed = peers.length * 6;
  const remainder = buf.length - consumed;
  const peers6 = remainder >= 18 ? parseCompactPeers6(buf.slice(consumed)) : [];
  return { peers, peers6 };
}

/* ---------- HTTP tracker（BEP-3 / BEP-7 / BEP-52） ---------- */
/* v2 (BEP-52)：64-hex infohash 以 32 字节二进制 announce（HTTP tracker 支持 v2）。
   v1：20 字节。同时附带 ipv6=1 提示（BEP-7），鼓励 tracker 返回 peers6。 */
async function scrapeHTTP(trackerUrl, infohashHex, opts = {}) {
  const infohash = Buffer.from(infohashHex, 'hex');
  const peerId = crypto.randomBytes(20);
  const rawInfo = [...infohash].map(b => '%' + b.toString(16).padStart(2, '0')).join('');
  const rawPeer = [...peerId].map(b => '%' + b.toString(16).padStart(2, '0')).join('');
  const url = `${trackerUrl}?info_hash=${rawInfo}&peer_id=${rawPeer}&port=${opts.port || 6881}` +
    `&uploaded=0&downloaded=0&left=1&compact=1&event=started&ipv6=1&numwant=${opts.numwant == null ? 80 : opts.numwant}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'uTorrent/3.5.5', 'Accept': 'application/octet-stream, text/plain, */*' },
      agent: url.startsWith('https:') ? httpsAgent : httpAgent,
    });
    const body = Buffer.from(await res.arrayBuffer());
    let decoded;
    try { decoded = bencode.decode(body); } catch (_) { decoded = null; }
    if (!decoded || typeof decoded !== 'object') {
      return { peers: [], peers6: [], error: 'invalid response' };
    }
    if (decoded['failure reason']) {
      // tracker 正常处理了请求（返回了结构化失败原因）—— 视为已响应
      return { peers: [], peers6: [], responded: true, error: decoded['failure reason'].toString() };
    }
    return {
      peers: parseCompactPeers(decoded.peers),
      peers6: parseCompactPeers6(decoded.peers6),
      responded: true,
      interval: decoded.interval || 1800,
      complete: decoded.complete,
      incomplete: decoded.incomplete,
    };
  } catch (e) {
    return { peers: [], peers6: [], error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- UDP tracker（BEP-15） ---------- */
/* UDP tracker 协议：
   1. 连接请求（connection_id=0x41727101980 magic，action=0）
   2. 连接响应 → connection_id（有效期 60s）
   3. announce 请求（action=1，携带 info_hash / peer_id / port）
   4. announce 响应 → peers 列表 */
const UDP_CONNECT_MAGIC = BigInt('0x41727101980');

/* 对单个已解析地址执行 connect→announce 流程；family 为 4 或 6。
   v2 的 32 字节 infohash 无法用于 UDP tracker（BEP-15 固定 20 字节字段），调用方负责截断。 */
function scrapeUDPAddr(address, family, port, infohashHex, opts = {}) {
  return new Promise((resolve) => {
    const sockType = family === 6 ? 'udp6' : 'udp4';
    let sock;
    try { sock = dgram.createSocket(sockType); }
    catch (e) { return resolve({ peers: [], peers6: [], error: 'socket: ' + String(e && e.message || e) }); }
    const timeout = opts.timeout || 8000;
    const result = { peers: [], peers6: [] };
    let done = false;
    let connectionId = null;
    const infohash = Buffer.from(infohashHex, 'hex').slice(0, 20); // BEP-15 固定 20 字节
    const peerId = crypto.randomBytes(20);
    const transactionId = crypto.randomBytes(4);
    let timer = null;

    const finish = (val) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(val);
    };

    timer = setTimeout(() => finish({ peers: [], peers6: [], error: 'timeout' }), timeout);
    sock.on('error', () => finish({ peers: [], peers6: [], error: 'socket error' }));

    // Step 1: connect request
    const connectReq = Buffer.alloc(16);
    connectReq.writeBigUInt64BE(UDP_CONNECT_MAGIC, 0);
    connectReq.writeUInt32BE(0, 8); // action = 0 (connect)
    connectReq.writeUInt32BE(transactionId.readUInt32BE(0), 12);
    sock.send(connectReq, port, address);

    sock.on('message', (msg) => {
      if (msg.length < 16 || done) return;
      const action = msg.readUInt32BE(0);
      const respTid = msg.readUInt32BE(4);
      if (respTid !== transactionId.readUInt32BE(0)) return;

      if (action === 0 && !connectionId) {
        // connect response
        connectionId = msg.readBigUInt64BE(8);
        // Step 2: announce request
        const announceReq = Buffer.alloc(98);
        announceReq.writeBigUInt64BE(connectionId, 0);
        announceReq.writeUInt32BE(1, 8); // action = 1 (announce)
        announceReq.writeUInt32BE(transactionId.readUInt32BE(0), 12);
        infohash.copy(announceReq, 16);
        peerId.copy(announceReq, 36);
        announceReq.writeBigUInt64BE(BigInt(0), 56);  // downloaded
        announceReq.writeBigUInt64BE(BigInt(0), 64);  // left
        announceReq.writeBigUInt64BE(BigInt(0), 72);  // uploaded
        announceReq.writeUInt32BE(0, 80);  // event = 0 (none)
        announceReq.writeUInt32BE(0, 84);  // IP = 0 (default)
        announceReq.writeUInt32BE(crypto.randomInt(0, 0xFFFFFFFF), 88); // key
        announceReq.writeInt32BE(opts.numwant == null ? 80 : opts.numwant, 92); // numwant
        announceReq.writeUInt16BE(opts.port || 6881, 96); // port
        sock.send(announceReq, port, address);
      } else if (action === 1) {
        // announce response: offset 8=interval, 12=leechers, 16=seeders, 20+=peers
        const mixed = parseCompactPeersMixed(msg.slice(20), family === 6 ? 'ipv6' : 'ipv4');
        const out = {
          peers: mixed.peers,
          peers6: mixed.peers6,
          responded: true,
          interval: msg.length >= 12 ? msg.readUInt32BE(8) : 1800,
        };
        if (msg.length >= 16) out.leechers = msg.readUInt32BE(12);
        if (msg.length >= 20) out.seeders = msg.readUInt32BE(16);
        finish(out);
      } else if (action === 3) {
        // error response —— tracker 处理了请求，视为已响应
        finish({ peers: [], peers6: [], responded: true, error: msg.slice(8).toString() });
      }
    });
  });
}

/* 解析 host → 并发尝试所有解析地址（IPv4/IPv6），首个成功结果胜出 */
async function scrapeUDP(trackerUrl, infohashHex, opts = {}) {
  const m = trackerUrl.match(/^udp:\/\/([^:\/]+):(\d+)/);
  if (!m) return { peers: [], peers6: [], error: 'invalid udp url' };
  const host = m[1];
  const port = parseInt(m[2], 10);
  let addresses;
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch (e) {
    return { peers: [], peers6: [], error: 'dns: ' + String(e && e.message || e) };
  }
  if (!addresses || !addresses.length) {
    return { peers: [], peers6: [], error: 'no dns records' };
  }

  const attempts = addresses.map(a => scrapeUDPAddr(a.address, a.family, port, infohashHex, opts));
  // 并发竞速：首个拿到 peer 的结果立即返回；其余 socket 各自超时后自关闭
  return new Promise((resolve) => {
    let resolved = false;
    let pending = attempts.length;
    let best = null;
    const pick = (val) => {
      if (resolved) return;
      if (val && !best && (val.peers.length || val.peers6.length || val.responded)) best = val;
      if (val && (val.peers.length || val.peers6.length)) {
        resolved = true;
        resolve(val);
        return;
      }
      pending--;
      if (pending === 0) {
        resolved = true;
        resolve(best || { peers: [], peers6: [], error: 'all addresses failed' });
      }
    };
    for (const p of attempts) {
      Promise.resolve(p).then(pick).catch(() => {
        if (resolved) return;
        pending--;
        if (pending === 0) { resolved = true; resolve(best || { peers: [], peers6: [], error: 'all addresses failed' }); }
      });
    }
  });
}

/* 统一入口：自动判断 HTTP / UDP */
async function scrapeTracker(trackerUrl, infohashHex, opts = {}) {
  if (trackerUrl.startsWith('udp://')) return scrapeUDP(trackerUrl, infohashHex, opts);
  return scrapeHTTP(trackerUrl, infohashHex, opts);
}

/* ---------- 动态 tracker 管理 + 健康检查 ---------- */
/* 远程公开 tracker 列表源：全网深度聚合 + 实时存活检测。
   目标是尽可能覆盖“全网实时更新的开放 tracker”（五位数级别），因此同时使用：
   1) newTrackon —— 持续对全网开放 tracker 做存活探测的实时服务（api/all 等 5 个维度）；
   2) 社区每日机器人自动更新的聚合列表：
      - ngosang/trackerslist（all/ip/http/https/udp/best 全系列）
      - XIU2/TrackersListCollection（all/best/http/nohttp/other 全系列）
      - DeSireFire/animeTrackerList（AT_all 全系列 + ATline 全系列）
      - adysec/tracker（all/best 全系列，当前全网最大聚合源之一）
      - hezhijie0327/Trackerslist（tracker/combine/exclude 全系列）
   3) 上述列表的 CDN / 镜像地址（jsDelivr 多节点、statically、cf.trackerslist.com、trackerslist.com），
      供 GitHub 访问受限的网络回退；
   4) HTML 页面源（torrenttrackerlist.com 等），从页面中正则提取 tracker URL。
   所有来源拉取后按完整 URL 去重合并（每端点一条），失败来源自动跳过。 */
const DEFAULT_SOURCES = [
  // ---- 实时存活服务：newTrackon 持续探测全网开放 tracker ----
  'https://newtrackon.com/api/all',
  'https://newtrackon.com/api/stable',
  'https://newtrackon.com/api/live',
  'https://newtrackon.com/api/udp',
  'https://newtrackon.com/api/http',
  // ---- ngosang/trackerslist（每日机器人更新，全系列） ----
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ip.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_http.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_https.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_udp.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt',
  // ---- XIU2/TrackersListCollection（每日更新，全系列） ----
  'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt',
  'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt',
  'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/http.txt',
  'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/nohttp.txt',
  'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/other.txt',
  // ---- DeSireFire/animeTrackerList（每日更新，AT + ATline 全系列，约 1000+/系列） ----
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_all.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_best.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_all_ip.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_all_udp.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_all_http.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_all_https.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/ATline_all.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/ATline_best.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/ATline_all_ip.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/ATline_all_udp.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/ATline_all_http.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/ATline_all_https.txt',
  // ---- adysec/tracker（每日更新，当前最大聚合源之一，3000+ 条） ----
  'https://raw.githubusercontent.com/adysec/tracker/main/trackers_all.txt',
  'https://raw.githubusercontent.com/adysec/tracker/main/trackers_best.txt',
  'https://raw.githubusercontent.com/adysec/tracker/main/trackers_best_http.txt',
  'https://raw.githubusercontent.com/adysec/tracker/main/trackers_best_https.txt',
  'https://raw.githubusercontent.com/adysec/tracker/main/trackers_best_udp.txt',
  // ---- hezhijie0327/Trackerslist（每日更新，combine = 全量合并） ----
  'https://raw.githubusercontent.com/hezhijie0327/Trackerslist/main/trackerslist_combine.txt',
  'https://raw.githubusercontent.com/hezhijie0327/Trackerslist/main/trackerslist_tracker.txt',
  'https://raw.githubusercontent.com/hezhijie0327/Trackerslist/main/trackerslist_exclude.txt',
  // ---- CDN / 镜像回退（GitHub 直连受限时仍可获取最新列表） ----
  'https://cf.trackerslist.com/all.txt',
  'https://cf.trackerslist.com/best.txt',
  'https://trackerslist.com/all.txt',
  'https://trackerslist.com/best.txt',
  'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_all.txt',
  'https://fastly.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_all.txt',
  'https://fastly.jsdelivr.net/gh/XIU2/TrackersListCollection@master/all.txt',
  'https://fastly.jsdelivr.net/gh/adysec/tracker@main/trackers_all.txt',
  'https://gcore.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_all.txt',
  'https://testingcf.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_all.txt',
  'https://cdn.statically.io/gh/ngosang/trackerslist/master/trackers_all.txt',
  // ---- HTML 页面源（正则提取 tracker URL） ----
  'https://www.torrenttrackerlist.com/torrent-tracker-list/',
];

/* HTML 页面源标记：这些 URL 返回的是网页，需要正则提取其中的 tracker */
const HTML_SOURCE_RE = /torrenttrackerlist\.com/;

/* 从任意文本中提取 tracker URL（用于 HTML 页面源） */
function extractTrackersFromText(text) {
  const out = new Set();
  const re = /(udp|https?):\/\/[a-zA-Z0-9._\-\[\]:]+(?::\d+)?(?:\/[a-zA-Z0-9._~\-\/]*)?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let u = m[0].replace(/[.,;)'"<>\]]+$/, '');
    // tracker 必须有端口或 announce 路径
    if (!/:\d+/.test(u) && !/\/announce/i.test(u)) continue;
    // 排除明显非 tracker 的静态资源链接
    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf)(\?|$)/i.test(u)) continue;
    if (!/\/(announce|scrape)/i.test(u) && !/^udp:/i.test(u)) {
      // http(s) tracker 一般带 /announce；无 announce 且非 udp 的只保留带端口的根路径
      if (!/:\d+\/?$/.test(u)) continue;
    }
    out.add(u);
  }
  return out;
}

/* 健康检查用的探针 infohash（Ubuntu 镜像常见 hash，仅用于探测 tracker 是否响应） */
const PROBE_INFOHASH = '9c0463c2d21c4be33ec99cb907e7e58f9e6d16a7';

/* 单个 infohash 做 peer harvest 时最多使用的 tracker 数量（按延迟取最快的若干个）。
   健康检查维护的存活池可以很大（数千个），但对每个 infohash 全量请求会造成网络风暴，
   因此 harvest 只取最快的 N 个，兼顾发现广度与请求量。 */
const HARVEST_TRACKER_LIMIT = 60;

/* 健康检查参数：两档策略。
   - 快速首轮（fast）：120 并发 × 6s 超时 → 平衡速度与系统资源（避免 fd 耗尽导致误判死亡）
   - 常规维护：100 并发 × 8s 超时 → 全量复查，给国际 tracker 足够响应时间
   存活者优先复查，连续 3 次失败标记 dead，dead 每 3 轮降频复查 1 次。
   注意：并发过高（300）会导致系统 socket/fd 耗尽，反而让正常 tracker 超时被误判死亡。 */
const HEALTH_CONCURRENCY = 100;
const HEALTH_TIMEOUT = 8000;
const FAST_CONCURRENCY = 120;
const FAST_TIMEOUT = 6000;

class TrackerManager {
  constructor(opts = {}) {
    this.trackers = new Map(); // url -> { url, alive, lastCheck, latency, fails, rounds }
    this.checkInterval = opts.checkInterval || 180000; // 3 分钟全量复查一轮（v0.8.1：从 10 分钟缩短，确保 tracker 状态新鲜）
    /* 存活池容量上限：默认 10000，向五位数级别的全网实时 tracker 看齐。
       健康检查分批并发（每批 120），harvest 只取最快的若干个，因此大池不会造成请求风暴。 */
    this.maxTrackers = opts.maxTrackers || 10000;
    this.sources = (opts.sources && opts.sources.length) ? opts.sources : DEFAULT_SOURCES.slice();
    this.lastFetch = { at: 0, sources: [] }; // 最近一次远程拉取的每源统计
    this._checkTimer = null;
    this._fetchTimer = null;
    this._checking = false;          // 全量检查锁
    this._checkingUnchecked = false; // 增量检查锁（仅查未检 tracker）
    this._deadRound = 0;
    this.started = false;
    this.firstCheckDone = false;     // 首轮快速检查是否完成
    this._healthProgress = null;     // 当前检查进度 { checked, total, alive, dead, startedAt }
    // 用静态列表播种
    for (const url of PUBLIC_TRACKERS) this._add(url);
  }

  /* 添加 tracker：按完整 URL 去重（每端点一条）。
     超出容量时优先驱逐已判定为 dead 的条目。 */
  _add(url) {
    if (!url || typeof url !== 'string') return false;
    url = url.trim();
    if (!/^(udp|https?):\/\//i.test(url)) return false;
    const key = url.toLowerCase();
    if (this.trackers.has(key)) return false;
    if (this.trackers.size >= this.maxTrackers) {
      let evictKey = null;
      for (const [k, v] of this.trackers) {
        if (v.alive === false) { evictKey = k; break; }
      }
      if (evictKey) this.trackers.delete(evictKey);
      else return false;
    }
    this.trackers.set(key, { url, alive: null, lastCheck: 0, latency: 0, fails: 0, rounds: 0 });
    return true;
  }

  /* 三阶段启动：
     Phase 1：立即对静态种子（18 个）做快速健康检查（<1s），harvest 立即有存活列表可用
     Phase 2：流式加载远程列表（每个源完成即添加 tracker），加载完成后立即触发
              增量快速检查（onlyUnchecked，120 并发 6s 超时，4000 tracker ~40s 完成）
     Phase 3：定时全量复查（3 分钟一轮，100 并发 8s 超时）—— 每轮检查全部 tracker，
              存活者复查延迟，死亡者降频（每 3 轮 1 次），确保 tracker 状态新鲜
     12 小时刷新远程列表并触发增量检查 */
  start() {
    if (this.started) return;
    this.started = true;
    // Phase 1：立即快速检查静态种子
    this.healthCheck({ fast: true, onlyUnchecked: true }).catch(() => {});
    // Phase 2：流式加载远程列表，完成后立即增量快速检查新 tracker
    this.fetchLists().then(() => {
      this.healthCheck({ fast: true, onlyUnchecked: true }).catch(() => {});
    }).catch(() => {});
    // Phase 3：定时全量复查（3 分钟一轮，检查全部 tracker，不只是 unchecked）
    this._checkTimer = setInterval(() => this.healthCheck().catch(() => {}), this.checkInterval);
    this._checkTimer.unref && this._checkTimer.unref();
    // 每 12 小时刷新远程列表并触发增量检查
    this._fetchTimer = setInterval(() => {
      this.fetchLists().catch(() => {}).then(() => {
        this.healthCheck({ fast: true, onlyUnchecked: true }).catch(() => {});
      });
    }, 12 * 3600 * 1000);
    this._fetchTimer.unref && this._fetchTimer.unref();
  }

  stop() {
    this.started = false;
    if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
    if (this._fetchTimer) { clearInterval(this._fetchTimer); this._fetchTimer = null; }
  }

  /* 拉取单个远程源的原始文本。超时 12s（文本文件，无需 20s）。 */
  async _fetchOne(src) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(src, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ikwyd-tracker-fetch/2.0)' } });
      clearTimeout(timer);
      if (!res.ok) return { source: src, ok: false, text: '', error: 'HTTP ' + res.status };
      return { source: src, ok: true, text: await res.text(), error: null };
    } catch (e) {
      return { source: src, ok: false, text: '', error: String(e && e.message || e) };
    }
  }

  /* 流式拉取远程列表：每个源完成即立即将 tracker 添加到池中（不等全部完成）。
     这意味着 newTrackon（~1-2s 返回）的 tracker 在其他 GitHub 源（~5-10s）还在下载时
     就已经可用，harvest 和健康检查可以提前开始。
     单源 12s 超时，失败源自动跳过。HTML 页面源用正则提取 tracker URL。 */
  async fetchLists() {
    const summary = new Array(this.sources.length);
    // 每个源独立处理：完成即添加 tracker 到池
    const promises = this.sources.map(async (src, i) => {
      const r = await this._fetchOne(src);
      if (!r.ok || !r.text) {
        summary[i] = { source: src, ok: false, parsed: 0, added: 0, error: r.error || 'empty' };
        return;
      }
      let candidates;
      if (HTML_SOURCE_RE.test(src)) {
        candidates = [...extractTrackersFromText(r.text)];
      } else {
        candidates = r.text.split(/\r?\n/).map(s => s.trim())
          .filter(s => /^(udp|https?):\/\//i.test(s));
      }
      let added = 0;
      for (const u of candidates) {
        if (this._add(u)) added++;
        if (this.trackers.size >= this.maxTrackers) break;
      }
      summary[i] = { source: src, ok: true, parsed: candidates.length, added, error: null };
    });
    await Promise.allSettled(promises);
    this.lastFetch = { at: Date.now(), sources: summary };
    return summary;
  }

  /* 健康检查：对 tracker 发轻量 announce（numwant=1）探测存活。
     两种模式：
     - 常规全量（默认）：100 并发 × 8s 超时，存活优先 + dead 降频（每 3 轮 1 次），每 3 分钟一轮
     - 快速增量（fast + onlyUnchecked）：120 并发 × 6s 超时，仅检查未检 tracker（alive===null）
     快速模式用于启动后快速完成首轮健康检查，常规模式用于定时维护。
     两种模式使用独立锁，互不阻塞。 */
  async healthCheck(opts = {}) {
    const fast = !!opts.fast;
    const onlyUnchecked = !!opts.onlyUnchecked;
    const concurrency = fast ? FAST_CONCURRENCY : HEALTH_CONCURRENCY;
    const timeout = fast ? FAST_TIMEOUT : HEALTH_TIMEOUT;

    // 独立锁：全量和增量互不阻塞
    if (!onlyUnchecked && this._checking) return;
    if (onlyUnchecked && this._checkingUnchecked) return;

    if (onlyUnchecked) this._checkingUnchecked = true;
    else { this._checking = true; this._deadRound++; }

    this._healthProgress = { checked: 0, total: 0, alive: 0, dead: 0, startedAt: Date.now(), fast };

    try {
      const all = Array.from(this.trackers.values());
      const targets = [];
      for (const info of all) {
        if (onlyUnchecked) {
          // 增量模式：仅检查未检查过的 tracker
          if (info.alive !== null) continue;
          targets.push(info);
        } else {
          // 全量模式：存活优先 + dead 降频
          info.rounds = (info.rounds || 0) + 1;
          if (info.alive === false && this._deadRound % 3 !== 0) continue;
          targets.push(info);
        }
      }
      this._healthProgress.total = targets.length;

      // 排序：未检优先（快速模式全是未检），存活次之，dead 最后
      targets.sort((a, b) => {
        const ax = a.alive === true ? 1 : a.alive === null ? 0 : 2;
        const bx = b.alive === true ? 1 : b.alive === null ? 0 : 2;
        return ax - bx;
      });

      let idx = 0;
      const worker = async () => {
        while (idx < targets.length) {
          const info = targets[idx++];
          const t0 = Date.now();
          try {
            const r = await scrapeTracker(info.url, PROBE_INFOHASH, { numwant: 1, timeout });
            info.lastCheck = Date.now();
            if (r && r.responded) {
              info.alive = true;
              info.latency = info.lastCheck - t0;
              info.fails = 0;
              this._healthProgress.alive++;
            } else {
              info.fails = (info.fails || 0) + 1;
              if (info.fails >= 3) { info.alive = false; this._healthProgress.dead++; }
            }
          } catch (_) {
            info.lastCheck = Date.now();
            info.fails = (info.fails || 0) + 1;
            if (info.fails >= 3) { info.alive = false; this._healthProgress.dead++; }
          }
          this._healthProgress.checked++;
        }
      };
      const workers = [];
      for (let i = 0; i < concurrency; i++) workers.push(worker());
      await Promise.allSettled(workers);

      if (onlyUnchecked && !this.firstCheckDone) this.firstCheckDone = true;
    } finally {
      if (onlyUnchecked) this._checkingUnchecked = false;
      else this._checking = false;
      this._healthProgress = null;
    }
  }

  /* 返回当前存活的 tracker 列表。
     首轮检查完成前（无任何 alive）回退为全部，避免 harvest 空跑。 */
  getAlive() {
    const alive = [];
    let anyChecked = false;
    for (const info of this.trackers.values()) {
      if (info.alive === true) alive.push(info.url);
      if (info.alive !== null) anyChecked = true;
    }
    if (alive.length) return alive;
    if (!anyChecked) return Array.from(this.trackers.values()).map(t => t.url); // 预热阶段
    return alive; // 已检查但全部 dead → 返回空
  }

  /* 返回延迟最低的前 limit 个存活 tracker（用于每个 infohash 的 harvest）。
     预热阶段（尚无任何已检查项）回退为前 limit 个已知 tracker，避免 harvest 空跑。 */
  getBest(limit = HARVEST_TRACKER_LIMIT) {
    const alive = [];
    let anyChecked = false;
    for (const info of this.trackers.values()) {
      if (info.alive === true) alive.push(info);
      if (info.alive !== null) anyChecked = true;
    }
    if (alive.length) {
      alive.sort((a, b) => (a.latency || 1e9) - (b.latency || 1e9));
      return alive.slice(0, limit).map(t => t.url);
    }
    if (!anyChecked) return Array.from(this.trackers.values()).slice(0, limit).map(t => t.url); // 预热阶段
    return [];
  }

  getStats() {
    let alive = 0, dead = 0, total = 0, latSum = 0, latN = 0;
    for (const info of this.trackers.values()) {
      total++;
      if (info.alive === true) {
        alive++;
        if (info.latency) { latSum += info.latency; latN++; }
      } else if (info.alive === false) {
        dead++;
      }
    }
    const stats = { total, alive, dead, unchecked: total - alive - dead,
      avgLatency: latN ? Math.round(latSum / latN) : 0,
      sources: this.sources.length, maxTrackers: this.maxTrackers,
      checking: this._checking,
      firstCheckDone: this.firstCheckDone,
      lastFetchAt: this.lastFetch.at, fetchSources: this.lastFetch.sources };
    // 健康检查进度（检查进行中时返回实时进度）
    if (this._healthProgress) {
      const p = this._healthProgress;
      stats.healthProgress = {
        checked: p.checked, total: p.total, alive: p.alive, dead: p.dead,
        pct: p.total > 0 ? Math.round(p.checked * 100 / p.total) : 0,
        elapsed: Date.now() - p.startedAt,
        fast: p.fast,
      };
    }
    return stats;
  }

  /* 返回 tracker 详情列表。
     排序：存活在前（按延迟升序）→ 未检 → 死亡在后（按失败次数升序）。
     limit=null 或不传 → 返回全部（监控 WebUI 全量展示 + 滚轮查看）。 */
  getTopTrackers(limit = null) {
    const list = Array.from(this.trackers.values()).map(t => ({
      url: t.url,
      alive: t.alive,
      latency: t.latency || 0,
      fails: t.fails || 0,
      lastCheck: t.lastCheck || 0,
    }));
    list.sort((a, b) => {
      const ax = a.alive === true ? 0 : a.alive === false ? 2 : 1;
      const bx = b.alive === true ? 0 : b.alive === false ? 2 : 1;
      if (ax !== bx) return ax - bx;
      if (ax === 2) return a.fails - b.fails; // 死亡组内按失败次数升序
      return a.latency - b.latency;
    });
    return limit == null ? list : list.slice(0, limit);
  }

  /* getAllTrackers：getTopTrackers(null) 的语义化别名，监控 API 使用 */
  getAllTrackers() { return this.getTopTrackers(null); }

  /* 手动添加 tracker（支持批量，自动去重，立即触发健康检查）。
     输入：字符串（换行/逗号/空格分隔）或字符串数组。
     返回：{ added, duplicates, errors } */
  addTrackers(input) {
    const urls = typeof input === 'string'
      ? input.split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean)
      : Array.isArray(input) ? input.map(s => s.trim()).filter(Boolean) : [];
    const result = { added: 0, duplicates: 0, errors: [] };
    const newUrls = [];
    for (const u of urls) {
      if (!/^(udp|https?):\/\//i.test(u)) { result.errors.push(u); continue; }
      if (this._add(u)) { result.added++; newUrls.push(u); }
      else result.duplicates++;
    }
    // 立即对新添加的 tracker 触发增量健康检查
    if (newUrls.length && this.started) {
      this.healthCheck({ fast: true, onlyUnchecked: true }).catch(() => {});
    }
    return result;
  }

  /* 手动删除 tracker */
  removeTracker(url) {
    const key = String(url).trim().toLowerCase();
    return this.trackers.delete(key);
  }
}

/* 模块级默认管理器实例；调用 trackerManager.start() 后 harvest 优先使用其存活列表 */
const trackerManager = new TrackerManager();
let _manager = null;
function setManager(m) { _manager = m; }

/* 对一个 infohash 遍历多个 tracker，聚合 peer 事件。
   优先使用 TrackerManager.getBest()（延迟最低的前 N 个存活 tracker）；未启动时回退到静态 PUBLIC_TRACKERS。
   v2 (64-hex)：HTTP tracker 用完整 32 字节 announce；UDP tracker 截断为 20 字节（BEP-52 DHT/UDP 约定）。
   返回 { peers, ipv6Peers }，并通过 valueOf 保持对旧版数值算术的兼容。 */
async function harvest(infohashHex, onObservation, opts = {}) {
  const mgr = _manager || trackerManager;
  const limit = opts.limit || HARVEST_TRACKER_LIMIT;
  const list = mgr.started ? mgr.getBest(limit) : PUBLIC_TRACKERS;
  const seenV4 = new Set();
  const seenV6 = new Set();
  const batchSize = 5;
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(t => scrapeTracker(t, infohashHex).catch(() => ({ peers: [], peers6: [] })))
    );
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      for (const p of (r.value.peers || [])) {
        const key = p.ip + ':' + p.port;
        if (seenV4.has(key)) continue;
        seenV4.add(key);
        onObservation({ ip: p.ip, port: p.port, infohash: infohashHex, source: 'tracker', ts: Date.now() });
      }
      for (const p of (r.value.peers6 || [])) {
        const key = '[' + p.ip + ']:' + p.port;
        if (seenV6.has(key)) continue;
        seenV6.add(key);
        onObservation({ ip: p.ip, port: p.port, infohash: infohashHex, source: 'tracker', ts: Date.now() });
      }
    }
  }
  const total = seenV4.size + seenV6.size;
  const ret = { peers: total, ipv6Peers: seenV6.size };
  // 旧调用方做数值算术（如 service.js: counter + found）时退化为 total
  ret.valueOf = () => total;
  return ret;
}

module.exports = {
  scrapeTracker,
  scrapeHTTP,
  scrapeUDP,
  harvest,
  parseCompactPeers,
  parseCompactPeers6,
  extractTrackersFromText,
  PUBLIC_TRACKERS,
  DEFAULT_SOURCES,
  TrackerManager,
  trackerManager,
  setManager,
};
