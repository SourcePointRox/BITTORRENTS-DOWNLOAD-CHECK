'use strict';
/* GeoIP 模块：本地离线 MMDB 优先 + ip-api.com 在线兜底。
   - 同步 lookup(ip)：内存缓存 → DB 缓存 → 本地 MMDB → 未命中加入待查队列，返回临时占位
   - 异步 flushPending()：批量查询 ip-api.com（每批 100 个，支持中文），写回 DB + 内存
   - 定期 refresh()：对已缓存但超 30 天的 IP 重新查询（本地可解的直接刷新，不走在线）
   - 降级策略：本地库未加载/未命中 → 在线 API；API 失败 → demoResolve 占位
   接口与旧版完全兼容：lookup/populationOf/penetrationOf/allCountries/countryName */
const db = require('./db');
const fs = require('fs');
const path = require('path');
const { ipToInt } = require('../common/util');
const mmdb = require('./mmdb-reader');

/* ---- 国家人口与网络普及率（用于统计页） ---- */
const COUNTRY_POPULATION_MLN = {
  US: 334, CN: 1412, RU: 144, UA: 38, IN: 1417, BR: 216, DE: 84, FR: 68,
  GB: 67, JP: 125, KR: 52, CA: 39, AU: 26, NL: 18, ES: 48, IT: 59, PL: 38, TR: 85,
};
const INTERNET_PENETRATION = {
  US: 0.92, CN: 0.76, RU: 0.88, UA: 0.79, IN: 0.46, BR: 0.81, DE: 0.93, FR: 0.93,
  GB: 0.95, JP: 0.83, KR: 0.97, CA: 0.94, AU: 0.90, NL: 0.97, ES: 0.93, IT: 0.85, PL: 0.87, TR: 0.83,
};
const ALL_COUNTRIES = [
  { cc: 'CN', country: 'China' }, { cc: 'US', country: 'United States' }, { cc: 'RU', country: 'Russia' },
  { cc: 'UA', country: 'Ukraine' }, { cc: 'IN', country: 'India' }, { cc: 'BR', country: 'Brazil' },
  { cc: 'DE', country: 'Germany' }, { cc: 'FR', country: 'France' }, { cc: 'GB', country: 'United Kingdom' },
  { cc: 'JP', country: 'Japan' }, { cc: 'KR', country: 'South Korea' }, { cc: 'CA', country: 'Canada' },
  { cc: 'AU', country: 'Australia' }, { cc: 'NL', country: 'Netherlands' }, { cc: 'ES', country: 'Spain' },
  { cc: 'IT', country: 'Italy' }, { cc: 'PL', country: 'Poland' }, { cc: 'TR', country: 'Turkey' },
  { cc: 'HK', country: 'Hong Kong' }, { cc: 'TW', country: 'Taiwan' }, { cc: 'SG', country: 'Singapore' },
  { cc: 'TH', country: 'Thailand' }, { cc: 'VN', country: 'Vietnam' }, { cc: 'ID', country: 'Indonesia' },
  { cc: 'PH', country: 'Philippines' }, { cc: 'MY', country: 'Malaysia' }, { cc: 'SE', country: 'Sweden' },
  { cc: 'CH', country: 'Switzerland' }, { cc: 'AT', country: 'Austria' }, { cc: 'BE', country: 'Belgium' },
  { cc: 'NO', country: 'Norway' }, { cc: 'DK', country: 'Denmark' }, { cc: 'FI', country: 'Finland' },
  { cc: 'PT', country: 'Portugal' }, { cc: 'GR', country: 'Greece' }, { cc: 'CZ', country: 'Czech Republic' },
  { cc: 'RO', country: 'Romania' }, { cc: 'HU', country: 'Hungary' }, { cc: 'BG', country: 'Bulgaria' },
  { cc: 'MX', country: 'Mexico' }, { cc: 'AR', country: 'Argentina' }, { cc: 'CL', country: 'Chile' },
  { cc: 'CO', country: 'Colombia' }, { cc: 'ZA', country: 'South Africa' }, { cc: 'AE', country: 'UAE' },
  { cc: 'SA', country: 'Saudi Arabia' }, { cc: 'IL', country: 'Israel' }, { cc: 'EG', country: 'Egypt' },
  { cc: 'NG', country: 'Nigeria' }, { cc: 'KE', country: 'Kenya' }, { cc: 'PK', country: 'Pakistan' },
  { cc: 'BD', country: 'Bangladesh' }, { cc: 'IR', country: 'Iran' }, { cc: 'IQ', country: 'Iraq' },
];

