'use strict';
/* MSE/PE (Message Stream Encryption / Protocol Encryption) — BEP-8
   实现 BitTorrent 协议加密握手，使元数据抓取能连接要求加密的 peer。

   工作流程（initiator 角色）：
   1. 生成 768-bit DH 密钥对，发送 Y_A（96 字节）
   2. 接收 Y_B（96 字节），计算共享密钥 S
   3. 发送 crypto negotiation：HASH('req1',S) + HASH('req2',SKEY) XOR HASH('req3',S) + crypto_provide + IA(BT握手)
   4. 接收 crypto_select + IB(BT握手)
   5. 后续数据用 RC4 加密（如 crypto_select & 0x02）

   RC4 在 Node.js v24 中已被移除，此处用纯 JS 实现（RC4 算法极简，~30 行）。
   DH 使用 crypto.createDiffieHellman(prime, 'hex')。

   如果 peer 不支持 MSE，回退到明文 BT 握手。 */
const crypto = require('crypto');

/* 768-bit DH prime（BEP-8 规定的固定大素数） */
const DH_PRIME_HEX = [
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1',
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD',
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245',
  'E485B576625E7EC6F44C42E9A63A36210000000000090563',
].join('');

const DH_KEY_SIZE = 96; // 768 bits = 96 bytes
const CRYPTO_PLAINTEXT = 0x01;
const CRYPTO_RC4 = 0x02;

/* ---------- RC4 流密码（纯 JS 实现） ---------- */
class RC4 {
  constructor(key) {
    const k = Buffer.isBuffer(key) ? key : Buffer.from(key);
    this.S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) this.S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + this.S[i] + k[i % k.length]) & 0xFF;
      const t = this.S[i]; this.S[i] = this.S[j]; this.S[j] = t;
    }
    this.i = 0; this.j = 0;
    // RC4-drop：丢弃前 1024 字节输出（安全增强）
    for (let n = 0; n < 1024; n++) this._byte();
  }
  _byte() {
    this.i = (this.i + 1) & 0xFF;
    this.j = (this.j + this.S[this.i]) & 0xFF;
    const t = this.S[this.i]; this.S[this.i] = this.S[this.j]; this.S[this.j] = t;
    return this.S[(this.S[this.i] + this.S[this.j]) & 0xFF];
  }
  process(buf) {
    const out = Buffer.alloc(buf.length);
    for (let n = 0; n < buf.length; n++) out[n] = buf[n] ^ this._byte();
    return out;
  }
}

/* DH 密钥对生成 */
function createDH() {
  return crypto.createDiffieHellman(Buffer.from(DH_PRIME_HEX, 'hex'));
}

/* 计算 HASH(label, data) — SHA-1 */
function HASH(label, data) {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(label), data])).digest();
}

/* 发起 MSE 握手（initiator 角色）。
   返回 Promise<{encrypt: RC4|null, decrypt: RC4|null, ia: Buffer}>
   如果 peer 不支持 MSE（超时或返回非 MSE 数据），返回 null。 */
