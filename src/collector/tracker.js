'use strict';
/* Tracker 抓取器（HTTP announce + UDP announce）。
   - HTTP tracker（BEP-3 / BEP-23 紧凑 peer 格式，BEP-7 peers6 IPv6）
   - UDP tracker（BEP-15，UDP tracker 协议；udp6 socket 支持 IPv6 tracker）
   对已发现的 infohash 向公共 tracker 请求 peer 列表，事件进 pipeline。
   仅做 announce 级别的握手信息交换，不传输任何内容数据。 */
const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns');
const bencode = require('../common/bencode');
const { formatIPv6, isIPv6 } = require('../common/util');

const { lookup: dnsLookup } = dns.promises;

/* 全球公共 tracker 种子列表（HTTP + UDP，覆盖各地区）。
   已按 hostname 去重：每个主机只保留一个最可靠的入口（优先 UDP）。 */
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
  // HTTP / HTTPS trackers（仅保留无 UDP 对应的主机）
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

/* 按 hostname 去重（同一主机的 http/https/udp 视为同一 tracker）。
   保护性去重：即使后续手工编辑 RAW_TRACKERS 也不会出现主机重复。 */
const PUBLIC_TRACKERS = (() => {
  const seen = new Set();
  const out = [];
  for (const u of RAW_TRACKERS) {
    const h = _hostOf(u);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(u);
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
   标准 BEP-15 仅定义 IPv4；此处兼容非标准的混合/纯 IPv6 响应。
   - familyHint='ipv6' 且缓冲区 18 字节对齐：整体按 IPv6 解析
   - 否则：先按 6 字节解析 IPv4，尾部 18 字节对齐的余量按 IPv6 解析 */
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

/* ---------- HTTP tracker（BEP-3 / BEP-7） ---------- */
async function scrapeHTTP(trackerUrl, infohashHex, opts = {}) {
  const infohash = Buffer.from(infohashHex, 'hex');
  const peerId = crypto.randomBytes(20);
  const rawInfo = [...infohash].map(b => '%' + b.toString(16).padStart(2, '0')).join('');
  const rawPeer = [...peerId].map(b => '%' + b.toString(16).padStart(2, '0')).join('');
  const url = `${trackerUrl}?info_hash=${rawInfo}&peer_id=${rawPeer}&port=${opts.port || 6881}` +
    `&uploaded=0&downloaded=0&left=1&compact=1&event=started&numwant=${opts.numwant == null ? 80 : opts.numwant}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'uTorrent/3.5.5' } });
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

/* 对单个已解析地址执行 connect→announce 流程；family 为 4 或 6 */
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
    const infohash = Buffer.from(infohashHex, 'hex');
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
/* 远程公开 tracker 列表源：全网聚合 + 实时存活检测。
   目标是尽可能覆盖“全网实时更新的开放 tracker”，因此同时使用：
   1) newTrackon —— 一个持续对全网开放 tracker 做存活探测的实时服务（api/all 返回当前有响应的全部 tracker）；
   2) 多个每日机器人自动更新的社区聚合列表（ngosang / XIU2 / DeSireFire / adysec）；
   3) 上述列表的 CDN / 镜像地址（jsDelivr、cf.trackerslist.com），供 GitHub 访问受限的网络回退。
   所有来源在拉取后按 hostname 去重合并，失败来源自动跳过。 */
const DEFAULT_SOURCES = [
  // 实时存活服务：newTrackon 持续探测全网开放 tracker
  'https://newtrackon.com/api/all',
  // 社区每日自动更新的聚合列表（GitHub 原始地址）
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ip.txt',
  'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt',
  'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_all.txt',
  'https://raw.githubusercontent.com/adysec/tracker/main/trackers_best.txt',
  // CDN / 镜像回退（GitHub 直连受限时仍可获取到最新列表）
  'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_all.txt',
  'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection@master/all.txt',
  'https://cf.trackerslist.com/all.txt',
];

/* 健康检查用的探针 infohash（Ubuntu 镜像常见 hash，仅用于探测 tracker 是否响应） */
const PROBE_INFOHASH = '9c0463c2d21c4be33ec99cb907e7e58f9e6d16a7';

/* 单个 infohash 做 peer harvest 时最多使用的 tracker 数量（按延迟取最快的若干个）。
   健康检查维护的存活池可以很大（数百个），但对每个 infohash 全量请求会造成网络风暴，
   因此 harvest 只取最快的 N 个，兼顾发现广度与请求量。 */
const HARVEST_TRACKER_LIMIT = 60;

class TrackerManager {
  constructor(opts = {}) {
    this.trackers = new Map(); // url -> { url, alive, lastCheck, latency, fails }
    this.hosts = new Map();    // hostname -> url（主机级去重，同一主机只保留一个入口，优先 UDP）
    this.checkInterval = opts.checkInterval || 300000; // 5 分钟检查一次
    /* 存活池容量上限：默认 1500，尽可能多地保留全网实时 tracker（当前各源去重后约 1000+ 个）。
       健康检查分批并发（每批 40），harvest 只取最快的若干个，因此大池不会造成请求风暴。 */
    this.maxTrackers = opts.maxTrackers || 1500;
    this.sources = (opts.sources && opts.sources.length) ? opts.sources : DEFAULT_SOURCES.slice();
    this.lastFetch = { at: 0, sources: [] }; // 最近一次远程拉取的每源统计
    this._checkTimer = null;
    this._fetchTimer = null;
    this.started = false;
    // 用静态列表播种
    for (const url of PUBLIC_TRACKERS) this._add(url);
  }

  /* 添加 tracker：
     - 先按 hostname 去重（同一主机的 http/https/udp 视为同一 tracker，优先保留 UDP）；
     - 超出容量时优先驱逐已判定为 dead 的条目。 */
  _add(url) {
    if (!url || typeof url !== 'string') return false;
    url = url.trim();
    if (!/^(udp|https?):\/\//i.test(url)) return false;
    if (this.trackers.has(url)) return false;
    const host = _hostOf(url);
    const existing = this.hosts.get(host);
    if (existing) {
      // 同主机已存在：若新条目为 UDP 而旧条目不是，则用 UDP 替换（UDP 更快更稳）
      const newIsUdp = url.startsWith('udp://');
      const oldIsUdp = existing.startsWith('udp://');
      if (newIsUdp && !oldIsUdp) {
        this.trackers.delete(existing);
        this.trackers.set(url, { url, alive: null, lastCheck: 0, latency: 0, fails: 0 });
        this.hosts.set(host, url);
        return true;
      }
      return false;
    }
    if (this.trackers.size >= this.maxTrackers) {
      let evictKey = null;
      for (const [k, v] of this.trackers) {
        if (v.alive === false) { evictKey = k; break; }
      }
      if (evictKey) { this.trackers.delete(evictKey); this.hosts.delete(_hostOf(evictKey)); }
      else return false;
    }
    this.trackers.set(url, { url, alive: null, lastCheck: 0, latency: 0, fails: 0 });
    this.hosts.set(host, url);
    return true;
  }

  start() {
    if (this.started) return;
    this.started = true;
    // 启动即触发一次健康检查与远程拉取
    this.healthCheck().catch(() => {});
    this.fetchLists().catch(() => {});
    this._checkTimer = setInterval(() => this.healthCheck().catch(() => {}), this.checkInterval);
    this._checkTimer.unref && this._checkTimer.unref();
    // 每 24 小时从远程列表拉取并补充新 tracker
    this._fetchTimer = setInterval(() => this.fetchLists().catch(() => {}), 24 * 3600 * 1000);
    this._fetchTimer.unref && this._fetchTimer.unref();
  }

  stop() {
    this.started = false;
    if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
    if (this._fetchTimer) { clearInterval(this._fetchTimer); this._fetchTimer = null; }
  }

  /* 拉取单个远程源的原始文本（不做合并，便于按优先级统一合并）。 */
  async _fetchOne(src) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(src, { signal: ctrl.signal, headers: { 'User-Agent': 'ikwyd-tracker-fetch/1.0' } });
      clearTimeout(timer);
      if (!res.ok) return { source: src, ok: false, text: '', error: 'HTTP ' + res.status };
      return { source: src, ok: true, text: await res.text(), error: null };
    } catch (e) {
      return { source: src, ok: false, text: '', error: String(e && e.message || e) };
    }
  }

  /* 并行拉取所有远程列表（单源 15s 超时，失败源自动跳过），
     再按 sources 声明顺序（实时存活源优先）合并，避免先到达的大列表占满容量。
     记录每源的解析/新增数量供监控展示。 */
  async fetchLists() {
    const fetched = await Promise.allSettled(this.sources.map(src => this._fetchOne(src)));
    const summary = [];
    for (let i = 0; i < this.sources.length; i++) {
      const src = this.sources[i];
      const r = fetched[i];
      if (r.status !== 'fulfilled' || !r.value.ok || !r.value.text) {
        const err = r.status === 'fulfilled' ? r.value.error : String(r.reason && r.reason.message || r.reason);
        summary.push({ source: src, ok: false, parsed: 0, added: 0, error: err || 'empty' });
        continue;
      }
      let parsed = 0, added = 0;
      for (const line of r.value.text.split(/\r?\n/)) {
        const u = line.trim();
        if (!u || !/^(udp|https?):\/\//i.test(u)) continue;
        parsed++;
        if (this._add(u)) added++;
        if (this.trackers.size >= this.maxTrackers) break;
      }
      summary.push({ source: src, ok: true, parsed, added, error: null });
    }
    this.lastFetch = { at: Date.now(), sources: summary };
    return summary;
  }

  /* 健康检查：对每个 tracker 发轻量 announce（numwant=1），记录延迟与存活。
     连续 3 次失败标记为 dead（从活跃列表移除）。 */
  async healthCheck() {
    const batch = [];
    const flush = async () => { if (batch.length) await Promise.allSettled(batch.splice(0)); };
    for (const info of this.trackers.values()) {
      batch.push((async () => {
        const t0 = Date.now();
        try {
          const r = await scrapeTracker(info.url, PROBE_INFOHASH, { numwant: 1, timeout: 6000 });
          info.lastCheck = Date.now();
          if (r && r.responded) {
            info.alive = true;
            info.latency = info.lastCheck - t0;
            info.fails = 0;
          } else {
            info.fails = (info.fails || 0) + 1;
            if (info.fails >= 3) info.alive = false;
          }
        } catch (_) {
          info.lastCheck = Date.now();
          info.fails = (info.fails || 0) + 1;
          if (info.fails >= 3) info.alive = false;
        }
      })());
      if (batch.length >= 40) await flush();
    }
    await flush();
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
    if (!anyChecked) return Array.from(this.trackers.keys()); // 预热阶段
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
    if (!anyChecked) return Array.from(this.trackers.keys()).slice(0, limit); // 预热阶段
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
    return { total, alive, dead, avgLatency: latN ? Math.round(latSum / latN) : 0,
      sources: this.sources.length, maxTrackers: this.maxTrackers,
      lastFetchAt: this.lastFetch.at, fetchSources: this.lastFetch.sources };
  }

  /* 返回按延迟升序的 tracker 详情列表（用于监控 WebUI 展示） */
  getTopTrackers(limit = 20) {
    const list = Array.from(this.trackers.values()).map(t => ({
      url: t.url,
      alive: t.alive,
      latency: t.latency || 0,
      fails: t.fails || 0,
      lastCheck: t.lastCheck || 0,
    }));
    // 排序：存活优先，按延迟升序，未检查的放最后
    list.sort((a, b) => {
      const ax = a.alive === true ? 0 : a.alive === false ? 2 : 1;
      const bx = b.alive === true ? 0 : b.alive === false ? 2 : 1;
      if (ax !== bx) return ax - bx;
      return a.latency - b.latency;
    });
    return list.slice(0, limit);
  }
}

/* 模块级默认管理器实例；调用 trackerManager.start() 后 harvest 优先使用其存活列表 */
const trackerManager = new TrackerManager();
let _manager = null;
function setManager(m) { _manager = m; }

/* 对一个 infohash 遍历多个 tracker，聚合 peer 事件。
   优先使用 TrackerManager.getBest()（延迟最低的前 N 个存活 tracker）；未启动时回退到静态 PUBLIC_TRACKERS。
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
  PUBLIC_TRACKERS,
  TrackerManager,
  trackerManager,
  setManager,
};
