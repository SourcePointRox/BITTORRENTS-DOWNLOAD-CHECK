'use strict';
/* 元数据抓取器（BEP-9 / BEP-10 / BEP-52）：
   TCP 连接 peer → MSE/PE 加密握手（BEP-8，失败回退明文）→ BitTorrent 握手（置 BEP-52 v2 支持位）→
   协商 ut_metadata 扩展 → 分片拉取 info 字典 → bencode 解析 name/files/file tree →
   SHA-1 校验 v1 infohash / SHA-256 校验 v2 infohash → pipeline.upsertTorrentMeta。
   支持 IPv4 和 IPv6 peer。 */
const net = require('net');
const crypto = require('crypto');
const bencode = require('../common/bencode');
const { decodeWithNext } = bencode;
const pipeline = require('./pipeline');
const { normalizeInfohash, isV2Infohash, sha256hex, computeBothHashes } = require('../common/util');
const { initiateMSE } = require('./mse');

const PSTR = Buffer.from('BitTorrent protocol');
const EXT_HANDSHAKE_ID = 0;
const UT_METADATA_ID = 3; // 本地扩展 ID（对方可能不同，以握手为准）
const BLOCK = 16 * 1024;
const TIMEOUT = 12000;

/* 分类器：TF-IDF + 多项逻辑回归（Softmax），置信度不足回退正则规则。
   详见 classifier.js。懒训练、单例缓存，首调 <50ms。 */
const classifier = require('./classifier');
function classify(name) {
  return classifier.classify(name);
}

function parseInfo(infoRaw) {
  const info = bencode.decode(infoRaw);
  const name = info['name.utf-8'] ? info['name.utf-8'].toString('utf8')
    : info.name ? info.name.toString('utf8') : null;
  let size = 0; const files = [];
  const isV2 = info['meta version'] === 2;
  const hasFileTree = !!(isV2 && info['file tree']);
  // hybrid 检测：BEP-52 hybrid 种子同时包含 v2 的 file tree 和 v1 的 files/pieces
  const hasV1Fields = !!(info.files || info.pieces || info.length);
  const isHybrid = hasFileTree && hasV1Fields;

  if (hasFileTree) {
    // BEP-52 v2/hybrid: 递归遍历 file tree 提取文件
    const walkTree = (tree, pathParts) => {
      for (const [key, val] of Object.entries(tree)) {
        if (key === '' && val.length !== undefined) {
          // 叶节点：文件属性 { length, pieces root, ... }
          files.push({ path: pathParts.join('/'), size: val.length || 0 });
          size += val.length || 0;
        } else if (typeof val === 'object' && val !== null) {
          // 子目录
          walkTree(val, [...pathParts, key]);
        }
      }
    };
    walkTree(info['file tree'], []);
    // v2 的 piece layers（可选，存储为原始数据）
    return { name, size, files, isV2: true, isHybrid, fileTree: info['file tree'], pieceLayers: info['piece layers'] };
  }

  // v1: files 列表或单文件
  if (Array.isArray(info.files)) {
    for (const f of info.files) {
      const parts = (f['path.utf-8'] || f.path || []).map(p => p.toString('utf8'));
      files.push({ path: parts.join('/'), size: f.length || 0 });
      size += f.length || 0;
    }
  } else if (info.length) {
    size = info.length;
    files.push({ path: name, size });
  }
  return { name, size, files, isV2: false, isHybrid: false };
}