function initiateMSE(socket, infohash, btHandshakePayload, timeout = 6000) {
  return new Promise((resolve) => {
    let phase = 0; // 0=等Y_B, 1=等crypto_select+IB
    let buf = Buffer.alloc(0);
    let dh = null, Y_A = null, S = null;
    let enc = null, dec = null;
    let iaSent = false;

    const timer = setTimeout(() => resolve(null), timeout);
    const cleanup = () => { clearTimeout(timer); socket.removeAllListeners('data'); socket.removeAllListeners('error'); };

    // 生成 DH 密钥对
    try {
      dh = createDH();
      const keys = dh.generateKeys();
      Y_A = keys;
    } catch (e) {
      clearTimeout(timer);
      return resolve(null);
    }

    // Phase 1: 发送 Y_A（简化版：无 PadA/PadB padding）
    socket.write(Y_A);

    socket.on('error', () => { clearTimeout(timer); resolve(null); });

    socket.on('data', (chunk) => {
      if (phase === 0) {
        // 等待 Y_B（96 字节）
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < DH_KEY_SIZE) return;

        const Y_B = buf.slice(0, DH_KEY_SIZE);
        buf = buf.slice(DH_KEY_SIZE);

        try {
          S = dh.computeSecret(Y_B);
        } catch (e) {
          cleanup(); return resolve(null);
        }

        // Phase 2: 发送 crypto negotiation（用 RC4 加密，如果 crypto_provide 包含 RC4）
        const req1 = HASH('req1', S);
        const req2 = HASH('req2', Buffer.from(infohash, 'hex'));
        const req3 = HASH('req3', S);
        const xorHash = Buffer.alloc(20);
        for (let i = 0; i < 20; i++) xorHash[i] = req2[i] ^ req3[i];

        const cryptoProvide = Buffer.alloc(4);
        cryptoProvide.writeUInt32LE(CRYPTO_RC4 | CRYPTO_PLAINTEXT, 0);

        // IA = BT 握手 payload
        const ia = btHandshakePayload;
        const iaLen = Buffer.alloc(2);
        iaLen.writeUInt16BE(ia.length, 0);

        // PadC (empty)
        const padCLen = Buffer.alloc(2);
        padCLen.writeUInt16BE(0, 0);
        // PadD (empty)
        const padDLen = Buffer.alloc(2);
        padDLen.writeUInt16BE(0, 0);

        const phase2 = Buffer.concat([
          req1,         // 20 bytes
          xorHash,      // 20 bytes
          cryptoProvide, // 4 bytes
          padCLen,      // 2 bytes (0)
          padDLen,      // 2 bytes (0)
          iaLen,        // 2 bytes
          ia,           // BT handshake
        ]);

        socket.write(phase2);

        // 准备 RC4 密钥（以防 crypto_select 选择 RC4）
        const keyA = HASH('keyA', Buffer.concat([S, Buffer.from(infohash, 'hex')]));
        const keyB = HASH('keyB', Buffer.concat([S, Buffer.from(infohash, 'hex')]));
        // initiator 用 keyA 加密发送, keyB 解密接收
        enc = new RC4(keyA);
        dec = new RC4(keyB);

        phase = 1;
      } else if (phase === 1) {
        // 等待 crypto_select + IB
        // 可能加密也可能明文，先尝试明文读取
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;

        const cryptoSelect = buf.readUInt32LE(0);
        buf = buf.slice(4);

        // 读取 PadG
        if (buf.length < 2) return;
        const padGLen = buf.readUInt16BE(0);
        buf = buf.slice(2);
        if (buf.length < padGLen) return;
        buf = buf.slice(padGLen);

        // 读取 IB
        if (buf.length < 2) return;
        const ibLen = buf.readUInt16BE(0);
        buf = buf.slice(2);
        if (buf.length < ibLen) return;
        let ib = buf.slice(0, ibLen);
        buf = buf.slice(ibLen);

        // 如果选择了 RC4，后续数据需要解密
        if (cryptoSelect & CRYPTO_RC4) {
          ib = dec.process(ib);
          // 后续所有数据都用 RC4 解密
          cleanup();
          resolve({ encrypt: enc, decrypt: dec, ia: ib, remaining: buf });
        } else if (cryptoSelect & CRYPTO_PLAINTEXT) {
          // 明文模式（仅握手混淆，数据不加密）
          cleanup();
          resolve({ encrypt: null, decrypt: null, ia: ib, remaining: buf });
        } else {
          // 不支持的加密方式
          cleanup();
          resolve(null);
        }
      }
    });
  });
}

module.exports = { RC4, createDH, HASH, initiateMSE, CRYPTO_RC4, CRYPTO_PLAINTEXT, DH_PRIME_HEX };
