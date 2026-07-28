'use strict';
/* PEX (Peer Exchange) 模块（BEP-11 ut_pex 扩展）：
   在已有的 BT TCP 连接（metadata fetch 复用）上发送/接收 ut_pex 消息，
   从中提取新增 peer（包含 IPv4 / IPv6 / 加密端口），事件交 pipeline.ingest。
   PEX 是 BitTorrent 网络中 peer 自组织发现的核心机制，无需 tracker 即可扩散。 */
const net = require('net');
const crypto = require('crypto');
const bencode = require('../common/bencode');

const PSTR = Buffer.from('BitTorrent protocol');
const EXT_HANDSHAKE_ID = 0;
const UT_PEX_ID = 1; // 本地分配的 ut_pex 扩展 ID

/* 解析 PEX 消息（ut_pex payload 中的 added / added6 等） */
function parsePexPayload(payload) {
  const out = [];
  try {
    const d = bencode.decode(payload);
    // added: IPv4 compact peers（6 字节一组: 4 IP + 2 port）
    if (d.added && Buffer.isBuffer(d.added)) {
      for (let i = 0; i + 6 <= d.added.length; i += 6) {
        const ip = [...d.added.slice(i, i + 4)].join('.');
        const port = d.added.readUInt16BE(i + 4);
        if (port > 0) out.push({ ip, port, family: 'ipv4' });
      }
    }
    // added6: IPv6 compact peers（18 字节一组: 16 IP + 2 port）
    if (d.added6 && Buffer.isBuffer(d.added6)) {
      for (let i = 0; i + 18 <= d.added6.length; i += 18) {
        const ipBytes = d.added6.slice(i, i + 16);
        const port = d.added6.readUInt16BE(i + 16);
        if (port > 0) {
          const ip = formatIPv6(ipBytes);
          out.push({ ip, port, family: 'ipv6' });
        }
      }
    }
  } catch (_) {}
  return out;
}

function formatIPv6(buf) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
  return parts.join(':');
}

/* 向 peer 发起 BT 握手并请求 ut_pex 扩展，收集 PEX 返回的 peer 列表。
   返回 Promise<{peers, infohash}> */
function pexFromPeer(ip, port, infohashHex, opts = {}) {
  return new Promise((resolve) => {
    const infohash = Buffer.from(infohashHex, 'hex');
    const peerId = crypto.randomBytes(20);
    const sock = new net.Socket();
    sock.setTimeout(opts.timeout || 8000);
    let buffer = Buffer.alloc(0);
    let hsDone = false;
    let pexExtId = null;
    const result = { peers: [], infohash: infohashHex };
    const done = () => { try { sock.destroy(); } catch (_) {} resolve(result); };
    const timer = setTimeout(done, opts.timeout || 8000);

    sock.connect(port, ip, () => {
      const reserved = Buffer.alloc(8);
      reserved[5] = 0x10; // 支持扩展协议 (BEP-10)
      const hs = Buffer.concat([Buffer.from([19]), PSTR, reserved, infohash, peerId]);
      sock.write(hs);
    });

    sock.on('error', () => { clearTimeout(timer); done(); });
    sock.on('timeout', () => { clearTimeout(timer); done(); });
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (!hsDone) {
          if (buffer.length < 68) return;
          const pstrlen = buffer[0];
          if (buffer.slice(1, 1 + pstrlen).toString() !== PSTR.toString()) { clearTimeout(timer); return done(); }
          buffer = buffer.slice(68);
          hsDone = true;
          // 发送扩展握手，声明支持 ut_pex
          const extHs = bencode.encode({
            m: { ut_pex: UT_PEX_ID, ut_metadata: 2 },
            v: 'ikwyd-pex/0.1',
            reqq: 255,
          });
          sendExt(sock, EXT_HANDSHAKE_ID, extHs);
          // 主动请求 PEX（发送空的 ut_pex 消息触发对方回传）
          if (pexExtId) {
            sendExt(sock, pexExtId, bencode.encode({ added: Buffer.alloc(0) }));
          }
        }
        for (;;) {
          if (buffer.length < 4) return;
          const len = buffer.readUInt32BE(0);
          if (len === 0) { buffer = buffer.slice(4); continue; }
          if (buffer.length < 4 + len) return;
          const msg = buffer.slice(4, 4 + len);
          buffer = buffer.slice(4 + len);
          if (msg[0] !== 20) continue; // 只处理扩展消息
          const extId = msg[1];
          const payload = msg.slice(2);
          if (extId === EXT_HANDSHAKE_ID) {
            const h = bencode.decode(payload);
            if (h.m && h.m.ut_pex) {
              pexExtId = h.m.ut_pex;
              // 立即请求 PEX
              sendExt(sock, pexExtId, bencode.encode({ added: Buffer.alloc(0) }));
            }
          } else if (extId === UT_PEX_ID || (pexExtId && extId === pexExtId)) {
            // 收到 PEX 响应
            const peers = parsePexPayload(payload);
            result.peers.push(...peers);
            clearTimeout(timer);
            return done();
          }
        }
      } catch (_) { clearTimeout(timer); done(); }
    });
  });

  function sendExt(s, id, payload) {
    const body = Buffer.concat([Buffer.from([20, id]), payload]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    s.write(Buffer.concat([len, body]));
  }
}

/* 对一个 infohash 的多个 peer 执行 PEX 收集，聚合所有新发现的 peer。
   onObservation 回调对每个新 peer 调用。 */
async function harvest(infohashHex, seedPeers, onObservation) {
  const seen = new Set();
  const discovered = [];
  for (const p of seedPeers.slice(0, 8)) {
    try {
      const r = await pexFromPeer(p.ip, p.port, infohashHex);
      for (const peer of r.peers) {
        const key = peer.ip + ':' + peer.port;
        if (seen.has(key)) continue;
        seen.add(key);
        discovered.push(peer);
        if (onObservation) {
          onObservation({
            ip: peer.ip,
            port: peer.port,
            infohash: infohashHex,
            source: 'pex',
            ts: Date.now(),
          });
        }
      }
    } catch (_) {}
  }
  return discovered;
}

module.exports = { pexFromPeer, harvest, parsePexPayload, UT_PEX_ID };
