'use strict';
/* 元数据聚合补全模块（多 BT 站聚合搜索）。
   当 ut_metadata 从 peer 拉取失败（peer 下线/无元数据/连接被拒）时，
   按 infohash 聚合查询多个开放种子库/BT 站，补全 name / size / category / seeders：
   - SolidTorrents API（DHT 爬虫索引，JSON API，多域名镜像）—— 主源
   - Knaben Database API（全网最大聚合索引之一，JSON API）
   - apibay（ThePirateBay 官方 API，JSON）
   - torrentz2.nz（元搜索引擎，HTML 聚合多家索引）
   - BT4G（DHT 索引站，HTML）
   工程化设计：
   - 每 provider 熔断器（连续失败 3 次冷却 10 分钟，自动恢复）
   - 全局并发闸（2）+ 每 provider 最小间隔（1.5s + 抖动），避免被封
   - DB + 内存双层缓存（7 天 TTL），同一 infohash 不重复外查
   - 结果只作“补全”（metadata_ok 保持 0 表示未经哈希校验），name/size/category 入库 */
const db = require('../server/db');
const classifier = require('./classifier');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CACHE_TTL = 7 * 24 * 3600 * 1000;
const PROVIDER_COOLDOWN = 10 * 60 * 1000;
const MAX_PROVIDER_FAILS = 3;

/* ---------- 缓存 ---------- */
const memCache = new Map(); // infohash -> {ts, data|null}
let cacheStmt = null;
function ensureCache() {
  if (cacheStmt) return;
  const d = db.get();
  d.exec(`CREATE TABLE IF NOT EXISTS meta_cache (
    infohash TEXT PRIMARY KEY,
    payload TEXT,
    found INTEGER DEFAULT 0,
    ts INTEGER
  )`);
  cacheStmt = {
    get: d.prepare('SELECT payload, found, ts FROM meta_cache WHERE infohash=?'),
    put: d.prepare('INSERT OR REPLACE INTO meta_cache(infohash,payload,found,ts) VALUES(?,?,?,?)'),
  };
}

function cacheGet(ih) {
  const m = memCache.get(ih);
  if (m && Date.now() - m.ts < CACHE_TTL) return m;
  try {
    ensureCache();
    const row = cacheStmt.get.get(ih);
    if (row && Date.now() - row.ts < CACHE_TTL) {
      const data = row.found && row.payload ? JSON.parse(row.payload) : null;
      memCache.set(ih, { ts: row.ts, data });
      return { ts: row.ts, data };
    }
  } catch (_) {}
  return null;
}

function cachePut(ih, data) {
  memCache.set(ih, { ts: Date.now(), data });
  try {
    ensureCache();
    cacheStmt.put.run(ih, data ? JSON.stringify(data) : null, data ? 1 : 0, Date.now());
  } catch (_) {}
}

/* ---------- 限流与熔断 ---------- */
const state = new Map(); // name -> {fails, cooldownUntil, lastCall}
let globalSem = 0;
const GLOBAL_CONCURRENCY = 2;

function providerState(name) {
  if (!state.has(name)) state.set(name, { fails: 0, cooldownUntil: 0, lastCall: 0 });
  return state.get(name);
}

function providerAvailable(name) {
  return providerState(name).cooldownUntil < Date.now();
}

function providerOk(name) {
  const s = providerState(name);
  s.fails = 0;
}

function providerFail(name) {
  const s = providerState(name);
  s.fails++;
  if (s.fails >= MAX_PROVIDER_FAILS) {
    s.cooldownUntil = Date.now() + PROVIDER_COOLDOWN;
    s.fails = 0;
  }
}

async function throttle(name) {
  const s = providerState(name);
  const wait = Math.max(0, s.lastCall + 1500 + Math.random() * 1000 - Date.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  s.lastCall = Date.now();
}

async function withSem(fn) {
  while (globalSem >= GLOBAL_CONCURRENCY) await new Promise(r => setTimeout(r, 100));
  globalSem++;
  try { return await fn(); } finally { globalSem--; }
}

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 10000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json', ...(opts.headers || {}) },
      method: opts.method || 'GET',
      body: opts.body,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('not-json');
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(timer); }
}

