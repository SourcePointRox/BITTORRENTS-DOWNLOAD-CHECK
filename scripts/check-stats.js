'use strict';
const http = require('http');
http.get('http://localhost:8090/api/stats', (r) => {
  let d = '';
  r.on('data', c => d += c);
  r.on('end', () => {
    const j = JSON.parse(d);
    console.log('=== BITTORRENTS 网络采集监控 ===');
    console.log('运行时长:', j.uptimeSec + 's');
    console.log('采集模式:', j.mode);
    console.log('--- DHT ---');
    console.log('节点数:', j.dht.nodes, '| rx:', j.dht.rx, '| tx:', j.dht.tx);
    console.log('peers:', j.dht.peers, '| announces:', j.dht.announces);
    console.log('--- 采集器 ---');
    console.log('Tracker peers:', j.counters.trackerPeers);
    console.log('PEX peers:', j.counters.pexPeers);
    console.log('新种子:', j.counters.newTorrents);
    console.log('元数据解析:', j.counters.metaResolved, '/ 失败:', j.counters.metaFailed);
    console.log('--- 速率 ---');
    console.log('当前速率:', j.ratePerMin, '/min');
    console.log('会话累计:', j.counters.ingested);
    console.log('--- 数据库 ---');
    console.log('种子:', j.db.torrents, '| IP:', j.db.peers, '| 观测:', j.db.observations, '| 日志:', j.db.obsLog);
    console.log('今日事件:', j.todayEvents);
    console.log('--- 来源分布 ---');
    for (const s of j.sources) console.log(' ', s.source + ':', s.c);
    console.log('健康度:', j.health + '/100');
  });
});
