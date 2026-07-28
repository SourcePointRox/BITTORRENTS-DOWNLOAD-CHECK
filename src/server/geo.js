'use strict';
/* GeoIP 模块：可插拔设计。
   - 沙箱内置一个确定性的演示解析器（基于 IP 哈希映射到演示地理库），保证 UI/统计链路完整可测；
   - 生产环境替换 lookup() 为 MaxMind GeoLite2 查询即可（接口保持不变）。 */
const db = require('./db');
const { ipToInt } = require('../common/util');

/* 演示地理库：与官网展示粒度一致（洲/国/市/ISP + 经纬度） */
const GEO_POOL = [
  { cc: 'US', continent: 'North America', country: 'United States', city: 'San Francisco', lat: 37.7749, lon: -122.4194, isp: 'Comcast Cable' },
  { cc: 'US', continent: 'North America', country: 'United States', city: 'New York', lat: 40.7128, lon: -74.0060, isp: 'Verizon Fios' },
  { cc: 'CN', continent: 'Asia', country: 'China', city: 'Beijing', lat: 39.9042, lon: 116.4074, isp: 'China Unicom' },
  { cc: 'CN', continent: 'Asia', country: 'China', city: 'Shanghai', lat: 31.2304, lon: 121.4737, isp: 'China Telecom' },
  { cc: 'CN', continent: 'Asia', country: 'China', city: 'Shenzhen', lat: 22.5431, lon: 114.0579, isp: 'China Mobile' },
  { cc: 'RU', continent: 'Europe', country: 'Russia', city: 'Moscow', lat: 55.7558, lon: 37.6173, isp: 'Rostelecom' },
  { cc: 'UA', continent: 'Europe', country: 'Ukraine', city: 'Kyiv', lat: 50.4501, lon: 30.5234, isp: 'Kyivstar' },
  { cc: 'IN', continent: 'Asia', country: 'India', city: 'Mumbai', lat: 19.0760, lon: 72.8777, isp: 'Jio' },
  { cc: 'BR', continent: 'South America', country: 'Brazil', city: 'Sao Paulo', lat: -23.5505, lon: -46.6333, isp: 'Vivo' },
  { cc: 'DE', continent: 'Europe', country: 'Germany', city: 'Berlin', lat: 52.5200, lon: 13.4050, isp: 'Deutsche Telekom' },
  { cc: 'FR', continent: 'Europe', country: 'France', city: 'Paris', lat: 48.8566, lon: 2.3522, isp: 'Orange' },
  { cc: 'GB', continent: 'Europe', country: 'United Kingdom', city: 'London', lat: 51.5074, lon: -0.1278, isp: 'BT Group' },
  { cc: 'JP', continent: 'Asia', country: 'Japan', city: 'Tokyo', lat: 35.6762, lon: 139.6503, isp: 'NTT' },
  { cc: 'KR', continent: 'Asia', country: 'South Korea', city: 'Seoul', lat: 37.5665, lon: 126.9780, isp: 'KT Corporation' },
  { cc: 'CA', continent: 'North America', country: 'Canada', city: 'Toronto', lat: 43.6532, lon: -79.3832, isp: 'Rogers' },
  { cc: 'AU', continent: 'Oceania', country: 'Australia', city: 'Sydney', lat: -33.8688, lon: 151.2093, isp: 'Telstra' },
  { cc: 'NL', continent: 'Europe', country: 'Netherlands', city: 'Amsterdam', lat: 52.3676, lon: 4.9041, isp: 'KPN' },
  { cc: 'ES', continent: 'Europe', country: 'Spain', city: 'Madrid', lat: 40.4168, lon: -3.7038, isp: 'Movistar' },
  { cc: 'IT', continent: 'Europe', country: 'Italy', city: 'Rome', lat: 41.9028, lon: 12.4964, isp: 'TIM' },
  { cc: 'PL', continent: 'Europe', country: 'Poland', city: 'Warsaw', lat: 52.2297, lon: 21.0122, isp: 'Orange Polska' },
  { cc: 'TR', continent: 'Asia', country: 'Turkey', city: 'Istanbul', lat: 41.0082, lon: 28.9784, isp: 'Turk Telekom' },
];

const COUNTRY_POPULATION_MLN = {
  US: 334, CN: 1412, RU: 144, UA: 38, IN: 1417, BR: 216, DE: 84, FR: 68,
  GB: 67, JP: 125, KR: 52, CA: 39, AU: 26, NL: 18, ES: 48, IT: 59, PL: 38, TR: 85,
};
const INTERNET_PENETRATION = {
  US: 0.92, CN: 0.76, RU: 0.88, UA: 0.79, IN: 0.46, BR: 0.81, DE: 0.93, FR: 0.93,
  GB: 0.95, JP: 0.83, KR: 0.97, CA: 0.94, AU: 0.90, NL: 0.97, ES: 0.93, IT: 0.85, PL: 0.87, TR: 0.83,
};

function demoResolve(ip) {
  const n = ipToInt(ip);
  return GEO_POOL[n % GEO_POOL.length];
}

/* 查询（内存 + DB 双层缓存，语句预编译）。返回 {cc,country,city,lat,lon,isp,continent} */
const memCache = new Map();
let stmts = null;

function ensureStmts() {
  if (stmts) return;
  const d = db.get();
  stmts = {
    get: d.prepare('SELECT * FROM ip_geo WHERE ip = ?'),
    ins: d.prepare('INSERT OR IGNORE INTO ip_geo(ip,cc,country,city,lat,lon,isp) VALUES(?,?,?,?,?,?,?)'),
  };
}

function lookup(ip) {
  const hit = memCache.get(ip);
  if (hit) return hit;
  ensureStmts();
  // demoResolve 对同一 IP 确定不变：直接 INSERT OR IGNORE 持久化，无需先 SELECT
  const g = demoResolve(ip);
  stmts.ins.run(ip, g.cc, g.country, g.city, g.lat, g.lon, g.isp);
  const out = { ip, ...g };
  memCache.set(ip, out);
  return out;
}

function populationOf(cc) { return COUNTRY_POPULATION_MLN[cc] || 100; }
function penetrationOf(cc) { return INTERNET_PENETRATION[cc] || 0.8; }
function allCountries() { return GEO_POOL.map(g => ({ cc: g.cc, country: g.country })); }
function countryName(cc) { const g = GEO_POOL.find(x => x.cc === cc); return g ? g.country : cc; }

module.exports = { lookup, populationOf, penetrationOf, allCountries, countryName };