/* ---------- Providers ---------- */
/* 统一返回：[{ name, size, seeders, leechers, categoryHint, source }] 或 [] */

// SolidTorrents（DHT 爬虫索引，JSON API，多域名镜像）
const SOLID_DOMAINS = ['solidtorrents.eu', 'solidtorrents.to', 'solidtorrents.net'];
let solidDomainIdx = 0;
async function viaSolidTorrents(infohash) {
  const domain = SOLID_DOMAINS[solidDomainIdx % SOLID_DOMAINS.length];
  const j = await fetchJson(`https://${domain}/api/v1/search?q=${infohash}`);
  if (!j || !Array.isArray(j.results)) return [];
  return j.results
    .filter(r => String(r.infohash || '').toLowerCase() === infohash)
    .map(r => ({
      name: r.title, size: Number(r.size) || 0,
      seeders: r.seeders | 0, leechers: r.leechers | 0,
      categoryHint: null, source: 'solidtorrents',
    }));
}

// Knaben Database（聚合 TPB/Nyaa/1337x 等多家索引，JSON API）
// 注意：knaben 的搜索是全文模糊匹配（即使 search_field=hash），
// 必须拉大 size 后在结果中按 hash 精确过滤。
async function viaKnaben(infohash) {
  const j = await fetchJson('https://api.knaben.eu/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: infohash, search_type: '100%', search_field: 'hash', size: 50 }),
  });
  if (!j || !Array.isArray(j.hits)) return [];
  return j.hits
    .filter(h => String(h.hash || '').toLowerCase() === infohash)
    .map(h => {
      let name = h.title || null;
      if (!name && h.magnetUrl) {
        const m = h.magnetUrl.match(/[?&]dn=([^&]+)/);
        if (m) { try { name = decodeURIComponent(m[1]).replace(/\+/g, ' '); } catch (_) { name = m[1]; } }
      }
      return {
        name, size: Number(h.bytes) || 0,
        seeders: h.seeders | 0, leechers: h.leechers | 0,
        categoryHint: h.category || null, source: 'knaben',
        magnetUrl: h.magnetUrl || null,
      };
    });
}

// apibay（ThePirateBay 官方 API）
const APIBAY_HOSTS = ['apibay.org', 'apibay.blue', 'apibay.sredu.org'];
let apibayIdx = 0;
async function viaApibay(infohash) {
  const host = APIBAY_HOSTS[apibayIdx % APIBAY_HOSTS.length];
  const j = await fetchJson(`https://${host}/q.php?q=${infohash}`);
  if (!Array.isArray(j)) return [];
  return j
    .filter(r => r && String(r.info_hash || '').toLowerCase() === infohash && r.name)
    .map(r => ({
      name: r.name, size: Number(r.size) || 0,
      seeders: Number(r.seeders) | 0, leechers: Number(r.leechers) | 0,
      categoryHint: r.category || null, source: 'apibay',
    }));
}

