'use strict';
/* SOCKS5 代理客户端：纯 Node.js 标准库实现，零第三方依赖。
   - RFC 1928: SOCKS5 CONNECT（TCP），支持 IPv4/IPv6/域名
   - RFC 1929: 用户名/密码认证
   - UDP ASSOCIATE: 包装 dgram socket 通过 SOCKS5 发送 UDP（用于 DHT 走代理）
   - createSocksConnection(proxyHost, proxyPort, targetHost, targetPort, auth) 返回 net.Socket
   - wrapDgramSocket(socksConfig) 返回类 dgram.Socket 的对象 */
const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { URL } = require('url');

const HANDSHAKE_TIMEOUT = 10000;

/* 解析 SOCKS5 配置字符串：
   - host:port
   - user:pass@host:port
   - socks5://[user:pass@]host:port
   返回 { host, port, username, password } 或 null。 */
function parseSocksConfig(str) {
  if (!str) return null;
  // 支持 socks5://[user:pass@]host:port 格式
  if (str.startsWith('socks5://') || str.startsWith('socks://')) {
    try {
      const u = new URL(str);
      return {
        host: u.hostname,
        port: Number(u.port) || 1080,
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
      };
    } catch (_) {}
  }
  // user:pass@host:port 或 host:port
  const atIdx = str.lastIndexOf('@');
  if (atIdx >= 0) {
    const cred = str.slice(0, atIdx);
    const hostport = str.slice(atIdx + 1);
    const parts = hostport.split(':');
    const credParts = cred.split(':');
    return { host: parts[0], port: Number(parts[1]) || 1080, username: credParts[0] || '', password: credParts[1] || '' };
  }
  const parts = str.split(':');
  return { host: parts[0], port: Number(parts[1]) || 1080, username: '', password: '' };
}

/* ---------- 地址编码辅助 ---------- */

const isIPv4 = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s);
const isIPv6 = (s) => typeof s === 'string' && s.includes(':');

/* IPv6 字符串 → 16 字节 Buffer（处理 :: 简写） */
function ipv6ToBuffer(str) {
  let addr = str;
  if (addr.includes('::')) {
    const parts = addr.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    addr = [...left, ...Array(missing).fill('0'), ...right].join(':');
  }
  const groups = addr.split(':');
  if (groups.length !== 8) return null;
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || '0', 16);
    if (isNaN(v)) return null;
    buf.writeUInt16BE(v, i * 2);
  }
  return buf;
}

/* 构造 SOCKS5 地址字段（ATYP + ADDR + PORT），返回 Buffer 或 null */
function encodeAddress(host, port) {
  if (isIPv4(host)) {
    const buf = Buffer.alloc(1 + 4 + 2);
    buf[0] = 0x01; // IPv4
    host.split('.').map(Number).forEach((b, i) => buf[1 + i] = b);
    buf.writeUInt16BE(port, 5);
    return buf;
  }
  if (isIPv6(host)) {
    const ipBuf = ipv6ToBuffer(host);
    if (ipBuf) {
      const buf = Buffer.alloc(1 + 16 + 2);
      buf[0] = 0x04; // IPv6
      ipBuf.copy(buf, 1);
      buf.writeUInt16BE(port, 17);
      return buf;
    }
  }
  // 域名
  const hostBuf = Buffer.from(host);
  if (hostBuf.length > 255) return null;
  const buf = Buffer.alloc(1 + 1 + hostBuf.length + 2);
  buf[0] = 0x03; // domain
  buf[1] = hostBuf.length;
  hostBuf.copy(buf, 2);
  buf.writeUInt16BE(port, 2 + hostBuf.length);
  return buf;
}

/* 解析 SOCKS5 响应中的地址字段，返回 { atyp, host, port, len } 或 null。
   len 为整个地址段（含 atyp）的字节数。 */
function decodeAddress(buf, offset) {
  if (buf.length < offset + 1) return null;
  const atyp = buf[offset];
  let host, port, len;
  if (atyp === 0x01) { // IPv4
    if (buf.length < offset + 1 + 4 + 2) return null;
    host = `${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}.${buf[offset + 4]}`;
    port = buf.readUInt16BE(offset + 5);
    len = 7;
  } else if (atyp === 0x04) { // IPv6
    if (buf.length < offset + 1 + 16 + 2) return null;
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(offset + 1 + i).toString(16));
    host = parts.join(':');
    port = buf.readUInt16BE(offset + 17);
    len = 19;
  } else if (atyp === 0x03) { // domain
    if (buf.length < offset + 2) return null;
    const dlen = buf[offset + 1];
    if (buf.length < offset + 1 + 1 + dlen + 2) return null;
    host = buf.slice(offset + 2, offset + 2 + dlen).toString();
    port = buf.readUInt16BE(offset + 2 + dlen);
    len = 1 + 1 + dlen + 2;
  } else return null;
  return { atyp, host, port, len };
}

/* ---------- SOCKS5 握手（方法协商 + 可选认证） ---------- */

