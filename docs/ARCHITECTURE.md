# IKWYD-Clone 架构设计与落地计划

> 目标：完整复刻 iknowwhatyoudownload.com 的全站功能与 UI，并在此基础上**增强**——
> 直接展示每个资源的 **信息哈希值 (infohash)**、**磁力链接 (magnet URI)** 与 **最早有记录的发布时间 (first seen)**。
> 本项目为沙箱测试用途，全部组件零外部依赖（Node.js 标准库 + node:sqlite），可离线运行。

---

## 1. 官网解析结论（逆向自页面存档与官方 API 文档）

### 1.1 页面与路由

| 路由 | 功能 |
|---|---|
| `/` | 跳转到访客自身 IP 的 peer 页 |
| `/en/peer/?ip=` | IP 详情：地理标签（洲/国/市/ISP）、相似 IP（同 /24）、种子表格（First seen UTC / Last seen UTC / Category / Title / Size） |
| `/en/link/` | Track Downloads：输入 URL 生成追踪短链，轮询 `/link/check/{token}` |
| `/en/stat/daily`、`/en/stat/{CC}/daily` | 日统计：三项比率指标 + 分类饼图 + Top 12 选项卡（Torrents/Movies/XXX/Games/Software/Music）+ Top 12 电影/剧集海报墙 + 国家/日期选择 |
| `/en/stat/annual` | 年度统计 |
| `/en/torrent/{id}/{slug}` | 种子详情页 |
| `/en/api/` | 合作说明 + Demo Key 申请 |
| `/en/contacts/` | About Us |

### 1.2 数据模型（来自官方 Peer/Torrent/Content API 文档）

- **Peer History**：`{ip, isp, hasPorno, geoData{country,city,lat,lon}, contents:[{category, imdbId, name, startDate, endDate, torrent:{infohash,size,name}}]}`
- **Torrent**：`{infohash, torrentName, size, category, title, imdbId, dateAdded, alive}`
- **Content/日报告**：`{day, totalPeers, contents:[{imdb, name, totalPeers, countries:[{code,peers}]}]}`
- **分类体系**：Movies, Anime, TV, Music, Books, PC, Mobile, XXX, Unsorted
- **采集方式**：DHT + PEX 被动监听（未确认事实）；TCP 握手主动验证（确认事实）

### 1.3 UI 体系

Bootstrap 3.3.5 + FontAwesome 4.5 + jQuery 1.11.3 + Chart.js 2.6；自定义 v2.css
（`.header-torrents` 灰色大写表头、`.label-primary` 地理标签、`.padding-block` 等）。全部静态资源已本地化到 `public/assets/`。

---

## 2. 系统架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        数据采集层 (collector)                      │
│  ┌────────────┐  ┌──────────────┐  ┌────────────┐  ┌───────────┐ │
│  │ DHT Spider │  │ Tracker      │  │ Metadata   │  │ Simulator │ │
│  │ (BEP5/51)  │  │ Scraper(HTTP)│  │ Fetcher    │  │ (沙箱数据源)│ │
│  │ 被动+主动   │  │ announce解析 │  │ (BEP9/10)  │  │           │ │
│  └─────┬──────┘  └──────┬───────┘  └─────┬──────┘  └─────┬─────┘ │
│        └────────────────┴───────┬────────┴───────────────┘       │
│                          Pipeline (去重/聚合/入库)                 │
└─────────────────────────────────┬────────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     存储层 (node:sqlite, WAL)                      │
│  torrents / peers / observations / obs_log / daily_stats /        │
│  torrent_daily / country_daily / ip_geo / track_links             │
└─────────────────────────────────┬────────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     服务层 (server, 零依赖 HTTP)                    │
│  REST API(对齐官方+增强)  │  SSR 页面渲染  │  静态资源  │  GeoIP     │
└─────────────────────────────────┬────────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     前端 (public/, Bootstrap3 + Chart.js)          │
│  peer / link / stat·daily·annual / torrent / api / contacts       │
│  增强列: INFOHASH │ MAGNET(一键复制) │ FIRST SEEN(最早记录)         │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 采集层

- **`src/collector/dht.js`** — Mainline DHT 爬虫：KRPC over UDP（自研 bencode 编解码）。
  - 主动模式：向路由表节点发 `get_peers`，从响应 `values` 提取 (ip, port, infohash)；支持 BEP-51 `sample_infohashes` 批量发现。
  - 被动模式：应答他人的 `get_peers`/`announce_peer`，从 `announce_peer` 直接获得真实做种 (ip, port, infohash)。