/* ---- 降级用：临时占位（API 查询完成前的返回，标记 _pending） ---- */
function demoResolve(ip) {
  return {
    cc: null, country: 'Unknown', region: '', city: 'Resolving...',
    lat: 0, lon: 0, timezone: '', continent: '', isp: '', _pending: true,
  };
}

/* ---- 私有 IP 检测（不查询 API） ---- */
function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const o2 = parseInt(ip.split('.')[1], 10);
    if (o2 >= 16 && o2 <= 31) return true;
  }
  if (ip.startsWith('127.') || ip.startsWith('169.254.')) return true;
  if (ip === '::1' || ip === '::') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // IPv6 ULA
  if (ip.startsWith('fe80')) return true; // IPv6 link-local
  return false;
}

/* 私有 IP 的固定返回 */
const PRIVATE_GEO = { cc: 'LO', country: 'Local', region: 'Private', city: 'LAN', lat: 0, lon: 0, isp: 'Private', continent: 'Local', timezone: 'local' };

/* ---- 本地离线 MMDB 库（GeoLite2）----
   优先加载 City 库（含城市/经纬度），其次 Country 库（仅国家）。
   文件不存在或格式错误时静默降级到在线 API。
   懒加载：首次 localLookup 时加载，避免影响启动速度。 */
const GEOIP_DIR = path.join(__dirname, '..', '..', 'data', 'geoip');
let localReader = null;       // MMDBReader 实例 | null
let localReaderLoaded = false; // 是否已尝试加载（避免重复磁盘检查）
let localHits = 0, localMisses = 0;

function loadLocalReader() {
  if (localReaderLoaded) return localReader;
  localReaderLoaded = true;
  /* 按优先级尝试：City（信息最全）→ Country（仅国家/洲） */
  for (const name of ['GeoLite2-City.mmdb', 'GeoIP2-City.mmdb', 'GeoLite2-Country.mmdb', 'GeoIP2-Country.mmdb']) {
    const fp = path.join(GEOIP_DIR, name);
    if (fs.existsSync(fp)) {
      localReader = mmdb.open(fp);
      if (localReader) {
        try { console.log(`[geo] local MMDB loaded: ${name} (${localReader.databaseType}, ip${localReader.ipVersion})`); } catch (_) {}
        break;
      }
    }
  }
  if (!localReader) {
    try { console.log('[geo] no local MMDB found, falling back to online API only'); } catch (_) {}
  }
  return localReader;
}

/* 从 MMDB names map 中取国家/洲名称，优先中文 → 英文 → 首个可用 */
function pickName(names) {
  if (!names || typeof names !== 'object') return '';
  return names['zh-CN'] || names.zh || names.en || Object.values(names)[0] || '';
}

/* 将 MMDB 原始记录映射为内部统一格式（与 mapApiResult 一致） */
function mapLocalResult(ip, rec) {
  if (!rec) return null;
  const country = rec.country || rec.registered_country || {};
  const continent = rec.continent || {};
  const city = rec.city || {};
  const loc = rec.location || {};
  const subs = rec.subdivisions;
  const regionName = (subs && subs[0] && pickName(subs[0].names)) || pickName(city.names) || '';
  const cc = country.iso_code || null;
  if (!cc) return null; /* 无国家码视为未命中 */
  return {
    ip,
    cc,
    country: pickName(country.names) || 'Unknown',
    region: regionName,
    city: pickName(city.names) || 'Unknown',
    lat: loc.latitude || 0,
    lon: loc.longitude || 0,
    timezone: loc.time_zone || '',
    continent: continent.code || '',
    isp: '', /* GeoLite2 免费版不含 ISP，留空由在线 API 补全（仅在 fallback 时） */
    resolved_at: Date.now(),
  };
}