/* 协商认证方法，必要时做用户名/密码认证（RFC 1929）。
   握手完成后移除监听器，交由调用方继续发 CONNECT/UDP ASSOCIATE。 */
function socks5Handshake(socket, auth) {
  return new Promise((resolve, reject) => {
    const methods = auth && auth.username ? [0x00, 0x02] : [0x00];
    const greeting = Buffer.alloc(2 + methods.length);
    greeting[0] = 0x05; // SOCKS 版本
    greeting[1] = methods.length;
    methods.forEach((m, i) => greeting[2 + i] = m);

    let phase = 'greeting';
    let buf = Buffer.alloc(0);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (phase === 'greeting') {
        if (buf.length < 2) return;
        const ver = buf[0];
        const method = buf[1];
        buf = buf.slice(2);
        if (ver !== 0x05) { cleanup(); reject(new Error('SOCKS 版本不匹配')); return; }
        if (method === 0xFF) { cleanup(); reject(new Error('SOCKS 无可用认证方法')); return; }
        if (method === 0x02 && auth && auth.username) {
          // 用户名/密码认证 (RFC 1929)
          phase = 'auth';
          const u = Buffer.from(auth.username);
          const p = Buffer.from(auth.password || '');
          const authReq = Buffer.alloc(3 + u.length + p.length);
          authReq[0] = 0x01; // 子协商版本
          authReq[1] = u.length;
          u.copy(authReq, 2);
          authReq[2 + u.length] = p.length;
          p.copy(authReq, 3 + u.length);
          socket.write(authReq);
          return;
        }
        if (method === 0x00) { cleanup(); resolve(); return; }
        cleanup(); reject(new Error('SOCKS 不支持的认证方法 ' + method));
        return;
      }
      if (phase === 'auth') {
        if (buf.length < 2) return;
        const ver = buf[0];
        const status = buf[1];
        buf = buf.slice(2);
        if (ver !== 0x01) { cleanup(); reject(new Error('SOCKS 认证版本不匹配')); return; }
        if (status !== 0x00) { cleanup(); reject(new Error('SOCKS 认证失败')); return; }
        cleanup(); resolve();
        return;
      }
    };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      clearTimeout(timer);
    }
    function onError(err) { cleanup(); reject(err); }
    const timer = setTimeout(() => { cleanup(); reject(new Error('SOCKS 握手超时')); }, HANDSHAKE_TIMEOUT);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(greeting);
  });
}

/* ---------- SOCKS5 CONNECT (TCP) ---------- */

/* 发送 CONNECT 请求并等待应答，应答后的多余字节通过 unshift 归还应用层 */
function socks5Connect(socket, host, port) {
  return new Promise((resolve, reject) => {
    const addr = encodeAddress(host, port);
    if (!addr) { reject(new Error('SOCKS 地址编码失败')); return; }
    const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr]); // VER, CMD=CONNECT, RSV
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const ver = buf[0];
      const rep = buf[1];
      if (ver !== 0x05) { cleanup(); reject(new Error('SOCKS 版本不匹配')); return; }
      if (rep !== 0x00) { cleanup(); reject(new Error('SOCKS CONNECT 失败: ' + rep)); return; }
      const addrInfo = decodeAddress(buf, 3);
      if (!addrInfo) return; // 数据不足，等待更多
      cleanup();
      // 应答之后的字节属于应用层，归还给 socket
      const leftover = buf.slice(3 + addrInfo.len);
      if (leftover.length > 0) socket.unshift(leftover);
      resolve();
    };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      clearTimeout(timer);
    }
    function onError(err) { cleanup(); reject(err); }
    const timer = setTimeout(() => { cleanup(); reject(new Error('SOCKS CONNECT 超时')); }, HANDSHAKE_TIMEOUT);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(req);
  });
}

/* 建立 SOCKS5 TCP 连接。返回已连接到目标主机的 net.Socket。
   auth: { username, password } 可选。 */
async function createSocksConnection(proxyHost, proxyPort, targetHost, targetPort, auth) {
  const socket = net.createConnection({ host: proxyHost, port: proxyPort });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.setTimeout(HANDSHAKE_TIMEOUT, () => reject(new Error('代理连接超时')));
  });
  socket.setTimeout(0);
  await socks5Handshake(socket, auth);
  await socks5Connect(socket, targetHost, targetPort);
  return socket;
}

/* ---------- SOCKS5 UDP ASSOCIATE ---------- */

/* 发起 UDP ASSOCIATE，返回 { relayHost, relayPort, tcpSocket }。
   tcpSocket 需保持打开（关闭即终止 UDP 中继）。 */
