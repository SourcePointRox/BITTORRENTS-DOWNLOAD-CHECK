'use strict';
/* PEX (Peer Exchange) 模块（BEP-11 ut_pex 扩展）：
   与 peer 建立 BT 连接（MSE/PE 加密优先，失败回退明文）→ 扩展握手声明 ut_pex →
   发送 interested（部分客户端只对感兴趣的连接推送 PEX）→ 收集 added/added6。
   PEX 是 BitTorrent 网络中 peer 自组织发现的核心机制，无需 tracker 即可扩散。

   旧版缺陷修复：
   - 串行连接 8 个 peer × 8s 超时 → 每轮最坏 64s，与 45s 调度叠加 → 改为并行批量；
   - 仅明文握手 → 大量强制加密的 peer（qBittorrent/Transmission 默认 prefer-encrypt）拒绝；
   - 从不发送 interested → 很多客户端不向"无兴趣"连接推送 PEX 列表；
   - 收到第一条 PEX 立即断开 → 改为挂起收集窗口内多条增量推送。 */
const net = require('net');
const crypto = require('crypto');
const bencode = require('../common/bencode');
const { initiateMSE } = require('./mse');
const { isV2Infohash } = require('../common/util');

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

function sendExt(sock, enc, id, payload) {
  const body = Buffer.concat([Buffer.from([20, id]), payload]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const data = Buffer.concat([len, body]);
  sock.write(enc ? enc.process(data) : data);
}

function sendSimple(sock, enc, id) {
  const body = Buffer.from([id]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const data = Buffer.concat([len, body]);
  sock.write(enc ? enc.process(data) : data);
}

/* 向单个 peer 发起连接并收集 PEX 列表。
   流程：MSE 加密握手（失败回退明文）→ BT 握手 → 扩展握手(ut_pex+ut_metadata) →
        interested → 等对方扩展握手拿到 ut_pex id → 触发 PEX → 收集窗口内多条推送。
   opts.collectMs：拿到首个 PEX 后再挂起收集增量的时间（默认 2500ms）。
   返回 Promise<{peers, infohash, encrypted}> */
function pexFromPeer(ip, port, infohashHex, opts = {}) {
  return new Promise((resolve) => {
    const isV2 = isV2Infohash(infohashHex);
    const infohash = Buffer.from(isV2 ? infohashHex.slice(0, 40) : infohashHex, 'hex');
    const peerId = crypto.randomBytes(20);
    const sock = new net.Socket();
    const timeout = opts.timeout || 9000;
    const collectMs = opts.collectMs || 2500;
    let buffer = Buffer.alloc(0);
    let hsDone = false;
    let extHsDone = false;
    let pexExtId = null;
    let enc = null, dec = null;
    const result = { peers: [], infohash: infohashHex, encrypted: false };
    let collectTimer = null;
    const seen = new Set();

    const done = () => {
      if (collectTimer) clearTimeout(collectTimer);
      clearTimeout(timer);
      try { sock.destroy(); } catch (_) {}
      resolve(result);
    };
    const timer = setTimeout(done, timeout);

    const addPeers = (peers) => {
      for (const p of peers) {
        const key = p.ip + ':' + p.port;
        if (seen.has(key)) continue;
        seen.add(key);
        result.peers.push(p);
      }
    };

    // 拿到首个 PEX 后再挂起 collectMs 收集增量推送
    const startCollectWindow = () => {
      if (collectTimer) return;
      collectTimer = setTimeout(done, collectMs);
    };

    const btHandshake = (() => {
      const reserved = Buffer.alloc(8);
      reserved[5] = 0x10; // 支持扩展协议 (BEP-10)
      reserved[7] = 0x10; // 支持 BitTorrent v2 / Hybrid (BEP-52)
      return Buffer.concat([Buffer.from([19]), PSTR, reserved, infohash, peerId]);
    })();

    function processBuffer() {
      if (!hsDone) return;
      try {
        for (;;) {
          if (buffer.length < 4) return;
          const len = buffer.readUInt32BE(0);
          if (len === 0) { buffer = buffer.slice(4); continue; }
          if (buffer.length < 4 + len) return;
          const msg = buffer.slice(4, 4 + len);
          buffer = buffer.slice(4 + len);
          const id = msg[0];
          if (id === 20) { // 扩展消息
            const extId = msg[1];
            const payload = msg.slice(2);
            if (extId === EXT_HANDSHAKE_ID && !extHsDone) {
              extHsDone = true;
              const h = bencode.decode(payload);
              if (h.m && h.m.ut_pex != null) {
                pexExtId = typeof h.m.ut_pex === 'number' ? h.m.ut_pex : Number(h.m.ut_pex);
                // 触发对方回传 PEX 列表
                sendExt(sock, enc, pexExtId, bencode.encode({ added: Buffer.alloc(0) }));
                // 30s 内没收到 PEX 也要收尾
                startCollectWindow();
              } else {
                // 对方不支持 ut_pex → 结束
                return done();
              }
            } else if (pexExtId != null && extId === pexExtId) {
              addPeers(parsePexPayload(payload));
              startCollectWindow(); // 每条 PEX 后重置收集窗口
            }
          }
          // 其它消息（bitfield/have/piece 等）忽略，继续等 PEX
        }
      } catch (_) { done(); }
    }

    sock.on('error', done);
    sock.connect(port, ip, async () => {
      // 先尝试 MSE/PE 加密握手（大量客户端默认 prefer/require 加密）
      const mseResult = await initiateMSE(sock, infohashHex, btHandshake, 5000);
      if (mseResult) {
        result.encrypted = true;
        enc = mseResult.encrypt;
        dec = mseResult.decrypt;
        const ib = mseResult.ia;
        if (ib.length < 68) return done();
        const pstrlen = ib[0];
        if (ib.slice(1, 1 + pstrlen).toString() !== PSTR.toString()) return done();
        const gotHash = ib.slice(1 + pstrlen + 8, 1 + pstrlen + 28);
        if (!gotHash.equals(infohash)) return done();
        hsDone = true;
        if (mseResult.remaining && mseResult.remaining.length > 0) {
          buffer = Buffer.concat([buffer, dec ? dec.process(mseResult.remaining) : mseResult.remaining]);
        }
        sock.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, dec ? dec.process(chunk) : chunk]);
          processBuffer();
        });
        // 扩展握手 + interested（很多客户端只对 interested 连接推送 PEX）
        sendExt(sock, enc, EXT_HANDSHAKE_ID, bencode.encode({
          m: { ut_pex: UT_PEX_ID, ut_metadata: 2 },
          v: 'qBittorrent/4.6.0',
          reqq: 255,
        }));
        sendSimple(sock, enc, 2); // interested
        processBuffer();
      } else {
        // 回退明文
        sock.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (!hsDone) {
            if (buffer.length < 68) return;
            const pstrlen = buffer[0];
            if (buffer.slice(1, 1 + pstrlen).toString() !== PSTR.toString()) return done();
            const gotHash = buffer.slice(1 + pstrlen + 8, 1 + pstrlen + 28);
            if (!gotHash.equals(infohash)) return done();
            buffer = buffer.slice(1 + pstrlen + 48);
            hsDone = true;
            sendExt(sock, null, EXT_HANDSHAKE_ID, bencode.encode({
              m: { ut_pex: UT_PEX_ID, ut_metadata: 2 },
              v: 'qBittorrent/4.6.0',
              reqq: 255,
            }));
            sendSimple(sock, null, 2); // interested
          }
          processBuffer();
        });
        sock.write(btHandshake);
      }
    });
  });
}

/* 对一个 infohash 的多个 peer 执行 PEX 收集，聚合所有新发现的 peer。
   并行批量（concurrency 默认 6），每个连接带独立收集窗口。
   onObservation 回调对每个新 peer 调用。 */
async function harvest(infohashHex, seedPeers, onObservation, opts = {}) {
  const seen = new Set();
  const discovered = [];
  const concurrency = opts.concurrency || 6;
  const pool = seedPeers.slice(0, opts.maxSeeds || 16);
  let encrypted = 0;

  let idx = 0;
  const worker = async () => {
    while (idx < pool.length) {
      const p = pool[idx++];
      try {
        const r = await pexFromPeer(p.ip, p.port, infohashHex, opts);
        if (r.encrypted) encrypted++;
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
  };
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.allSettled(workers);
  discovered.encrypted = encrypted; // 附加统计（非元素，不影响数组语义）
  return discovered;
}

module.exports = { pexFromPeer, harvest, parsePexPayload, UT_PEX_ID };
