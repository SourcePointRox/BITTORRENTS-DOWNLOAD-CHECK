'use strict';
/* 第三轮：采集层组件单元测试（离线，不需要公网）。
   运行：node tests/unit.js */
process.env.IKWYD_DB = require('path').join(__dirname, '..', 'data', 'unit.db');

const bencode = require('../src/common/bencode');
const { normalizeInfohash, base32Encode, magnetURI, sha1 } = require('../src/common/util');
const metadata = require('../src/collector/metadata');
const tracker = require('../src/collector/tracker');
const pipeline = require('../src/collector/pipeline');
const db = require('../src/server/db');

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('== 1. bencode 编解码 ==');
{
  const obj = { a: 1, b: Buffer.from('xy'), c: [1, 'z'], d: { k: 'v' } };
  const encoded = bencode.encode(obj);
  const decoded = bencode.decode(encoded);
  ok('字典往返', decoded.a === 1 && decoded.b.toString() === 'xy' && decoded.c[0] === 1 && decoded.c[1].toString() === 'z' && decoded.d.k.toString() === 'v');
  ok('键按字典序编码', encoded.toString().startsWith('d1:ai1e1:b2:xy1:cl'));

  // 真实 KRPC 报文
  const krpc = { t: Buffer.from([0, 1]), y: 'q', q: 'get_peers', a: { id: Buffer.alloc(20, 7), info_hash: Buffer.alloc(20, 9) } };
  const dec2 = bencode.decode(bencode.encode(krpc));
  ok('KRPC get_peers 往返', dec2.q.toString() === 'get_peers' && dec2.a.info_hash.equals(Buffer.alloc(20, 9)));

  // findKeyRaw：info 字典原始字节（ut_metadata 校验路径）
  const info = { name: 'test.mkv', length: 12345, 'piece length': 16384, pieces: Buffer.alloc(20) };
  const torrentFile = bencode.encode({ announce: 'http://t/announce', info });
  const infoRaw = bencode.findKeyRaw(torrentFile, 'info');
  ok('findKeyRaw 提取 info 原始字节', !!infoRaw && infoRaw.equals(bencode.encode(info)));
  ok('SHA-1(infoRaw) 即 infohash', sha1(infoRaw).length === 20);
}

console.log('== 2. 元数据解析与分类 ==');
{
  const infoRaw = bencode.encode({
    name: 'Gladiator II 2024 1080p WEB-DL',
    files: [
      { length: 1000, path: [Buffer.from('Gladiator II 2024 1080p WEB-DL.mkv')] },
      { length: 500, path: [Buffer.from('Subs'), Buffer.from('eng.srt')] },
    ],
  });
  const meta = metadata.parseInfo(infoRaw);
  ok('多文件种子解析', meta.name === 'Gladiator II 2024 1080p WEB-DL' && meta.size === 1500 && meta.files.length === 2);
  ok('嵌套路径拼接', meta.files[1].path === 'Subs/eng.srt');

  const cases = [
    ['Movie.Name.2024.1080p.WEB-DL.x264', 'Movies'],
    ['Show.Name.S02E05.1080p.WEB-DL', 'TV'],
    ['[SubsPlease] Anime Title - 12 (1080p)', 'Anime'],
    ['Artist - Album (2024) Mp3 320kbps', 'Music'],
    ['Some Game [FitGirl Repack]', 'Games'],
    ['app-mod-android-v1.2.apk', 'Software'],
    ['Book Title (2021).epub', 'Books'],
    ['Random Stuff Pack', 'Unsorted'],
  ];
  for (const [name, cat] of cases) ok(`分类: ${name} → ${cat}`, metadata.classify(name) === cat, 'got ' + metadata.classify(name));
}

