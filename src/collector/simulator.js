'use strict';
/* 沙箱模拟数据源：生成拟真种子库与观测事件流。
   与真实采集器共用同一条 Pipeline —— 保证全链路测试的真实性。 */
const crypto = require('crypto');
const pipeline = require('./pipeline');
const { fmtDay } = require('../common/util');

/* 确定性随机（可复现测试） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeInfohash(rand) {
  const b = Buffer.alloc(20);
  for (let i = 0; i < 20; i++) b[i] = Math.floor(rand() * 256);
  return b.toString('hex');
}

/* 拟真种子库模板：命名风格对齐真实 BT 生态 */
const LIBRARY = [
  // Movies (imdb 关联)
  { cat: 'Movies', title: 'Gladiator II', imdb: 'tt9218128', names: ['Gladiator II 2024 1080p WEB-DL DDP5.1 x264', 'Gladiator.II.2024.2160p.WEB-DL.DDP5.1.Atmos.HDR.H.265', 'Gladiator II (2024) [BluRay] [1080p] [YTS.MX]'] },
  { cat: 'Movies', title: 'The Lord of the Rings: The War of the Rohirrim', imdb: 'tt14824600', names: ['The.Lord.of.the.Rings.The.War.of.the.Rohirrim.2024.1080p.WEBRip.x264', 'The War of the Rohirrim 2024 720p WEB-DL x264 AAC'] },
  { cat: 'Movies', title: 'The Order', imdb: 'tt26625693', names: ['The.Order.2024.1080p.WEB-DL.DDP5.1.H.264', 'The Order 2024 HDRip XviD AC3-EVO'] },
  { cat: 'Movies', title: 'Nightbitch', imdb: 'tt12826904', names: ['Nightbitch.2024.1080p.AMZN.WEB-DL.DDP5.1.H.264', 'Nightbitch (2024) 720p WEBRip x264'] },
  { cat: 'Movies', title: 'The Return', imdb: 'tt19861162', names: ['The.Return.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX'] },
  { cat: 'Movies', title: 'Spider-Man: Homecoming', imdb: 'tt2250912', names: ['Spider-Man.Homecoming.(2017).BDRip.x264.AFM.mkv', 'Spider-Man Homecoming 2017 Movies HD Cam XviD Clean Audio AAC New Source with Sample', 'Homem-Aranha - De Volta ao Lar 2017 [BluRay] (3D)'] },
  { cat: 'Movies', title: 'John Wick: Chapter Two', imdb: 'tt4425200', names: ['John.Wick.Chapter.2.2017.1080p.BluRay.x264-SPARKS', 'John Wick Chapter Two 2017 720p BRRip x264 AAC'] },
  { cat: 'Movies', title: 'Logan', imdb: 'tt3315342', names: ['Logan.2017.1080p.BluRay.x264.DTS-HD.MA.7.1-FGT'] },
  { cat: 'Movies', title: 'Ojingeo geim', imdb: 'tt10919420', names: ['Squid.Game.S02.1080p.NF.WEB-DL.DDP5.1.Atmos.H.264', 'Ojingeo.Geim.S02E07.1080p.WEB.H264'] },
  // TV
  { cat: 'TV', title: 'Game of Thrones', imdb: 'tt0944947', names: ['Game.of.Thrones.S04.COMPLETE.1080p.BluRay.x264', 'Game of Thrones Season 4 Soundtrack'] },
  { cat: 'TV', title: 'Teen Wolf', imdb: 'tt1567432', names: ['Teen.Wolf.S06E20.1080p.WEB-DL.x264'] },
  { cat: 'TV', title: 'Breaking Bad', imdb: 'tt0903747', names: ['Breaking.Bad.S01-S05.COMPLETE.720p.BluRay.x264'] },
  // Anime
  { cat: 'Anime', title: 'Attack on Titan', imdb: 'tt2560140', names: ['[SubsPlease] Shingeki no Kyojin - The Final Season - 28 (1080p).mkv', 'Attack.on.Titan.COMPLETE.1080p.BDRip.x265'] },
  { cat: 'Anime', title: 'Frieren', imdb: 'tt22248376', names: ['[Erai-raws] Sousou no Frieren - 28 [1080p].mkv'] },
  // Music
  { cat: 'Music', title: 'Kendrick Lamar - GNX', imdb: null, names: ['Kendrick Lamar - GNX (2024) Mp3 320kbps [PMEDIA]'] },
  { cat: 'Music', title: 'Fleetwood Mac - Rumours', imdb: null, names: ['Fleetwood Mac - Rumours (Super Deluxe) Mp3 320kbps Happydayz'] },
  { cat: 'Music', title: 'Metallica - Discography', imdb: null, names: ['Metallica - Discography 1983-2008 (19 Albums, 23 CDs)'] },
  { cat: 'Music', title: 'Eminem - The Death of Slim Shady', imdb: null, names: ['Eminem - The Death of Slim Shady (Coup De Grace) (2024) Mp3 320kbps [PMEDIA]'] },
  { cat: 'Music', title: 'Stardust - Music Sounds Better', imdb: null, names: ['Stardust - Music Sounds Better With You (1999) 192kbps [PsychO_Path].mp3'] },
  // Games
  { cat: 'Games', title: 'ELDEN RING', imdb: null, names: ['ELDEN RING [FitGirl Repack]', 'Elden.Ring.Shadow.of.the.Erdtree.Edition.v1.16-RUNE'] },
  { cat: 'Games', title: 'God of War Ragnarok', imdb: null, names: ['God of War Ragnarok [FitGirl Repack]'] },
  { cat: 'Games', title: 'Cyberpunk 2077', imdb: null, names: ['Cyberpunk 2077 [FitGirl Repack]', 'Cyberpunk.2077.Ultimate.Edition.v2.21-RUNE'] },
  { cat: 'Games', title: 'Ghost of Tsushima', imdb: null, names: ['Ghost of Tsushima DC [FitGirl Repack]'] },
  { cat: 'Games', title: 'Red Dead Redemption 2', imdb: null, names: ['Red Dead Redemption 2 [FitGirl Repack]'] },
  { cat: 'Games', title: 'World of Warcraft', imdb: null, names: ['World of Warcraft 3.3.5a'] },
  { cat: 'Games', title: 'S.T.A.L.K.E.R. 2', imdb: null, names: ['S.T.A.L.K.E.R. 2 [FitGirl Monkey Repack]'] },
  { cat: 'Games', title: 'TEKKEN 8', imdb: null, names: ['TEKKEN 8 DELUXE EDITION-RUNE [Multi-15] PC.iso'] },
  // Software
  { cat: 'Software', title: 'HorizonXI', imdb: null, names: ['HorizonXI-1_1_3.zip', 'HorizonXI-1_2_1.zip'] },
  { cat: 'Software', title: 'uTorrent Web Tutorial', imdb: null, names: ['uTorrent Web Tutorial Video', 'BitTorrent Web Tutorial Video'] },
  { cat: 'Software', title: 'Toca Boca World Mod', imdb: null, names: ['up-mod-toca-boca-world-mod-apk-1-100-1-82770_82770.apk', 'up-mod-toca-boca-world-mod-apk-1-99-82044_82044.apk'] },
  { cat: 'Software', title: 'Minecraft Mod', imdb: null, names: ['up-mod-download-minecraft-mod-immortality-1-21-60-24-972106024_972106024.apk'] },
  { cat: 'Software', title: 'Car Parking Multiplayer Mod', imdb: null, names: ['up-mod-download-car-parking-multiplayer-mod-unlimited-money-4-8-23-4.apk'] },
  // Books
  { cat: 'Books', title: 'Project Hail Mary', imdb: null, names: ['Andy Weir - Project Hail Mary (2021) [EPUB MOBI]'] },
  { cat: 'Books', title: 'Atomic Habits', imdb: null, names: ['James Clear - Atomic Habits (2018).epub'] },
  // XXX（命名做脱敏处理，仅用于分类链路测试）
  { cat: 'XXX', title: 'Adult Content Pack', imdb: null, names: ['Adult.Content.Pack.2024.1080p.WEB-DL', 'Adult Studio Collection Vol.15 WEB-DL 720p'] },
];

