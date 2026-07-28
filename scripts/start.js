'use strict';
/* 一键启动：自动检测可用端口 → 启动站点 + 监控 WebUI + 采集服务。
   用法：
     node scripts/start.js              # 站点 + 模拟采集（默认）
     node scripts/start.js --live       # 站点 + 真实 DHT/PEX/Tracker 采集
     node scripts/start.js --no-collector
     node scripts/start.js --port 9000  # 指定站点端口
     node scripts/start.js --monitor-port 9090  # 指定监控端口 */
const db = require('../src/server/db');
const { findFreePort, isPortAvailable } = require('../src/common/ports');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes(name);

function ensureData() {
  db.open();
  const torrents = db.scalar('SELECT COUNT(*) FROM torrents');
  const events = db.scalar('SELECT COUNT(*) FROM obs_log');
  if (torrents > 0 && events > 0) {
    console.log(`[start] 数据库就绪：${torrents} 个种子 / ${events} 条观测`);
    return;
  }
  console.log('[start] 数据库为空，生成演示数据（约 30 天采集量）...');
  const simulator = require('../src/collector/simulator');
  const r = simulator.simulate({ days: 30, eventsPerDay: 500, ipPoolSize: 900 });
  console.log(`[start] 已生成：${r.torrents} 个种子 / ${r.events} 条观测`);
}

async function main() {
  ensureData();

  // 检测可用端口
  const explicitSite = arg('port');
  const explicitMonitor = arg('monitor-port');
  const defaultSitePort = Number(explicitSite) || 8080;
  const defaultMonitorPort = Number(explicitMonitor) || 8090;

  let sitePort = defaultSitePort;
  let monitorPort = defaultMonitorPort;

  // 如果默认端口被占用，自动找可用端口
  if (!await isPortAvailable(defaultSitePort)) {
    sitePort = await findFreePort(defaultSitePort + 1, defaultSitePort + 200);
    console.log(`[start] 端口 ${defaultSitePort} 被占用，站点改用 ${sitePort}`);
  }
  if (!await isPortAvailable(defaultMonitorPort)) {
    monitorPort = await findFreePort(defaultMonitorPort + 1, defaultMonitorPort + 200);
    if (monitorPort === sitePort) monitorPort = await findFreePort(monitorPort + 1, monitorPort + 200);
    console.log(`[start] 端口 ${defaultMonitorPort} 被占用，监控改用 ${monitorPort}`);
  }

  // 启动主站点（前端 + 后端 API + 内嵌 admin）
  const { start } = require('../src/server/index');
  const collector = hasFlag('--live') ? 'live' : hasFlag('--no-collector') ? undefined : 'sim';
  start(sitePort, { collector });
  console.log(`[start] 站点服务: http://localhost:${sitePort}/`);
  console.log(`[start] 站点内嵌管理: http://localhost:${sitePort}/admin/`);

  // 启动独立监控 WebUI
  const monitor = require('../src/server/monitor');
  const { getCollector } = require('../src/server/index');
  // 等一拍让 collector 初始化
  setTimeout(() => {
    monitor.init(getCollector(), sitePort, monitorPort);
    monitor.start(monitorPort);
    console.log(`[start] 独立监控 WebUI: http://localhost:${monitorPort}/`);
    console.log('[start] 监控项: 采集速率 / DHT节点 / 来源分布 / 系统资源 / 健康度');
  }, 500);

  console.log('[start] ========================================');
  console.log(`[start] 主站点:        http://localhost:${sitePort}`);
  console.log(`[start] 监控WebUI:     http://localhost:${monitorPort}`);
  console.log(`[start] 采集模式:      ${collector || 'off'}`);
  console.log('[start] ========================================');
}

main();
