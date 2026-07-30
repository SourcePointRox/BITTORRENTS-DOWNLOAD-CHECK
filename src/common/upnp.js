'use strict';
/* UPnP IGD + NAT-PMP 端口映射：纯 Node.js 标准库实现，零第三方依赖。
   - UPnP IGD: SSDP 发现网关 → 获取描述文档 → AddPortMapping/DeletePortMapping（SOAP over HTTP）
   - NAT-PMP (RFC 6886): 向网关 UDP 5351 端口发送映射请求
   - 自动检测网关地址（SSDP 发现 / 路由表）
   - mapPort(internalPort, externalPort, protocol='udp')：自动尝试 UPnP → NAT-PMP
   - unmapPort(externalPort, protocol)：清理映射
   超时：SSDP 发现 3s，映射请求 5s。失败静默降级，不影响主流程。 */
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const { exec } = require('child_process');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const NATPMP_PORT = 5351;
const SSDP_TIMEOUT = 3000;    // SSDP 发现超时
const MAPPING_TIMEOUT = 5000; // 映射请求超时
const LEASE_DURATION = 3600;  // 租约时长（秒）

/* 映射状态记录：用于 unmapPort 清理 */
const mappings = new Map(); // key: `${externalPort}:${protocol}` -> 映射信息

/* ---------- 网关检测 ---------- */

/* SSDP 发现 IGD 网关：发送 M-SEARCH 多播，监听响应。
   返回 { location, gatewayIp } 或 null。 */
function discoverViaSSDP() {
  return new Promise((resolve) => {
    let sock;
    try { sock = dgram.createSocket('udp4'); } catch (_) { return resolve(null); }
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(val);
    };
    sock.on('error', () => finish(null));
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const m = text.match(/LOCATION:\s*(\S+)/i);
      if (m && m[1]) {
        finish({ location: m[1], gatewayIp: rinfo.address });
      }
    });
    const timer = setTimeout(() => finish(null), SSDP_TIMEOUT);
    const req = [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
      'MX: 2',
      '', '',
    ].join('\r\n');
    try {
      sock.send(Buffer.from(req), SSDP_PORT, SSDP_ADDR, () => {});
    } catch (_) { finish(null); }
  });
}

/* 通过路由表检测默认网关 IP（跨平台：Windows / macOS / Linux） */
function detectGatewayFromRoute() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? 'route print 0.0.0.0'
      : process.platform === 'darwin'
        ? 'netstat -rn -f inet'
        : 'ip route show default';
    exec(cmd, { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      let gw = null;
      if (process.platform === 'win32') {
        // 0.0.0.0  0.0.0.0  192.168.1.1  ...
        const m = stdout.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
        if (m) gw = m[1];
      } else if (process.platform === 'darwin') {
        const m = stdout.match(/default\s+(\d+\.\d+\.\d+\.\d+)/);
        if (m) gw = m[1];
      } else {
        // Linux: default via 192.168.1.1 ...
        const m = stdout.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
        if (m) gw = m[1];
        if (!gw) {
          const m2 = stdout.match(/default\s+(?:dev\s+\S+\s+)?(\d+\.\d+\.\d+\.\d+)/);
          if (m2) gw = m2[1];
        }
      }
      resolve(gw);
    });
  });
}

/* 综合网关检测：优先 SSDP（同时得到 IGD location），失败再查路由表。
   返回 { location, gatewayIp } 或 { location: null, gatewayIp } 或 null。 */
async function detectGateway() {
  const ssdp = await discoverViaSSDP();
  if (ssdp) return ssdp;
  const gw = await detectGatewayFromRoute();
  if (gw) return { location: null, gatewayIp: gw };
  return null;
}

/* 获取本机内网 IPv4（用于 UPnP InternalClient 字段） */
function getLocalIP() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

/* ---------- HTTP 辅助 ---------- */

function httpGet(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('GET timeout')); });
  });
}