/* 本地 MMDB 同步查询。命中返回标准格式记录，未命中返回 null。 */
function localLookup(ip) {
  const reader = loadLocalReader();
  if (!reader) return null;
  try {
    const rec = reader.lookup(ip);
    if (!rec) { localMisses++; return null; }
    const mapped = mapLocalResult(ip, rec);
    if (mapped) { localHits++; return mapped; }
    localMisses++;
    return null;
  } catch (_) { localMisses++; return null; }
}

/* ---- 内存缓存 + DB 预编译语句 ---- */
const memCache = new Map();
let stmts = null;

function ensureStmts() {
  if (stmts) return;
  const d = db.get();
  stmts = {
    get: d.prepare('SELECT * FROM ip_geo WHERE ip = ?'),
    ins: d.prepare('INSERT OR REPLACE INTO ip_geo(ip,cc,country,region,city,lat,lon,timezone,continent,isp,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'),
  };
}

/* ---- 待查询队列（批量查询降低 API 调用） ---- */
const pendingQueue = new Set();
let flushing = false;
const BATCH_SIZE = 100;       // ip-api.com 批量上限
const REFRESH_INTERVAL = 30 * 24 * 3600 * 1000; // 30 天刷新

/* ---- 多解析服务聚合：主批量源 + 多个备用单查源，熔断轮换 ----
   任何一个 GeoIP 免费服务都可能限流/宕机/被墙，单一来源会导致解析服务不稳定。
   策略：
   1. 主源 ip-api.com 批量（100 IP/请求，最省配额）；
   2. 主源失败/限流 → 备用源逐个单查轮换（freeipapi → ipwho.is → ipapi.co）；
   3. 每源独立熔断器：连续失败 3 次冷却 10 分钟，自动恢复；
   4. 解析结果跨源归一化为统一字段格式。 */
const providerHealth = {
  'ip-api': { fails: 0, cooldownUntil: 0, ok: 0, fail: 0 },
  'freeipapi': { fails: 0, cooldownUntil: 0, ok: 0, fail: 0 },
  'ipwhois': { fails: 0, cooldownUntil: 0, ok: 0, fail: 0 },
  'ipapico': { fails: 0, cooldownUntil: 0, ok: 0, fail: 0 },
};
const PROVIDER_COOLDOWN = 10 * 60 * 1000;

function provAvailable(name) {
  return providerHealth[name].cooldownUntil < Date.now();
}
function provOk(name) {
  const h = providerHealth[name];
  h.fails = 0; h.ok++;
}
function provFail(name) {
  const h = providerHealth[name];
  h.fails++; h.fail++;
  if (h.fails >= 3) { h.cooldownUntil = Date.now() + PROVIDER_COOLDOWN; h.fails = 0; }
}

/* ---- ip-api.com 批量查询（主源） ---- */
async function batchResolve(ips) {
  if (!ips.length) return [];
  const url = 'http://ip-api.com/batch?fields=status,query,continent,country,countryCode,regionName,city,lat,lon,timezone,isp&lang=zh';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(ips),
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { provFail('ip-api'); return null; }
    const data = await res.json();
    if (!Array.isArray(data)) { provFail('ip-api'); return null; }
    provOk('ip-api');
    return data.filter(r => r.status === 'success');
  } catch (_) {
    provFail('ip-api');
    return null;
  }
}

/* ---- 备用源单查实现（统一映射为 ip-api 兼容结构） ---- */
async function singleFetch(url, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'ikwyd-geo/2.0' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}