const SIZE_RANGE = {
  Movies: [400e6, 14e9], TV: [200e6, 40e9], Anime: [100e6, 8e9],
  Music: [5e6, 4e9], Games: [1e9, 120e9], Software: [1e6, 8e9],
  Books: [0.5e6, 300e6], XXX: [300e6, 20e9], Unsorted: [1e6, 10e9],
};

function makeFiles(rand, name, size) {
  // 生成 1~6 个文件条目，模拟真实文件列表
  const n = 1 + Math.floor(rand() * 5);
  const files = [];
  let remain = size;
  for (let i = 0; i < n; i++) {
    const part = i === n - 1 ? remain : Math.floor(size * (0.1 + rand() * 0.5) / n);
    remain -= part;
    const ext = name.endsWith('.apk') ? 'apk' : /\.(mp3|flac)/i.test(name) ? 'mp3' : /\.(epub|mobi)/i.test(name) ? 'epub' : /\.(zip|iso)/i.test(name) ? name.split('.').pop() : 'mkv';
    files.push({ path: n === 1 ? name : `${name.replace(/\.[^.]+$/, '')}/file${i + 1}.${ext}`, size: Math.max(part, 1) });
  }
  return files;
}

/* 生成种子库并写入 */
function buildLibrary(rand, now) {
  const torrents = [];
  for (const item of LIBRARY) {
    for (const name of item.names) {
      const infohash = fakeInfohash(rand);
      const [lo, hi] = SIZE_RANGE[item.cat] || SIZE_RANGE.Unsorted;
      const size = Math.floor(lo + rand() * (hi - lo));
      // 发布时间：过去 5~180 天
      const ageDays = 5 + Math.floor(rand() * 175);
      const firstSeen = now - ageDays * 86400000 - Math.floor(rand() * 86400000);
      const t = {
        infohash, name, size,
        category: item.cat, title: item.title, imdb_id: item.imdb,
        first_seen: firstSeen, last_seen: firstSeen, alive: rand() > 0.08 ? 1 : 0,
        metadata_ok: 1, files: makeFiles(rand, name, size),
      };
      pipeline.upsertTorrentMeta(t);
      torrents.push(t);
    }
  }
  return torrents;
}