/* 从单个 peer 拉取元数据（明文 BT 握手）。返回 Promise<Buffer|null>（info 原始字节） */
function _fetchPlaintext(ip, port, infohashHex) {
  return new Promise((resolve) => {
    const infohash = Buffer.from(infohashHex, 'hex');
    const peerId = crypto.randomBytes(20);
    const sock = new net.Socket();
    let buffer = Buffer.alloc(0);
    let hsDone = false, extDone = false;
    let utId = null, metaSize = 0, got = Buffer.alloc(0), reqIndex = 0;
    const done = (v) => { try { sock.destroy(); } catch (_) {} resolve(v); };
    const timer = setTimeout(() => done(null), TIMEOUT);

    function sendExt(id, payload) {
      const body = Buffer.concat([Buffer.from([20, id]), payload]);
      const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
      sock.write(Buffer.concat([len, body]));
    }
    function requestPiece(i) {
      const msg = bencode.encode({ msg_type: 0, piece: i });
      sendExt(utId, msg);
    }

    sock.connect(port, ip, () => {
      const reserved = Buffer.alloc(8);
      reserved[5] = 0x10; // 支持扩展协议 (BEP-10)
      reserved[7] = 0x10; // 支持 BitTorrent v2 / Hybrid (BEP-52)
      // infohash 字段：v2 用截断的 20 字节（SHA-256 前 20 字节）
      const ihForHandshake = isV2Infohash(infohashHex)
        ? Buffer.from(infohashHex.slice(0, 40), 'hex')
        : infohash;
      const hs = Buffer.concat([Buffer.from([19]), PSTR, reserved, ihForHandshake, peerId]);
      sock.write(hs);
    });
    sock.on('error', () => { clearTimeout(timer); done(null); });
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (!hsDone) {
          if (buffer.length < 68) return;
          const pstrlen = buffer[0];
          if (buffer.slice(1, 1 + pstrlen).toString() !== PSTR.toString()) { clearTimeout(timer); return done(null); }
          // BT 握手: [1 pstrlen][pstr 19][reserved 8][infohash 20][peer_id 20]
          // infohash 起始 = 1 + pstrlen + 8 = 28
          const ihStart = 1 + pstrlen + 8;
          const gotHash = buffer.slice(ihStart, ihStart + 20);
          // v2: 用截断的 20 字节比较；v1: 直接比较
          const expectedHash = isV2Infohash(infohashHex) ? ihForHandshake : infohash;
          if (!gotHash.equals(expectedHash)) { clearTimeout(timer); return done(null); }
          buffer = buffer.slice(1 + pstrlen + 48); hsDone = true; // 跳过整个握手 (1+pstr+8+20+20)
          // 发送扩展握手
          sendExt(EXT_HANDSHAKE_ID, bencode.encode({ m: { ut_metadata: UT_METADATA_ID }, metadata_size: 0, v: 'ikwyd-sandbox/0.1' }));
        }
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
            if (extId === EXT_HANDSHAKE_ID) {
              const h = bencode.decode(payload);
              if (h.m && h.m.ut_metadata) { utId = h.m.ut_metadata; metaSize = h.metadata_size || 0; }
              if (utId && metaSize > 0 && metaSize < 16 * 1024 * 1024) { got = Buffer.alloc(metaSize); requestPiece(0); }
              else { clearTimeout(timer); return done(null); }
            } else if (extId === utId && utId != null) {
              // BEP-9 ut_metadata 数据消息：bencode header 字典 + 原始 piece 数据
              // msg_type: 0=request 1=data 2=reject
              const r = decodeWithNext(payload, 0);
              const d = r.value;
              const data = payload.slice(r.next); // next 精确指向 header 之后的数据起点
              const piece = d.piece || 0;
              if (d.msg_type === 2) { // reject —— 对方拒绝提供
                clearTimeout(timer); return done(null);
              }
              if (d.msg_type === 1 && data.length > 0) { // data —— 写入对应分片
                data.copy(got, piece * BLOCK);
              }
              const pieces = Math.ceil(metaSize / BLOCK);
              reqIndex++;
              if (reqIndex < pieces) requestPiece(reqIndex);
              else { clearTimeout(timer); return done(got); }
            }
          } else if (id === 5) { /* bitfield，忽略 */ }
          else if (id === 7) { /* piece，忽略 */ }
        }
      } catch (_) { clearTimeout(timer); done(null); }
    });
  });
}

/* MSE/PE 加密握手版元数据抓取（BEP-8）：
   先尝试 MSE 加密握手，失败则回退明文。
   很多 BT 客户端默认或强制要求加密连接，不支持 MSE 将无法从这些 peer 获取元数据。 */