const SINGLE_PROVIDERS = [
  {
    name: 'freeipapi',
    url: (ip) => `https://freeipapi.com/api/json/${ip}`,
    map: (r) => (r && r.countryCode) ? {
      status: 'success', query: r.ipAddress, continent: r.continent || '',
      country: r.countryName || 'Unknown', countryCode: r.countryCode,
      regionName: r.regionName || '', city: r.cityName || '',
      lat: r.latitude || 0, lon: r.longitude || 0,
      timezone: (r.timeZones && r.timeZones[0]) || '', isp: '',
    } : null,
  },
  {
    name: 'ipwhois',
    url: (ip) => `https://ipwho.is/${ip}?lang=zh-CN`,
    map: (r) => (r && r.success !== false && r.country_code) ? {
      status: 'success', query: r.ip, continent: r.continent || '',
      country: r.country || 'Unknown', countryCode: r.country_code,
      regionName: r.region || '', city: r.city || '',
      lat: r.latitude || 0, lon: r.longitude || 0,
      timezone: (r.timezone && r.timezone.id) || '',
      isp: (r.connection && r.connection.isp) || '',
    } : null,
  },
  {
    name: 'ipapico',
    url: (ip) => `https://ipapi.co/${ip}/json/`,
    map: (r) => (r && r.country_code && !r.error) ? {
      status: 'success', query: r.ip, continent: r.continent_code || '',
      country: r.country_name || 'Unknown', countryCode: r.country_code,
      regionName: r.region || '', city: r.city || '',
      lat: r.latitude || 0, lon: r.longitude || 0,
      timezone: r.timezone || '', isp: r.org || '',
    } : null,
  },
];

/* 备用源轮换单查一批 IP（并发 5），返回映射成功的结果数组 */
async function fallbackResolve(ips) {
  const out = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < ips.length) {
      const ip = ips[cursor++];
      let resolved = null;
      for (const p of SINGLE_PROVIDERS) {
        if (!provAvailable(p.name)) continue;
        const raw = await singleFetch(p.url(ip));
        if (raw == null) { provFail(p.name); continue; }
        const mapped = p.map(raw);
        if (mapped) { provOk(p.name); resolved = mapped; break; }
        else provFail(p.name);
      }
      if (resolved) out.push(resolved);
    }
  };
  const workers = [];
  for (let i = 0; i < 5; i++) workers.push(worker());
  await Promise.allSettled(workers);
  return out;
}

/* 将 API 返回映射为内部格式。
   ip-api.com 偶尔对部分 IP 返回 regionName=null（只有 city），
   此时用 city 补充 region，保证省市字段不为空。 */
function mapApiResult(r) {
  const region = r.regionName || r.city || '';
  return {
    ip: r.query,
    cc: r.countryCode || null,
    country: r.country || 'Unknown',
    region,
    city: r.city || 'Unknown',
    lat: r.lat || 0,
    lon: r.lon || 0,
    timezone: r.timezone || '',
    continent: r.continent || '',
    isp: r.isp || '',
    resolved_at: Date.now(),
  };
}

/* 将结果写入 DB + 内存缓存 */
function storeResult(g) {
  if (!g || !g.ip) return;
  try {
    stmts.ins.run(g.ip, g.cc, g.country, g.region, g.city, g.lat, g.lon, g.timezone, g.continent, g.isp, g.resolved_at);
  } catch (_) {}
  memCache.set(g.ip, { ...g, _pending: false });
}

/* 执行一次批量查询（从 pendingQueue 取最多 BATCH_SIZE 个）。
   主源批量失败/不可用时自动切换到备用源轮换，保证解析服务整体稳定。 */
async function flushPending() {
  if (flushing || pendingQueue.size === 0) return;
  flushing = true;
  const batch = [...pendingQueue].slice(0, BATCH_SIZE);
  for (const ip of batch) pendingQueue.delete(ip);
  let results = null;
  if (provAvailable('ip-api')) {
    results = await batchResolve(batch);
  }
  if (results == null) {
    // 主源失败 → 备用源聚合单查
    results = await fallbackResolve(batch);
  }
  for (const r of results) storeResult(mapApiResult(r));
  flushing = false;
  // 如果队列还有积压，继续处理
  if (pendingQueue.size > 0) setTimeout(() => flushPending(), 500);
}

/* 定期刷新：对超 30 天未更新的 IP 重新查询。
   本地 MMDB 可解的 IP 直接刷新时间戳，不占在线配额。 */