async function socks5UdpAssociate(proxyHost, proxyPort, auth) {
  const socket = net.createConnection({ host: proxyHost, port: proxyPort });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.setTimeout(HANDSHAKE_TIMEOUT, () => reject(new Error('代理连接超时')));
  });
  socket.setTimeout(0);
  await socks5Handshake(socket, auth);
  const result = await new Promise((resolve, reject) => {
    // UDP ASSOCIATE: CMD=3, DST=0.0.0.0:0
    const req = Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const rep = buf[1];
      if (rep !== 0x00) { cleanup(); reject(new Error('SOCKS UDP ASSOCIATE 失败: ' + rep)); return; }
      const addrInfo = decodeAddress(buf, 3);
      if (!addrInfo) return; // 数据不足
      cleanup();
      resolve({ bndHost: addrInfo.host, bndPort: addrInfo.port });
    };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      clearTimeout(timer);
    }
    function onError(err) { cleanup(); reject(err); }
    const timer = setTimeout(() => { cleanup(); reject(new Error('UDP ASSOCIATE 超时')); }, HANDSHAKE_TIMEOUT);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(req);
  });
  // 服务器返回 0.0.0.0 时，relay 地址即代理服务器 IP
  let relayHost = result.bndHost;
  if (relayHost === '0.0.0.0' || relayHost === '::') relayHost = proxyHost;
  return { relayHost, relayPort: result.bndPort, tcpSocket: socket };
}

/* 包装 UDP 数据包：RSV(2) + FRAG(1) + ATYP+ADDR+PORT + DATA */
function wrapUdpPacket(data, host, port) {
  const addr = encodeAddress(host, port);
  if (!addr) return null;
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), addr, data]);
}

/* 解包 UDP 响应：返回 { data, host, port } 或 null */
function unwrapUdpPacket(buf) {
  if (buf.length < 4) return null;
  const addrInfo = decodeAddress(buf, 3);
  if (!addrInfo) return null;
  return { data: buf.slice(3 + addrInfo.len), host: addrInfo.host, port: addrInfo.port };
}

/* 包装 dgram socket：通过 SOCKS5 UDP ASSOCIATE 收发 UDP（用于 DHT 走代理）。
   返回类 dgram.Socket 的 EventEmitter（on/bind/send/close/address）。
   首次 bind/send 时建立 UDP ASSOCIATE，失败触发 'error' 事件。
   注意：经代理后无法接收主动入站 UDP，仅适合主动查询型 DHT。 */
function wrapDgramSocket(socksConfig) {
  const ee = new EventEmitter();
  const cfg = typeof socksConfig === 'string' ? parseSocksConfig(socksConfig) : socksConfig;
  let relay = null;          // { relayHost, relayPort, tcpSocket, udpSocket }
  let associating = null;    // 进行中的 ASSOCIATE Promise
  let closed = false;
  let bindPort = 0;

  /* 确保 UDP ASSOCIATE 已建立（懒初始化） */
  function ensureAssociate() {
    if (relay) return Promise.resolve();
    if (associating) return associating;
    associating = socks5UdpAssociate(cfg.host, cfg.port, { username: cfg.username, password: cfg.password })
      .then(r => {
        relay = r;
        // 本地 UDP socket 与 relay 通信（任意端口）
        const udp = dgram.createSocket('udp4');
        udp.on('message', (msg) => {
          const unwrapped = unwrapUdpPacket(msg);
          if (unwrapped) {
            ee.emit('message', unwrapped.data, {
              address: unwrapped.host,
              port: unwrapped.port,
              family: 'IPv4',
            });
          }
        });
        udp.on('error', (e) => ee.emit('error', e));
        udp.bind(0);
        relay.udpSocket = udp;
        associating = null;
      })
      .catch(e => {
        associating = null;
        throw e;
      });
    return associating;
  }

  ee.bind = (port) => {
    bindPort = port || 0;
    ensureAssociate()
      .then(() => ee.emit('listening'))
      .catch(e => ee.emit('error', e));
    return ee;
  };

  ee.send = (msg, port, host, cb) => {
    if (closed) { if (cb) cb(new Error('socket closed')); return ee; }
    const doSend = () => {
      const wrapped = wrapUdpPacket(msg, host, port);
      if (!wrapped) { if (cb) cb(new Error('SOCKS 地址编码失败')); return; }
      try {
        relay.udpSocket.send(wrapped, relay.relayPort, relay.relayHost, cb || (() => {}));
      } catch (e) { if (cb) cb(e); }
    };
    if (relay) { doSend(); return ee; }
    ensureAssociate().then(doSend).catch(e => { if (cb) cb(e); });
    return ee;
  };

  ee.close = () => {
    if (closed) return ee;
    closed = true;
    if (relay) {
      try { relay.udpSocket.close(); } catch (_) {}
      try { relay.tcpSocket.destroy(); } catch (_) {}
    }
    ee.emit('close');
    return ee;
  };

  ee.address = () => ({ port: bindPort, family: 'IPv4', address: '0.0.0.0' });
  ee.setTTL = () => ee;
  ee.setBroadcast = () => ee;

  return ee;
}

module.exports = {
  parseSocksConfig,
  createSocksConnection,
  wrapDgramSocket,
  socks5Handshake,
  socks5Connect,
  socks5UdpAssociate,
  wrapUdpPacket,
  unwrapUdpPacket,
  encodeAddress,
  decodeAddress,
};