function httpPost(url, soapAction, body, timeout) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('bad url')); }
    const opts = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"${soapAction}"`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('POST timeout')); });
    req.write(body);
    req.end();
  });
}

/* ---------- UPnP IGD 描述解析 ---------- */

/* 从描述文档 XML 中提取 WANIPConnection/WANPPPConnection 的 controlURL。
   不依赖 XML 解析器，用正则提取（兼容标准 IGD 响应）。 */
function parseDescription(xml, baseUrl) {
  const services = [];
  const svcRe = /<service>[\s\S]*?<\/service>/gi;
  let m;
  while ((m = svcRe.exec(xml)) !== null) {
    const block = m[0];
    const st = block.match(/<serviceType>([^<]+)<\/serviceType>/i);
    const cu = block.match(/<controlURL>([^<]+)<\/controlURL>/i);
    if (st && cu) services.push({ serviceType: st[1].trim(), controlURL: cu[1].trim() });
  }
  const target = services.find(s => /WANIPConnection|WANPPPConnection/i.test(s.serviceType));
  if (!target) return null;
  let controlUrl;
  try { controlUrl = new URL(target.controlURL, baseUrl).href; } catch (_) { return null; }
  return { controlUrl, serviceType: target.serviceType };
}

/* ---------- UPnP AddPortMapping / DeletePortMapping（SOAP） ---------- */

async function upnpAddPortMapping(controlUrl, serviceType, internalIP, internalPort, externalPort, protocol, description) {
  const action = 'AddPortMapping';
  const soapAction = `${serviceType}#${action}`;
  const body =
    '<?xml version="1.0"?>\r\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\r\n' +
    '<s:Body>\r\n' +
    `<u:${action} xmlns:u="${serviceType}">\r\n` +
    '<NewRemoteHost></NewRemoteHost>\r\n' +
    `<NewExternalPort>${externalPort}</NewExternalPort>\r\n` +
    `<NewProtocol>${protocol.toUpperCase()}</NewProtocol>\r\n` +
    `<NewInternalPort>${internalPort}</NewInternalPort>\r\n` +
    `<NewInternalClient>${internalIP}</NewInternalClient>\r\n` +
    '<NewEnabled>1</NewEnabled>\r\n' +
    `<NewPortMappingDescription>${description}</NewPortMappingDescription>\r\n` +
    `<NewLeaseDuration>${LEASE_DURATION}</NewLeaseDuration>\r\n` +
    `</u:${action}>\r\n` +
    '</s:Body>\r\n' +
    '</s:Envelope>\r\n';
  const res = await httpPost(controlUrl, soapAction, body, MAPPING_TIMEOUT);
  return res.status === 200;
}

async function upnpDeletePortMapping(controlUrl, serviceType, externalPort, protocol) {
  const action = 'DeletePortMapping';
  const soapAction = `${serviceType}#${action}`;
  const body =
    '<?xml version="1.0"?>\r\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\r\n' +
    '<s:Body>\r\n' +
    `<u:${action} xmlns:u="${serviceType}">\r\n` +
    '<NewRemoteHost></NewRemoteHost>\r\n' +
    `<NewExternalPort>${externalPort}</NewExternalPort>\r\n` +
    `<NewProtocol>${protocol.toUpperCase()}</NewProtocol>\r\n` +
    `</u:${action}>\r\n` +
    '</s:Body>\r\n' +
    '</s:Envelope>\r\n';
  try {
    const res = await httpPost(controlUrl, soapAction, body, MAPPING_TIMEOUT);
    return res.status === 200;
  } catch (_) { return false; }
}

/* ---------- NAT-PMP (RFC 6886) ---------- */

/* NAT-PMP 映射请求。opcode: 1=UDP, 2=TCP。
   成功返回 { internalPort, externalPort, lifetime }，失败返回 null。 */