function fetchFromPeerMSE(ip, port, infohashHex) {
  return new Promise((resolve) => {
    const infohash = Buffer.from(infohashHex, 'hex');
    const peerId = crypto.randomBytes(20);
    const sock = new net.Socket();
    let buffer = Buffer.alloc(0);
    let hsDone = false;
    let utId = null, metaSize = 0, got = Buffer.alloc(0), reqIndex = 0;
    let enc = null, dec = null;
    const done = (v) => { try { sock.destroy(); } catch (_) {} resolve(v); };
    const timer = setTimeout(() => done(null), TIMEOUT);

    // 构建 BT 握手 payload（作为 MSE 的 IA）
    const reserved = Buffer.alloc(8);
    reserved[5] = 0x10;
    reserved[7] = 0x10;
    const ihForHandshake = isV2Infohash(infohashHex)
      ? Buffer.from(infohashHex.slice(0, 40), 'hex')
      : infohash;
    const btHandshake = Buffer.concat([Buffer.from([19]), PSTR, reserved, ihForHandshake, peerId]);

    function sendExt(id, payload) {
      const body = Buffer.concat([Buffer.from([20, id]), payload]);
      const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
      const data = Buffer.concat([len, body]);
      sock.write(enc ? enc.process(data) : data);
    }
    function requestPiece(i) {
      const msg = bencode.encode({ msg_type: 0, piece: i });
      sendExt(utId, msg);
    }

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
          if (id === 20) {
            const extId = msg[1];
            const payload = msg.slice(2);
            if (extId === EXT_HANDSHAKE_ID) {
              const h = bencode.decode(payload);
              if (h.m && h.m.ut_metadata) { utId = h.m.ut_metadata; metaSize = h.metadata_size || 0; }
              if (utId && metaSize > 0 && metaSize < 16 * 1024 * 1024) { got = Buffer.alloc(metaSize); requestPiece(0); }
              else { clearTimeout(timer); return done(null); }
            } else if (extId === utId && utId != null) {
              const r = decodeWithNext(payload, 0);
              const d = r.value;
              const data = payload.slice(r.next);
              const piece = d.piece || 0;
              if (d.msg_type === 2) { clearTimeout(timer); return done(null); }
              if (d.msg_type === 1 && data.length > 0) { data.copy(got, piece * BLOCK); }
              const pieces = Math.ceil(metaSize / BLOCK);
              reqIndex++;
              if (reqIndex < pieces) requestPiece(reqIndex);
              else { clearTimeout(timer); return done(got); }
            }
          }
        }
      } catch (_) { clearTimeout(timer); done(null); }
    }

    sock.connect(port, ip, async () => {
      // 尝试 MSE/PE 加密握手
      const mseResult = await initiateMSE(sock, infohashHex, btHandshake, 6000);
      if (!mseResult) {
        clearTimeout(timer);
        try { sock.destroy(); } catch (_) {}
        diag.mse_fail++;
        return resolve(null);
      }

      // MSE 成功
      diag.mse_ok++;
      enc = mseResult.encrypt;
      dec = mseResult.decrypt;

      // 解析 IB（peer 的 BT 握手）
      const ib = mseResult.ia;
      if (ib.length < 68) { clearTimeout(timer); return done(null); }
      const pstrlen = ib[0];
      if (ib.slice(1, 1 + pstrlen).toString() !== PSTR.toString()) { clearTimeout(timer); return done(null); }
      const ihStart = 1 + pstrlen + 8;
      const gotHash = ib.slice(ihStart, ihStart + 20);
      const expectedHash = isV2Infohash(infohashHex) ? ihForHandshake : infohash;
      if (!gotHash.equals(expectedHash)) { clearTimeout(timer); return done(null); }
      hsDone = true;

      // 处理 MSE 阶段剩余的数据（需解密）
      if (mseResult.remaining && mseResult.remaining.length > 0) {
        const decrypted = dec ? dec.process(mseResult.remaining) : mseResult.remaining;
        buffer = Buffer.concat([buffer, decrypted]);
      }

      // 添加数据处理器（解密后处理）
      sock.on('data', (chunk) => {
        const decrypted = dec ? dec.process(chunk) : chunk;
        buffer = Buffer.concat([buffer, decrypted]);
        processBuffer();
      });
      sock.on('error', () => { clearTimeout(timer); done(null); });

      // 发送扩展握手（已加密）
      sendExt(EXT_HANDSHAKE_ID, bencode.encode({
        m: { ut_metadata: UT_METADATA_ID }, metadata_size: 0, v: 'ikwyd-sandbox/0.1'
      }));

      // 处理已缓冲的数据
      processBuffer();
    });

    // 连接阶段的错误处理
    sock.on('error', () => { clearTimeout(timer); done(null); });
  });
}