/* 生成随机公网 IPv4（避开保留段） */
function randomIp(rand) {
  for (;;) {
    const a = 1 + Math.floor(rand() * 223);
    if ([10, 127, 169, 172, 192, 224, 255].includes(a)) continue;
    if (a === 172 || a === 192 || a === 169) continue;
    return [a, Math.floor(rand() * 256), Math.floor(rand() * 256), 1 + Math.floor(rand() * 254)].join('.');
  }
}

/* 主流程：模拟 days 天的采集 */
function simulate(opts = {}) {
  const days = opts.days || 30;
  const eventsPerDay = opts.eventsPerDay || 500;
  const ipPoolSize = opts.ipPoolSize || 900;
  const now = opts.now || Date.now();
  const rand = mulberry32(opts.seed || 20260728);

  const torrents = buildLibrary(rand, now);
  const ips = Array.from({ length: ipPoolSize }, () => randomIp(rand));

  // 热度权重：新发布 + 爆款（前 20% 占 60% 流量，zipf 近似）
  const weights = torrents.map((t, i) => {
    const ageDays = (now - t.first_seen) / 86400000;
    const recency = Math.max(0.05, 1 - ageDays / 200);
    const hot = i < torrents.length * 0.2 ? 6 : 1;
    return recency * hot * (0.5 + rand());
  });
  const totalW = weights.reduce((a, b) => a + b, 0);
  function pickTorrent() {
    let x = rand() * totalW;
    for (let i = 0; i < torrents.length; i++) { x -= weights[i]; if (x <= 0) return torrents[i]; }
    return torrents[torrents.length - 1];
  }

  let total = 0;
  const start = now - days * 86400000;
  for (let d = 0; d < days; d++) {
    const dayStart = start + d * 86400000;
    const dayEnd = Math.min(dayStart + 86400000, now);
    if (dayEnd <= dayStart) continue;
    const events = [];
    // 每天的事件数有波动
    const n = Math.floor(eventsPerDay * (0.7 + rand() * 0.6));
    for (let i = 0; i < n; i++) {
      const t = pickTorrent();
      if (dayEnd < t.first_seen) continue; // 还没发布
      const ts = Math.max(dayStart + Math.floor(rand() * (dayEnd - dayStart)), t.first_seen);
      const ip = rand() < 0.25
        ? ips[Math.floor(rand() * 30)]               // 25% 集中在 30 个“重度用户”，让 peer 页数据丰富
        : ips[Math.floor(rand() * ips.length)];
      events.push({ ip, port: 1024 + Math.floor(rand() * 60000), infohash: t.infohash, ts, source: 'simulator' });
    }
    if (events.length) {
      pipeline.batch(events);
      total += events.length;
    }
  }
  return { torrents: torrents.length, events: total, ips: ipPoolSize, days };
}

module.exports = { simulate, LIBRARY };