- **`src/collector/metadata.js`** — 元数据抓取：TCP 连接 peer → BT 握手 → `ut_metadata` 扩展（BEP-10/9）分片拉取 info 字典 → 解析 name/files/length → SHA-1 校验 infohash。
- **`src/collector/tracker.js`** — 公开 HTTP tracker `announce` 抓取 peer 列表（仅声明已拥有，不传输内容数据）。
- **`src/collector/pipeline.js`** — 统一观测事件流：`(ip, port, infohash, ts, source)` → 写入 obs_log → 聚合 observations(first/last seen) → 触发元数据补全 → 滚动日统计。
- **`src/collector/simulator.js`** — 沙箱模拟源：生成拟真种子库（真实命名风格/分类/大小分布）与虚拟 IP 观测流，与真实采集器走**同一条 Pipeline**，保证全链路测试的真实性。

### 2.2 存储层

```sql
torrents(infohash PK, name, size, category, title, imdb_id,
         first_seen, last_seen, alive, files_json, metadata_ok)
peers(ip PK, first_seen, last_seen)
observations(ip, infohash, first_seen, last_seen, hits, PK(ip,infohash))
obs_log(id PK, ip, port, infohash, ts, source)
daily_stats(day, category, downloads, PK(day,category))
torrent_daily(infohash, day, peers, PK(infohash,day))
country_daily(cc, day, peers, PK(cc,day))
ip_geo(ip PK, cc, country, city, lat, lon, isp)
track_links(token PK, target_url, created_at, visited, visitor_ip)
```

### 2.3 API 层（对齐官方字段 + 增强字段）

| 端点 | 说明 |
|---|---|
| `GET /api/history/peer?ip=&days=&contents=` | 官方 Peer API 结构；`torrent` 始终含 `infohash` + **`magnet`** + **`firstSeen`** |
| `GET /api/history/peers?cidr=` | CIDR 内已知 IP 列表 |
| `GET /api/history/exist?ip=` | IP 是否存在于库 |
| `GET /api/torrent/info/{infohash}` | 种子信息（含 magnet、first_seen） |
| `GET /api/torrent/peers/{infohash}?day=` | 按日/国家的 peer 统计 |
| `GET /api/content/summary?day=` | 内容汇总报告 |
| `GET /api/content/downloads?day=` | 日下载报告 |
| `GET /api/stat/daily?date=&cc=` | 日统计页数据 |

沙箱版本**免 API Key**；保留官方错误结构 `{error, message}`。

### 2.4 前端增强点（相对官网）

1. peer 表格新增三列：**Infohash**（等宽字体，点击复制）、**Magnet**（复制按钮/二维码图标）、**First seen** 精确到秒（官网仅到分钟且不展示哈希）。
2. 种子详情页顶部直接展示完整磁力链接框 + 一键复制。
3. 所有 API 响应默认携带 `magnet` 与 `firstSeen`。

---

## 3. 落地计划（Roadmap）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 官网解析、静态资源本地化、架构文档 | ✅ |
| P1 | 存储层 + Pipeline + 模拟数据源 | ✅ |
| P2 | REST API 全套 | ✅ |
| P3 | 全站 SSR 页面 + 前端交互（含增强列） | ✅ |
| P4 | Track Downloads 短链追踪闭环 | ✅ |
| P5 | 真实 DHT/Tracker/Metadata 采集器（联网环境启用） | ✅ 代码实现 |
| P6 | 全链路 E2E 测试（模拟源→入库→API→页面断言）+ 迭代优化 | ✅ |
| P7 | 生产化：Docker、PostgreSQL 适配层、分布式爬虫调度、GeoLite2 接入 | 计划 |

### 生产部署注意
- 真实采集需 UDP 6881 出站 + 充足带宽；DHT 节点 ID 随机化、限速、IP 轮换。
- GeoIP 接 MaxMind GeoLite2（`src/server/geo.js` 已预留接口）。
- 分类器：规则引擎（命名特征正则）→ 可替换为 ML 分类；IMDB 映射走 OMDb/TMDB。

---

## 4. 运行方式

```bash
# 生成沙箱演示数据（模拟 30 天采集）
node scripts/seed.js

# 启动站点（默认 :8080）
node src/server/index.js

# 全链路测试
node tests/e2e.js

# 真实采集（需公网 UDP，沙箱默认关闭）
node src/collector/run.js --dht --tracker
```