/* 诊断计数器：统计失败原因分布，定期输出帮助定位问题 */
const diag = { conn: 0, hs: 0, sha: 0, noname: 0, ok: 0, total: 0, debug: 0, mse_ok: 0, mse_fail: 0, plain_ok: 0 };
setInterval(() => {
  if (diag.total === 0) return;
  console.log(`[meta-diag] 尝试 ${diag.total} | MSE成功 ${diag.mse_ok} 明文成功 ${diag.plain_ok} | 连接/握手失败 ${diag.conn} | SHA不匹配 ${diag.sha} | 无name ${diag.noname} | 成功 ${diag.ok}`);
  diag.conn = diag.hs = diag.sha = diag.noname = diag.ok = diag.total = diag.mse_ok = diag.mse_fail = diag.plain_ok = 0;
}, 30000).unref();

/* 元数据解析并入库：并行尝试多个 peer（DHT peer 质量参差，并行提高成功率）。
   v1: SHA-1 校验；v2: SHA-256 校验；hybrid: 同时计算两个哈希，以 v1 作为主键。 */
async function resolveAndStore(infohashHex, peersList) {
  const infohash = normalizeInfohash(infohashHex);
  if (!infohash) return null;
  const isV2 = isV2Infohash(infohash);
  // 并行尝试最多 20 个 peer，取第一个 hash 匹配的结果
  const candidates = peersList.slice(0, 20);
  diag.total += candidates.length;
  const tasks = candidates.map(p =>
    fetchFromPeerAuto(p.ip, p.port, infohash).then(raw => ({ raw, peer: p }))
  );
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value || !r.value.raw) { diag.conn++; continue; }
    const raw = r.value.raw;
    if (raw.length < 1) { diag.conn++; continue; }
    // 同时计算 v1(SHA-1) 和 v2(SHA-256) 哈希，用于 hybrid 检测
    const hashes = computeBothHashes(raw);
    const expectedHash = isV2 ? hashes.v2 : hashes.v1;
    if (expectedHash !== infohash) {
      diag.sha++;
      if (diag.debug < 5) { diag.debug++; console.log('[meta-debug] SHA mismatch', infohash.slice(0,12), 'got', expectedHash.slice(0,12), 'len', raw.length); }
      continue;
    }
    const meta = parseInfo(raw);
    if (!meta.name) { diag.noname++; continue; }

    // hybrid 种子：同时有 v1 和 v2 infohash，以 v1 作为主键，v2 存入 infohash_v2
    if (meta.isHybrid) {
      const v1Hash = hashes.v1;
      const v2Hash = hashes.v2;
      pipeline.upsertTorrentMeta({
        infohash: v1Hash,           // v1 作为主键（canonical）
        hash_version: 3,             // hybrid
        infohash_v2: v2Hash,         // v2 存入 infohash_v2
        name: meta.name, size: meta.size, files: meta.files,
        category: classify(meta.name), metadata_ok: 1,
        first_seen: Date.now(), last_seen: Date.now(),
        piece_layers: meta.pieceLayers,
        file_tree: meta.fileTree,
      });
      // 合并可能存在的 v2-keyed 行（之前以 v2 infohash 登记的占位行）
      pipeline.linkHybridInfohash(v1Hash, v2Hash);
      diag.ok++;
      return { ...meta, infohash: v1Hash, infohash_v2: v2Hash, hash_version: 3 };
    }

    // 纯 v1 或纯 v2
    pipeline.upsertTorrentMeta({
      infohash,
      hash_version: isV2 ? 2 : 1,
      name: meta.name, size: meta.size, files: meta.files,
      category: classify(meta.name), metadata_ok: 1,
      first_seen: Date.now(), last_seen: Date.now(),
      piece_layers: meta.pieceLayers,
      file_tree: meta.fileTree,
    });
    diag.ok++;
    return meta;
  }
  return null;
}

/* 从单个 peer 拉取元数据（明文 BT 握手）。
   保留原函数名用于直接明文连接和回退。 */
function fetchFromPeer(ip, port, infohashHex) {
  return _fetchPlaintext(ip, port, infohashHex);
}

/* 优先尝试 MSE/PE 加密握手，失败则回退明文。
   这是 resolveAndStore 的默认调用路径。 */
async function fetchFromPeerAuto(ip, port, infohashHex) {
  // 先尝试 MSE
  const mseResult = await fetchFromPeerMSE(ip, port, infohashHex);
  if (mseResult && mseResult.length > 0) {
    diag.plain_ok++; // 统计为 MSE 路径成功
    return mseResult;
  }
  // MSE 失败，回退明文
  return _fetchPlaintext(ip, port, infohashHex);
}

module.exports = { fetchFromPeer, fetchFromPeerMSE, fetchFromPeerAuto, resolveAndStore, classify, parseInfo };