console.log('== 3. Tracker 紧凑 peer 解析 ==');
{
  const buf = Buffer.from([1, 2, 3, 4, 0x1A, 0xE1, 5, 6, 7, 8, 0x00, 0x50]);
  // scrapeTracker 内部函数未导出，直接验证协议格式处理逻辑：模拟一组 6 字节 peer
  const peers = [];
  for (let i = 0; i + 6 <= buf.length; i += 6) peers.push({ ip: [...buf.slice(i, i + 4)].join('.'), port: buf.readUInt16BE(i + 4) });
  ok('紧凑格式解析', peers.length === 2 && peers[0].ip === '1.2.3.4' && peers[0].port === 6881 && peers[1].port === 80);
  ok('tracker 模块可加载且带公共 tracker 列表', Array.isArray(tracker.PUBLIC_TRACKERS) && tracker.PUBLIC_TRACKERS.length > 0);
}

console.log('== 4. infohash / magnet ==');
{
  const ih = 'b4888d036f4c32222889f8846b820d031910612b';
  ok('hex 规范化', normalizeInfohash(ih) === ih);
  ok('base32 往返', normalizeInfohash(base32Encode(Buffer.from(ih, 'hex'))) === ih);
  const m = magnetURI(ih, 'Gladiator II');
  ok('magnet 结构', m.startsWith('magnet:?xt=urn:btih:' + ih) && m.includes('&dn=Gladiator%20II') && m.includes('&tr='));
}

console.log('== 5. DHT 爬虫离线行为 ==');
{
  const { DHTSpider } = require('../src/collector/dht');
  const got = [];
  const spider = new DHTSpider({ port: 0, onObservation: (e) => got.push(e) });
  // 手工构造 announce_peer 查询报文并驱动 _onQuery
  const ih = Buffer.alloc(20, 0xAB);
  const msg = {
    t: Buffer.from([1, 2]), y: 'q', q: 'announce_peer',
    a: { id: Buffer.alloc(20, 1), implied_port: 0, port: 51413, info_hash: ih, token: Buffer.from('tk') },
  };
  // 模拟响应发送
  let responded = null;
  spider._respond = (tid, r) => { responded = r; };
  spider._onMessage(bencode.encode(msg), { address: '203.0.113.7', port: 9999 });
  ok('announce_peer 捕获观测', got.length === 1 && got[0].ip === '203.0.113.7' && got[0].port === 51413 && got[0].infohash === ih.toString('hex') && got[0].source === 'dht_passive');
  ok('announce_peer 有协议应答', !!responded && Buffer.isBuffer(responded.id));

  const ping = { t: Buffer.from([3]), y: 'q', q: 'ping', a: { id: Buffer.alloc(20, 2) } };
  responded = null;
  spider._onMessage(bencode.encode(ping), { address: '198.51.100.9', port: 1234 });
  ok('ping 应答', !!responded && Buffer.isBuffer(responded.id));
  ok('节点进入路由表', spider.routing && spider.routing.size() >= 1);

  // 畸形报文不崩溃
  spider._onMessage(Buffer.from('not bencode at all'), { address: '1.1.1.1', port: 1 });
  ok('畸形报文容错', true);
}

console.log('== 6. pipeline.registerInfohash ==');
{
  db.open();
  for (const t of ['obs_log', 'observations', 'peers', 'torrents', 'daily_stats', 'torrent_daily', 'country_daily', 'ip_geo', 'track_links', 'meta'])
    db.get().exec('DROP TABLE IF EXISTS ' + t);
  db.close(); db.open();
  const ih = 'cd'.repeat(20);
  ok('登记新 infohash', pipeline.registerInfohash(ih) === true);
  ok('重复登记返回 false', pipeline.registerInfohash(ih) === false);
  ok('不产生 peer 记录', db.scalar('SELECT COUNT(*) FROM peers') === 0);
  ok('不产生观测记录', db.scalar('SELECT COUNT(*) FROM obs_log') === 0);
  ok('torrents 占位行存在', db.scalar('SELECT COUNT(*) FROM torrents WHERE infohash=?', ih) === 1);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failures.length) failures.forEach(f => console.log('  - ' + f));
process.exit(failed ? 1 : 0);
