'use strict';
/* 端口工具：自动查找未被占用的端口，用于启动各服务。
   避免端口冲突导致启动失败。 */
const net = require('net');

/* 检查单个端口是否可用（同时检查 IPv4 和 IPv6） */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    // 测试 IPv6（Node 默认 listen 不指定 host 时绑定 ::）
    const tester = net.createServer();
    let resolved = false;
    const check = (ok) => {
      if (resolved) return;
      resolved = true;
      try { tester.close(); } catch (_) {}
      resolve(ok);
    };
    tester.once('error', () => check(false));
    tester.once('listening', () => check(true));
    tester.listen(port);
  });
}

/* 从候选端口列表中找第一个可用的 */
async function pickFrom(candidates) {
  for (const port of candidates) {
    if (await isPortAvailable(port)) return port;
  }
  return null;
}

/* 在 [start, end] 范围内找第一个可用端口 */
async function findFreePort(start = 3000, end = 9999) {
  for (let p = start; p <= end; p++) {
    if (await isPortAvailable(p)) return p;
  }
  // 兜底：让 OS 分配
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/* 找多个不冲突的可用端口（用于同时启动多个服务） */
async function findFreePorts(count, start = 3000, end = 9999) {
  const ports = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    const p = await findFreePort(cursor, end);
    ports.push(p);
    cursor = p + 1;
  }
  return ports;
}

module.exports = { isPortAvailable, pickFrom, findFreePort, findFreePorts };
