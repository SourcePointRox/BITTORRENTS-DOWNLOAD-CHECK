'use strict';
/* 真实采集入口（需公网 UDP/TCP 出站能力）：
   node src/collector/run.js --dht --tracker --pex
   DHT 被动/主动观测 → pipeline → 新 infohash 触发 tracker harvest、PEX 扩散与 metadata 解析。
   全量接入 DHT + PEX + Tracker + P2P BitTorrent 网络。 */
const db = require('../server/db');
const pipeline = require('./pipeline');
const { DHTSpider } = require('./dht');
const tracker = require('./tracker');
const metadata = require('./metadata');
const pex = require('./pex');

function main() {
  const args = process.argv.slice(2);
  const useDht = args.includes('--dht');
  const useTracker = args.includes('--tracker');
  const usePex = args.includes('--pex') || true; // PEX 默认开启
  if (!useDht && !useTracker) {
    console.log('Usage: node src/collector/run.js --dht [--tracker] [--pex]');
    console.log('  --dht     : 启用 DHT 采集（BEP-5/51，被动+主动）');
    console.log('  --tracker : 启用 Tracker 采集（HTTP + UDP）');
    console.log('  --pex     : 启用 PEX 采集（BEP-11，默认开启）');
    process.exit(1);
  }
  db.open();
  pipeline.setMetadataCallback((infohash) => {
    // 新 infohash：排队做元数据解析（先做种者地址来自最近观测）
    const d = db.get();
    const rows = d.prepare('SELECT ip,port FROM obs_log WHERE infohash=? AND port IS NOT NULL ORDER BY id DESC LIMIT 5').all(infohash);
    metadata.resolveAndStore(infohash, rows).then((m) => {
      if (m) console.log('[meta]', infohash, m.name);
    });
    if (useTracker) tracker.harvest(infohash, (ev) => pipeline.ingest(ev)).catch(() => {});
    if (usePex && rows.length > 0) {
      pex.harvest(infohash, rows, (ev) => pipeline.ingest(ev)).catch(() => {});
    }
  });

  if (useDht) {
    const spider = new DHTSpider({
      onObservation: (ev) => pipeline.ingest(ev),
      onInfohash: (ih) => pipeline.registerInfohash(ih),
    });
    spider.start();
    setInterval(() => {
      console.log(`[dht] nodes=${spider.nodes.size} rx=${spider.stats.rx} tx=${spider.stats.tx} peers=${spider.stats.peers} announces=${spider.stats.announces}`);
    }, 30000);
    console.log('[collector] DHT spider started on UDP 6881');
    console.log('[collector] PEX harvester: ' + (usePex ? 'enabled' : 'disabled'));
    console.log('[collector] Tracker harvester: ' + (useTracker ? 'enabled' : 'disabled'));
  }
  process.on('SIGINT', () => process.exit(0));
}

main();