function natpmpMap(gatewayIp, internalPort, externalPort, protocol, lifetime) {
  const opcode = protocol === 'tcp' ? 2 : 1;
  return new Promise((resolve) => {
    let sock;
    try { sock = dgram.createSocket('udp4'); } catch (_) { return resolve(null); }
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(val);
    };
    const req = Buffer.alloc(12);
    req[0] = 0; // version
    req[1] = opcode; // 1=UDP, 2=TCP
    req.writeUInt16BE(0, 2); // reserved
    req.writeUInt16BE(internalPort, 4);
    req.writeUInt16BE(externalPort, 6); // suggested external port
    req.writeUInt32BE(lifetime, 8);
    sock.on('message', (msg) => {
      if (msg.length < 16) return finish(null);
      const resultCode = msg.readUInt16BE(2);
      if (resultCode !== 0) return finish(null);
      finish({
        internalPort: msg.readUInt16BE(8),
        externalPort: msg.readUInt16BE(10),
        lifetime: msg.readUInt32BE(12),
      });
    });
    sock.on('error', () => finish(null));
    const timer = setTimeout(() => finish(null), MAPPING_TIMEOUT);
    try {
      sock.send(req, NATPMP_PORT, gatewayIp, () => {});
    } catch (_) { finish(null); }
  });
}

/* NAT-PMP 删除映射（发送 lifetime=0 的映射请求） */
function natpmpUnmap(gatewayIp, internalPort, externalPort, protocol) {
  return natpmpMap(gatewayIp, internalPort, externalPort, protocol, 0);
}

/* ---------- 公共 API ---------- */

/* 自动映射端口：先试 UPnP IGD，失败试 NAT-PMP。
   返回 { method, externalPort, protocol } 或 null（静默降级）。 */
async function mapPort(internalPort, externalPort, protocol = 'udp') {
  const key = `${externalPort}:${protocol}`;
  try {
    const gw = await detectGateway();
    if (!gw) return null;

    // 1. 尝试 UPnP IGD（需要 SSDP 发现到 location）
    if (gw.location) {
      try {
        const desc = await httpGet(gw.location, MAPPING_TIMEOUT);
        const svc = parseDescription(desc, gw.location);
        if (svc) {
          const localIP = getLocalIP();
          if (localIP) {
            const ok = await upnpAddPortMapping(svc.controlUrl, svc.serviceType, localIP, internalPort, externalPort, protocol, 'IKWYD');
            if (ok) {
              mappings.set(key, { method: 'upnp', controlUrl: svc.controlUrl, serviceType: svc.serviceType, externalPort, protocol });
              return { method: 'upnp', externalPort, protocol };
            }
          }
        }
      } catch (_) {}
    }

    // 2. 尝试 NAT-PMP（仅需网关 IP）
    if (gw.gatewayIp) {
      try {
        const result = await natpmpMap(gw.gatewayIp, internalPort, externalPort, protocol, LEASE_DURATION);
        if (result) {
          mappings.set(key, { method: 'natpmp', gatewayIp: gw.gatewayIp, internalPort, externalPort: result.externalPort, protocol });
          return { method: 'natpmp', externalPort: result.externalPort, protocol };
        }
      } catch (_) {}
    }
    return null;
  } catch (_) {
    return null; // 静默降级
  }
}

/* 清理端口映射（根据记录的方法回滚） */
async function unmapPort(externalPort, protocol) {
  const key = `${externalPort}:${protocol}`;
  const m = mappings.get(key);
  if (!m) return false;
  mappings.delete(key);
  try {
    if (m.method === 'upnp') {
      await upnpDeletePortMapping(m.controlUrl, m.serviceType, externalPort, protocol);
    } else if (m.method === 'natpmp') {
      await natpmpUnmap(m.gatewayIp, m.internalPort, m.externalPort, protocol);
    }
    return true;
  } catch (_) {
    return false;
  }
}

/* 清理所有映射（用于进程退出兜底） */
async function cleanup() {
  const keys = [...mappings.keys()];
  for (const k of keys) {
    const [port, proto] = k.split(':');
    await unmapPort(Number(port), proto);
  }
}

module.exports = {
  mapPort, unmapPort, cleanup,
  detectGateway, discoverViaSSDP, detectGatewayFromRoute,
  getLocalIP, parseDescription,
};
