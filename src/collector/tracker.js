'use strict';
/* Tracker 抓取器（HTTP announce + UDP announce）。
   - HTTP tracker（BEP-3 / BEP-23 紧凑 peer 格式）
   - UDP tracker（BEP-15，UDP tracker 协议）
   对已发现的 infohash 向公共 tracker 请求 peer 列表，事件进 pipeline。
   仅做 announce 级别的握手信息交换，不传输任何内容数据。 */
const crypto = require('crypto');
const dgram = require('dgram');
const bencode = require('../common/bencode');

/* 全球公共 tracker 列表（HTTP + UDP，覆盖各地区） */
const PUBLIC_TRACKERS = [
  // HTTP trackers
  'http://tracker.openbittorrent.com:80/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'http://open.tracker.cl:1337/announce',
  'http://tracker.tiny-vps.com:6969/announce',
  'http://tracker.dler.org:6969/announce',
  'http://tracker.tamersunion.org:443/announce',
  'http://bt1.archive.org:6969/announce',
  'http://bt2.archive.org:6969/announce',
  'http://tracker2.dler.org:80/announce',
  'http://tracker4.itzmx.com:2710/announce',
  'http://tracker.bt4g.com:2095/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.dler.org:6969/announce',
  // UDP trackers
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.openbittorrent.com:80/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://retracker01-msk-virt.corbina.net:80/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker4.itzmx.com:2710/announce',
  'udp://tracker1.bt.moack.co:80/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker2.dler.org:80/announce',
];

function parseCompactPeers(buf) {
  const out = [];
  if (!Buffer.isBuffer(buf)) return out;
  for (let i = 0; i + 6 <= buf.length; i += 6) {
    out.push({ ip: [...buf.slice(i, i + 4)].join('.'), port: buf.readUInt16BE(i + 4) });
  }
  return out;
}

/* ---------- HTTP tracker（BEP-3） ---------- */
async function scrapeHTTP(trackerUrl, infohashHex, opts = {}) {
  const infohash = Buffer.from(infohashHex, 'hex');
  const peerId = crypto.randomBytes(20);
  const rawInfo = [...infohash].map(b => '%' + b.toString(16).padStart(2, '0')).join('');
  const rawPeer = [...peerId].map(b => '%' + b.toString(16).padStart(2, '0')).join('');
  const url = `${trackerUrl}?info_hash=${rawInfo}&peer_id=${rawPeer}&port=${opts.port || 6881}` +
    `&uploaded=0&downloaded=0&left=1&compact=1&event=started&numwant=${opts.numwant || 80}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'uTorrent/3.5.5' } });
    const body = Buffer.from(await res.arrayBuffer());
    const decoded = bencode.decode(body);
    if (decoded['failure reason']) return { peers: [], error: decoded['failure reason'].toString() };
    return { peers: parseCompactPeers(decoded.peers), interval: decoded.interval || 1800, complete: decoded.complete, incomplete: decoded.incomplete };
  } catch (e) {
    return { peers: [], error: String(e && e.message || e) };
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

async function scrapeUDP(trackerUrl, infohashHex, opts = {}) {
  return new Promise((resolve) => {
    const m = trackerUrl.match(/^udp:\/\/([^:\/]+):(\d+)/);
    if (!m) return resolve({ peers: [], error: 'invalid udp url' });
    const host = m[1];
    const port = parseInt(m[2], 10);
    const sock = dgram.createSocket('udp4');
    const timeout = 8000;
    const result = { peers: [] };
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

    timer = setTimeout(() => finish(result), timeout);
    sock.on('error', () => finish(result));

    // Step 1: connect request
    const connectReq = Buffer.alloc(16);
    connectReq.writeBigUInt64BE(UDP_CONNECT_MAGIC, 0);
    connectReq.writeUInt32BE(0, 8); // action = 0 (connect)
    connectReq.writeUInt32BE(transactionId.readUInt32BE(0), 12);
    sock.send(connectReq, port, host);

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
        announceReq.writeInt32BE(opts.numwant || 80, 92); // numwant
        announceReq.writeUInt16BE(opts.port || 6881, 96); // port
        sock.send(announceReq, port, host);
      } else if (action === 1) {
        // announce response
        // offset 8: interval, 12: leechers, 16: seeders, 20+: peers (6 bytes each)
        if (msg.length > 20) {
          result.peers = parseCompactPeers(msg.slice(20));
        }
        finish(result);
      }
    });
  });
}

/* 统一入口：自动判断 HTTP / UDP */
async function scrapeTracker(trackerUrl, infohashHex, opts = {}) {
  if (trackerUrl.startsWith('udp://')) return scrapeUDP(trackerUrl, infohashHex, opts);
  return scrapeHTTP(trackerUrl, infohashHex, opts);
}

/* 对一个 infohash 遍历多个 tracker，聚合 peer 事件 */
async function harvest(infohashHex, onObservation) {
  const seen = new Set();
  // 并发请求多个 tracker（分批避免瞬时连接爆炸）
  const batchSize = 5;
  for (let i = 0; i < PUBLIC_TRACKERS.length; i += batchSize) {
    const batch = PUBLIC_TRACKERS.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(t => scrapeTracker(t, infohashHex).catch(() => ({ peers: [] })))
    );
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      for (const p of r.value.peers) {
        const key = p.ip + ':' + p.port;
        if (seen.has(key)) continue;
        seen.add(key);
        onObservation({ ip: p.ip, port: p.port, infohash: infohashHex, source: 'tracker', ts: Date.now() });
      }
    }
  }
  return seen.size;
}

module.exports = { scrapeTracker, scrapeHTTP, scrapeUDP, harvest, PUBLIC_TRACKERS };