async function refresh() {
  const d = db.get();
  const cutoff = Date.now() - REFRESH_INTERVAL;
  const rows = d.prepare('SELECT ip FROM ip_geo WHERE resolved_at < ? OR resolved_at IS NULL LIMIT 100').all(cutoff);
  const upd = d.prepare('UPDATE ip_geo SET resolved_at=? WHERE ip=?');
  for (const r of rows) {
    const local = localLookup(r.ip);
    if (local) {
      // 本地命中：刷新 DB 时间戳 + 内存缓存，不加入在线队列
      try { upd.run(Date.now(), r.ip); } catch (_) {}
      memCache.set(r.ip, { ...local, _pending: false });
    } else {
      pendingQueue.add(r.ip);
    }
  }
  if (pendingQueue.size > 0) flushPending();
}

/* ---- 同步查询入口（保持与旧版接口兼容） ---- */
function lookup(ip) {
  if (!ip) return null;
  // 私有 IP 直接返回
  if (isPrivateIp(ip)) return { ip, ...PRIVATE_GEO, _pending: false };

  const hit = memCache.get(ip);
  if (hit) return hit;
  ensureStmts();

  // 查 DB
  const row = stmts.get.get(ip);
  if (row && row.cc) {
    const out = { ...row, _pending: false };
    memCache.set(ip, out);
    return out;
  }

  // 本地离线 MMDB 查询（命中即写回 DB + 内存，不走在线队列）
  const local = localLookup(ip);
  if (local) {
    storeResult(local);
    return memCache.get(ip);
  }

  // 本地未命中（或本地库未加载）：加入待查队列，返回临时占位
  if (pendingQueue.size < 10000) pendingQueue.add(ip);
  const placeholder = { ip, ...demoResolve(ip) };
  memCache.set(ip, placeholder);
  return placeholder;
}

function populationOf(cc) { return COUNTRY_POPULATION_MLN[cc] || 100; }
function penetrationOf(cc) { return INTERNET_PENETRATION[cc] || 0.8; }
function allCountries() { return ALL_COUNTRIES; }
function countryName(cc) { const c = ALL_COUNTRIES.find(x => x.cc === cc); return c ? c.country : cc; }

/* 批量查询完成后，补写之前因占位而跳过的 country_daily。
   取 obs_log 中有 IP 但 ip_geo 无 cc（或刚解析完）的记录，补写统计。 */
function backfillCountryDaily() {
  const d = db.get();
  // 取最近 24h 内、ip_geo 有 cc 但 country_daily 未记录的 (cc, day) 组合
  const rows = d.prepare(`
    SELECT DISTINCT g.cc, strftime('%Y-%m-%d', o.ts/1000, 'unixepoch') AS day
    FROM obs_log o
    JOIN ip_geo g ON g.ip = o.ip
    WHERE g.cc IS NOT NULL
      AND o.ts > ?
      AND NOT EXISTS (
        SELECT 1 FROM country_daily cd WHERE cd.cc = g.cc AND cd.day = strftime('%Y-%m-%d', o.ts/1000, 'unixepoch')
      )
    LIMIT 200
  `).all(Date.now() - 86400000);
  if (!rows.length) return 0;
  const stmt = d.prepare('INSERT OR IGNORE INTO country_daily(cc, day, peers) VALUES(?, ?, 1)');
  let n = 0;
  for (const r of rows) { try { stmt.run(r.cc, r.day); n++; } catch (_) {} }
  return n;
}

module.exports = {
  lookup, populationOf, penetrationOf, allCountries, countryName,
  flushPending, refresh, isPrivateIp, backfillCountryDaily,
  /* 暴露内部状态用于监控 */
  _stats: () => ({
    pending: pendingQueue.size, cached: memCache.size, flushing,
    local: { loaded: !!localReader, hits: localHits, misses: localMisses },
    providers: Object.fromEntries(Object.entries(providerHealth).map(([k, h]) => [k, {
      available: h.cooldownUntil < Date.now(), ok: h.ok, fail: h.fail,
      cooldownSec: Math.max(0, Math.round((h.cooldownUntil - Date.now()) / 1000)),
    }])),
  }),
};
