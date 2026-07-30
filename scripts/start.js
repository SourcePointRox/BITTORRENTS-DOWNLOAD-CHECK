'use strict';
/* 一键启动脚本（重写版）：
   预检环境 → 初始化数据库 → 自动检测可用端口 → 启动站点 + 监控 WebUI + 采集服务（+ 冷存储）→ 健康探活 → 优雅退出。

   用法：
     node scripts/start.js                        # 站点 + 模拟采集（默认）
     node scripts/start.js --live                 # 站点 + 真实 DHT/PEX/Tracker 采集（含 IPv6 + BEP-52）
     node scripts/start.js --no-collector          # 仅启动站点
     node scripts/start.js --port 9000             # 指定站点端口
     node scripts/start.js --monitor-port 9090     # 指定监控端口
     node scripts/start.js --dht-port 6881         # 指定 DHT UDP 端口（live 模式）
     node scripts/start.js --no-monitor            # 不启动独立监控 WebUI
     node scripts/start.js --seed                  # 强制重新生成演示数据
     node scripts/start.js --help                  # 显示帮助

   信号：
     Ctrl+C / SIGTERM → 优雅关闭采集器 → 关闭 HTTP 服务 → 退出 */
const db = require('../src/server/db');
const { findFreePort, isPortAvailable } = require('../src/common/ports');

const NODE_MIN_MAJOR = 22;
const NODE_MIN_MINOR = 5;

/* ---------- CLI 解析 ---------- */
function parseArgs() {
  const args = { _: [] };
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    if (tok === '--help' || tok === '-h') { args.help = true; continue; }
    if (tok === '--live') { args.live = true; continue; }
    if (tok === '--no-collector') { args.noCollector = true; continue; }
    if (tok === '--no-monitor') { args.noMonitor = true; continue; }
    if (tok === '--upnp') { args.upnp = true; continue; }
    if (tok === '--no-upnp') { args.upnp = false; continue; }
    if (tok === '--seed') { args.seed = true; continue; }
    // 带 value 的参数
    const next = raw[i + 1];
    if (tok === '--port') { args.port = Number(next); i++; continue; }
    if (tok === '--monitor-port') { args.monitorPort = Number(next); i++; continue; }
    if (tok === '--dht-port') { args.dhtPort = Number(next); i++; continue; }
    if (tok === '--dht-instances') { args.dhtInstances = Number(next); i++; continue; }
    if (tok.startsWith('--') && next && !next.startsWith('--')) {
      args[tok.slice(2)] = next; i++; continue;
    }
    if (tok.startsWith('--')) { args[tok.slice(2)] = true; continue; }
    args._.push(tok);
  }
  return args;
}

function showHelp() {
  console.log(`
BITTORRENTS-DOWNLOAD-CHECK 一键启动

用法:
  node scripts/start.js [选项]

选项:
  --live                真实 DHT + PEX + Tracker 全网络采集（含 IPv6 + BEP-52 hybrid）
  --no-collector        仅启动站点，不启动采集器
  --no-monitor          不启动独立监控 WebUI
  --port <n>           指定站点端口（默认 8080，被占用则自动切换）
  --monitor-port <n>    指定监控端口（默认 8090，被占用则自动切换）
  --dht-port <n>        指定 DHT UDP 起始端口（默认 6881，仅 live 模式；占用自动换端口）
  --dht-instances <n>   DHT 集群并发实例数（默认 3，多端口容错，仅 live 模式）
  --upnp                启用 UPnP/NAT-PMP 端口映射（默认开启，--no-upnp 关闭）
  --no-upnp             关闭 UPnP/NAT-PMP 端口映射
  --seed                强制重新生成演示数据
  --help, -h            显示本帮助

示例:
  node scripts/start.js                              # 模拟采集模式
  node scripts/start.js --live                      # 真实全网络采集
  node scripts/start.js --live --port 9000          # 指定端口
  node scripts/start.js --no-collector --no-monitor # 最小化：仅站点

信号:
  Ctrl+C / SIGTERM    优雅关闭所有服务后退出
`);
}

/* ---------- 环境预检 ---------- */
function checkNode() {
  const parts = process.versions.node.split('.').map(Number);
  const [major, minor] = parts;
  if (major < NODE_MIN_MAJOR || (major === NODE_MIN_MAJOR && minor < NODE_MIN_MINOR)) {
    console.error(`[start] ✘ Node.js 版本过低：当前 ${process.versions.node}，需 ≥ ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}.0`);
    console.error(`[start]   原因：依赖内置 node:sqlite 模块（Node 22.5+ 内置）`);
    process.exit(1);
  }
  // 验证 node:sqlite 可用
  try {
    require('node:sqlite');
  } catch (e) {
    console.error(`[start] ✘ node:sqlite 模块不可用：${e.message}`);
    console.error(`[start]   请升级 Node.js 到 ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+`);
    process.exit(1);
  }
}

/* ---------- 数据初始化 ---------- */
function ensureData(forceSeed) {
  db.open();
  const torrents = db.scalar('SELECT COUNT(*) FROM torrents');
  const events = db.scalar('SELECT COUNT(*) FROM obs_log');
  if (!forceSeed && torrents > 0 && events > 0) {
    console.log(`[start] 数据库就绪：${torrents} 个种子 / ${events} 条观测`);
    return;
  }
  console.log('[start] 数据库为空，生成演示数据（约 30 天采集量）...');
  const simulator = require('../src/collector/simulator');
  const r = simulator.simulate({ days: 30, eventsPerDay: 500, ipPoolSize: 900 });
  console.log(`[start] 已生成：${r.torrents} 个种子 / ${r.events} 条观测`);
}