// torrentz2.nz（元搜索引擎，HTML 聚合）
async function viaTorrentz2(infohash) {
  const html = await fetchText(`https://torrentz2.nz/search?f=${infohash}`);
  if (!html || !html.includes('<dl>')) return [];
  const out = [];
  const dlRe = /<dl>([\s\S]*?)<\/dl>/g;
  let m;
  while ((m = dlRe.exec(html)) !== null && out.length < 5) {
    const block = m[1];
    const nameM = block.match(/<dt>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    if (!nameM) continue;
    const name = nameM[1].replace(/<[^>]+>/g, '').trim();
    const sizeM = block.match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
    let size = 0;
    if (sizeM) {
      const mult = { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[sizeM[2].toUpperCase()] || 1;
      size = Math.round(parseFloat(sizeM[1]) * mult);
    }
    if (name) out.push({ name, size, seeders: 0, leechers: 0, categoryHint: null, source: 'torrentz2' });
  }
  return out;
}

// BT4G（DHT 索引站，HTML）
async function viaBt4g(infohash) {
  const html = await fetchText(`https://bt4g.org/search?q=${infohash}`);
  if (!html) return [];
  const out = [];
  // BT4G 结果卡片：<a href="/magnet/{hash}" ...>title</a> ... <b>size</b>
  const cardRe = /<a href="\/magnet\/[a-f0-9]{40}"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:Size|size)[:\s]*<[^>]*>([\d.]+)\s*(GB|MB|KB|TB)/gi;
  let m;
  while ((m = cardRe.exec(html)) !== null && out.length < 5) {
    const name = m[1].replace(/<[^>]+>/g, '').trim();
    const mult = { KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[m[3].toUpperCase()] || 1;
    const size = Math.round(parseFloat(m[2]) * mult);
    if (name) out.push({ name, size, seeders: 0, leechers: 0, categoryHint: null, source: 'bt4g' });
  }
  return out;
}

const PROVIDERS = [
  { name: 'solidtorrents', fn: viaSolidTorrents },
  { name: 'knaben', fn: viaKnaben },
  { name: 'apibay', fn: viaApibay },
  { name: 'torrentz2', fn: viaTorrentz2 },
  { name: 'bt4g', fn: viaBt4g },
];

/* Knaben category → 本站分类映射（粗粒度提示，最终仍以 classifier 为准） */
const KNABEN_CAT_MAP = [
  [/movie|video|film/i, 'Movies'], [/tv|series|show/i, 'TV'],
  [/anime/i, 'Anime'], [/audio|music|lossless|mp3|flac/i, 'Music'],
  [/game/i, 'Games'], [/software|app|program|windows|mac|linux/i, 'Software'],
  [/book|ebook|comic|magazine/i, 'Books'], [/xxx|porn|adult/i, 'XXX'],
];

function mapCategoryHint(hint) {
  if (!hint) return null;
  for (const [re, cat] of KNABEN_CAT_MAP) if (re.test(hint)) return cat;
  return null;
}

/* ---------- 聚合查询 ---------- */
/* enrich(infohash)：按优先级查询各 provider，首个精确命中即返回。
   返回 { name, size, category, seeders, leechers, source } 或 null。
   结果（含未命中）写缓存，7 天内不重复外查。 */
async function enrich(infohash) {
  const ih = String(infohash || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(ih)) return null; // v2 64-hex 暂不支持外部索引（索引站都是 v1 哈希）
  const cached = cacheGet(ih);
  if (cached) return cached.data;

  for (const p of PROVIDERS) {
    if (!providerAvailable(p.name)) continue;
    try {
      await throttle(p.name);
      const results = await withSem(() => p.fn(ih));
      providerOk(p.name);
      if (results && results.length) {
        const best = results[0];
        const category = mapCategoryHint(best.categoryHint) || (best.name ? classifier.classify(best.name) : null);
        const data = {
          name: best.name || null,
          size: best.size || 0,
          category,
          seeders: best.seeders | 0,
          leechers: best.leechers | 0,
          source: 'meta_' + best.source,
          magnetUrl: best.magnetUrl || null,
        };
        if (data.name) { cachePut(ih, data); return data; }
      }
    } catch (_) {
      providerFail(p.name);
      // SolidTorrents / apibay 多域名轮换
      if (p.name === 'solidtorrents') solidDomainIdx++;
      if (p.name === 'apibay') apibayIdx++;
    }
  }
  cachePut(ih, null); // 负缓存：7 天内不再重复查询
  return null;
}

/* provider 状态（监控展示） */
function getStats() {
  const out = {};
  for (const p of PROVIDERS) {
    const s = providerState(p.name);
    out[p.name] = {
      available: s.cooldownUntil < Date.now(),
      cooldownSec: Math.max(0, Math.round((s.cooldownUntil - Date.now()) / 1000)),
    };
  }
  return { providers: out, cacheSize: memCache.size };
}

module.exports = { enrich, getStats };