/* ---------- 端口检测 ---------- */
async function resolvePorts(args) {
  const defaultSite = Number(args.port) || 8080;
  const defaultMonitor = Number(args.monitorPort) || 8090;

  let sitePort = defaultSite;
  let monitorPort = defaultMonitor;

  if (!await isPortAvailable(defaultSite)) {
    sitePort = await findFreePort(defaultSite + 1, defaultSite + 200);
    console.log(`[start] 端口 ${defaultSite} 被占用，站点改用 ${sitePort}`);
  }
  if (!args.noMonitor && !await isPortAvailable(defaultMonitor)) {
    monitorPort = await findFreePort(defaultMonitor + 1, defaultMonitor + 200);
    if (monitorPort === sitePort) monitorPort = await findFreePort(monitorPort + 1, monitorPort + 200);
    console.log(`[start] 端口 ${defaultMonitor} 被占用，监控改用 ${monitorPort}`);
  }
  return { sitePort, monitorPort };
}

/* ---------- 优雅退出 ---------- */
let shuttingDown = false;
function setupGracefulShutdown(siteServer, collector, monitor) {
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[start] 收到 ${sig}，正在关闭服务...`);
    try { if (collector) collector.stop(); } catch (_) {}
    try { if (monitor && monitor.stop) monitor.stop(); } catch (_) {}
    try { if (siteServer) siteServer.close(() => process.exit(0)); }
    catch (_) { process.exit(0); }
    // 兜底：3 秒后强制退出
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/* ---------- 健康探活 ---------- */
async function healthCheck(sitePort) {
  const url = `http://localhost:${sitePort}/api/overview`;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json();
        console.log(`[start] ✔ 健康检查通过：${body.totalTorrents} 种子 / ${body.totalPeers} peer`);
        return true;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
  console.log('[start] ⚠ 健康检查超时（站点可能仍在启动中，请稍后手动访问）');
  return false;
}

/* ---------- 主流程 ---------- */
async function main() {
  const args = parseArgs();
  if (args.help) { showHelp(); return; }

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   BITTORRENTS-DOWNLOAD-CHECK  一键启动                     ║');
  console.log('║   DHT + PEX + Tracker + BEP-52 v2/hybrid + MSE/PE + IPv6   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  // 1. 环境预检
  checkNode();
  console.log(`[start] Node.js ${process.versions.node} / ${process.platform}`);

  // 2. 数据初始化
  ensureData(args.seed);

  // 3. 端口检测
  const { sitePort, monitorPort } = await resolvePorts(args);

  // 4. 确定采集模式
  let collectorMode = undefined;
  if (args.noCollector) collectorMode = undefined;
  else if (args.live) collectorMode = 'live';
  else collectorMode = 'sim';

  // 5. 启动主站点（前端 + 后端 API + 内嵌 admin + 采集器）
  const { start, getCollector } = require('../src/server/index');
  const siteServer = start(sitePort, {
    collector: collectorMode,
    dhtPort: Number(args.dhtPort) || 6881,
    dhtInstances: Number(args.dhtInstances) || 3,
    upnp: args.upnp !== false,
  });

  // 6. 启动独立监控 WebUI
  let monitor = null;
  if (!args.noMonitor) {
    monitor = require('../src/server/monitor');
    const collector = getCollector();
    // 等一拍让 collector 初始化
    await new Promise(r => setTimeout(r, 500));
    monitor.init(collector, sitePort, monitorPort);
    monitor.start(monitorPort);
  }

  // 7. 健康探活
  await healthCheck(sitePort);

  // 8. 输出服务地址
  console.log('[start] ═══════════════════════════════════════════');
  console.log(`[start] 主站点:        http://localhost:${sitePort}`);
  console.log(`[start] 内嵌管理:      http://localhost:${sitePort}/admin/`);
  if (!args.noMonitor) {
    console.log(`[start] 监控WebUI:     http://localhost:${monitorPort}`);
  }
  console.log(`[start] REST API:      http://localhost:${sitePort}/api/`);
  console.log(`[start] 冷存储信息:    http://localhost:${sitePort}/en/cold-storage/`);
  console.log(`[start] 采集模式:      ${collectorMode || 'off'}${collectorMode === 'live' ? ' (DHT+PEX+Tracker)' : ''}`);
  if (collectorMode === 'live') {
    console.log(`[start] DHT UDP:       ${Number(args.dhtPort) || 6881} (IPv4+IPv6 双栈)`);
    console.log(`[start] UPnP/NAT-PMP:  ${args.upnp !== false ? '开启' : '关闭'}`);
    if (process.env.IKWYD_SOCKS5_PROXY) console.log(`[start] SOCKS5 代理:   ${process.env.IKWYD_SOCKS5_PROXY.replace(/:[^:@]*@/, ':****@')}`);
  }
  console.log('[start] ═══════════════════════════════════════════');
  console.log('[start] 按 Ctrl+C 优雅退出');

  // 9. 优雅退出
  setupGracefulShutdown(siteServer, getCollector(), monitor);
}

main().catch(e => {
  console.error('[start] 启动失败:', e);
  process.exit(1);
});
