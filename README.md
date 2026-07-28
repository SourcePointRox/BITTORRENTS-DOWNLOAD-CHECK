# BITTORRENTS-DOWNLOAD-CHECK

BitTorrent 网络元数据抓取与采集监控系统 —— 全量接入全球 DHT / PEX / Tracker / P2P 网络，实时监控与采集种子元数据。

零第三方依赖（Node.js ≥ 22.5 标准库 + 内置 `node:sqlite`），可离线运行。

## 功能概览

- **全网络采集**：DHT (BEP-5/51) + PEX (BEP-11) + Tracker (HTTP/UDP, BEP-3/15) + BitTorrent P2P (BEP-9/10)
- **元数据解析**：BT 握手 → ut_metadata 拉取 info 字典 → SHA-1 校验 → 自动分类
- **Web 站点**：完整复刻 iknowwhatyoudownload.com 全站功能，增强展示 infohash / magnet / first-seen
- **REST API**：对齐官方 Peer/Torrent/Content API，免 Key 沙箱模式
- **监控 WebUI**：独立端口运行，实时展示采集速率、DHT 路由表、来源分布、系统资源、健康度
- **自动端口检测**：默认端口被占用时自动切换到可用端口

## 快速开始

### 环境要求

- **Node.js ≥ 22.5**（需要内置 `node:sqlite` 模块）
- 公网 UDP/TCP 出站能力（真实采集模式需要；模拟模式无需联网）

### 一键启动

```bash
# 模拟采集模式（默认，无需公网）
node scripts/start.js

# 真实 DHT + PEX + Tracker 全网络采集
node scripts/start.js --live

# 指定端口
node scripts/start.js --port 9000 --monitor-port 9090

# 仅启动站点（不启动采集器）
node scripts/start.js --no-collector
```

Windows 下也可双击 `start.bat`。

启动后控制台会输出各服务地址：

```
[start] ========================================
[start] 主站点:        http://localhost:8081
[start] 监控WebUI:     http://localhost:8090
[start] 采集模式:      live
[start] ========================================
```

### 访问地址

| 服务 | URL | 说明 |
|---|---|---|
| 主站点 | `http://localhost:<site-port>/` | 首页即"你的 IP"下载记录页 |
| 内嵌管理 | `http://localhost:<site-port>/admin/` | 采集控制 + 实时事件流 |
| **独立监控 WebUI** | `http://localhost:<monitor-port>/` | 专门监控后端运行状态 |
| REST API | `http://localhost:<site-port>/api/` | Peer/Torrent/Content API |

> 端口自动检测：如果默认端口 8080/8090 被占用，系统会自动切换到可用端口。

## 部署流程

### 1. 克隆仓库

```bash
git clone https://github.com/SourcePointRox/BITTORRENTS-DOWNLOAD-CHECK.git
cd BITTORRENTS-DOWNLOAD-CHECK
```

### 2. 启动服务

```bash
# 真实采集模式（全量接入 DHT/PEX/Tracker/P2P 网络）
node scripts/start.js --live
```

首次启动会自动生成演示数据（约 30 天模拟采集量），随后启动：
- 主站点（前端 + 后端 API）
- 独立监控 WebUI（独立端口）
- 采集器（DHT + PEX + Tracker）

### 3. 验证运行

打开监控 WebUI（控制台输出的地址），确认：
- **采集模式** 显示 `LIVE`
- **DHT 节点** 数量持续增长（正常 1-2 分钟内可达 1000+）
- **来源分布** 出现 `dht_active` / `dht_sample` / `tracker` 来源
- **健康度** 显示绿色（≥ 70）

### 4. 生产部署建议

```bash
# 使用 PM2 等进程管理器
pm2 start scripts/start.js --name bittorrents-monitor -- --live

# 或使用 systemd（Linux）
# 创建 /etc/systemd/system/bittorrents.service
```

生产环境注意事项：
- **UDP 6881 出站**：DHT 需要 UDP 出站，确保防火墙放行
- **公网 IP**：真实采集需要公网 IP 或 NAT 穿透
- **带宽**：DHT 采集约产生 10-50 KB/s 流量
- **磁盘**：SQLite 数据库约 1-10 MB/万种子
- **GeoIP**：替换 `src/server/geo.js` 中的 `demoResolve` 为 MaxMind GeoLite2 查询

## 采集网络详解

### DHT 爬虫（BEP-5 / BEP-51）

`src/collector/dht.js` — Mainline DHT 爬虫

- **主动模式**：向路由表节点发 `get_peers`，从响应 `values` 提取 (ip, port, infohash)
  - 50% 概率用已知 infohash 查询（更可能获得 peer 列表）
  - 50% 概率用随机 infohash 查询（发现新种子）
- **被动模式**：应答他人的 `get_peers` / `announce_peer`，从 `announce_peer` 捕获真实做种
- **BEP-51**：`sample_infohashes` 批量发现 infohash，发现后立即对其 `get_peers` 找 peer
- **路由表**：最多 2000 节点，定期更换节点 ID 扩大覆盖
- **Bootstrap**：20 个全球 DHT 引导节点，并行入网

### PEX 采集器（BEP-11）

`src/collector/pex.js` — Peer Exchange

- 在已有 BT TCP 连接上发送/接收 `ut_pex` 扩展消息
- 从 PEX 消息中提取新增 peer（IPv4 + IPv6）
- 支持 `added` / `added6` 紧凑格式解析
- 每 45 秒对活跃种子做 PEX 扩散

### Tracker 抓取器（BEP-3 / BEP-15）

`src/collector/tracker.js` — HTTP + UDP Tracker

- **HTTP Tracker**（BEP-3）：紧凑 peer 格式解析
- **UDP Tracker**（BEP-15）：连接握手 → announce → peer 列表
- **26 个公共 Tracker**：覆盖全球各地区（HTTP + UDP）
- 分批并发请求，避免瞬时连接爆炸

### 元数据抓取（BEP-9 / BEP-10）

`src/collector/metadata.js` — BitTorrent 元数据

- TCP 连接 peer → BT 握手 → `ut_metadata` 扩展分片拉取
- bencode 解析 name / files / length
- SHA-1 校验 infohash 完整性
- 规则引擎分类（Movies / TV / Anime / Music / Games / Software / Books / XXX / Unsorted）

## 监控 WebUI

独立运行在单独端口的监控面板，实时展示：

| 模块 | 内容 |
|---|---|
| 核心指标 | 采集模式 / 种子总数 / IP 节点 / 采集速率 / DHT 节点 / 健康度 |
| 采集器状态 | DHT / Tracker / PEX 各采集器运行状态与发现 peer 数 |
| 趋势图表 | 近 60 分钟每分钟采集事件数（折线图） |
| 来源分布 | DHT / Tracker / PEX / 模拟器（环形进度条） |
| 实时事件流 | 最近 30 条观测（时间 / IP / infohash / 资源名 / 来源徽章） |
| DHT 路由表 | 节点 ID / 地址 / 最后活跃时间 |
| 系统资源 | 内存 RSS / 堆使用 / 运行时长 / 平台信息 |
| 元数据处理 | 已解析 / 失败 / 队列长度 |

### 健康度评估

| 分数 | 状态 | 含义 |
|---|---|---|
| 70-100 | 健康（绿色） | 采集正常，DHT 节点充足 |
| 30-69 | 警告（黄色） | 节点不足或速率偏低 |
| 0-29 | 异常（红色） | 采集器停止或无数据 |

### JSON 接口

| 端点 | 说明 |
|---|---|
| `GET /api/stats` | 完整采集统计 + 系统指标 |
| `GET /api/nodes` | DHT 路由表节点列表 |
| `GET /api/health` | 健康度 + 系统信息 |
| `GET /api/trend` | 近 6 小时采集趋势 |

## 站点功能

完整复刻 [iknowwhatyoudownload.com](https://iknowwhatyoudownload.com) 全站功能：

| 页面 | 路由 | 说明 |
|---|---|---|
| IP 下载记录 | `/en/peer/?ip=` | 地理标签 + 下载表格（含 infohash / magnet / first-seen 增强列） |
| Track Downloads | `/en/link/` | 短链追踪 → 访问记录 → 轮询 |
| 日统计 | `/en/stat/daily` | 三项比率 + 分类饼图 + Top 12 + 海报墙 |
| 年度统计 | `/en/stat/annual` | 月度分类汇总 + 柱状图 |
| 种子详情 | `/en/torrent/{hash}/{slug}` | 磁力链接框 + 30 天 peer 曲线 + 文件列表 |
| API 文档 | `/en/api/` | 合作说明 + Demo Key |
| About Us | `/en/contacts/` | 联系信息 |

### REST API

| 端点 | 说明 |
|---|---|
| `GET /api/history/peer?ip=&days=&contents=` | Peer 下载历史（含 magnet + firstSeen） |
| `GET /api/history/peers?cidr=` | CIDR 内已知 IP |
| `GET /api/history/exist?ip=` | IP 是否存在 |
| `GET /api/torrent/info/{infohash}` | 种子信息（含 magnet + files） |
| `GET /api/torrent/peers/{infohash}?day=` | 按日 peer 统计 |
| `GET /api/content/summary?day=` | 内容汇总报告 |
| `GET /api/content/downloads?day=` | 日下载报告 |
| `GET /api/stat/daily?date=&cc=` | 日统计页数据 |

## 测试

```bash
node tests/unit.js      # 采集层组件：bencode/DHT/元数据/分类器（30 项）
node tests/e2e.js       # 全链路：模拟采集→入库→API→页面→短链闭环（59 项）
node tests/stress.js    # 压力与边界：5.5 万事件灌入、吞吐/延迟、XSS（18 项）
node tests/admin.js     # 后台 WEBUI：仪表盘/统计 API/采集控制（18 项）
# 或 npm test（依次全部运行）
```

当前状态：**125/125 全部通过**；灌入吞吐约 9500 事件/s。

## 目录结构

```
├── src/
│   ├── collector/
│   │   ├── dht.js          # DHT 爬虫（BEP-5/51，被动+主动+sample_infohashes）
│   │   ├── pex.js          # PEX 采集器（BEP-11 ut_pex，IPv4+IPv6）
│   │   ├── tracker.js       # Tracker 抓取器（HTTP BEP-3 + UDP BEP-15，26 个公共 tracker）
│   │   ├── metadata.js     # 元数据抓取（BEP-9/10 ut_metadata，SHA-1 校验）
│   │   ├── pipeline.js     # 统一采集管道（去重/聚合/入库/日统计）
│   │   ├── service.js      # 采集服务调度（sim/live 模式切换、PEX/Tracker 定时器）
│   │   ├── simulator.js    # 沙箱模拟数据源
│   │   └── run.js          # 独立采集入口（--dht --tracker --pex）
│   ├── common/
│   │   ├── bencode.js      # Bencode 编解码（BEP-3）
│   │   ├── util.js          # 通用工具（哈希/magnet/base32/格式化）
│   │   └── ports.js         # 端口自动检测工具
│   └── server/
│       ├── index.js        # HTTP 服务主入口
│       ├── api.js          # REST API 层
│       ├── pages.js        # SSR 页面渲染
│       ├── admin.js        # 内嵌管理面板
│       ├── monitor.js      # 独立监控 WebUI（专门监控后端运行状态）
│       ├── db.js            # 存储层（node:sqlite, WAL, busy_timeout）
│       └── geo.js           # GeoIP 模块（可插拔，预留 MaxMind 接口）
├── public/assets/          # 静态资源（Bootstrap3/jQuery/Chart.js/FontAwesome 本地化）
├── scripts/
│   ├── start.js            # 一键启动（端口检测 → 站点 + 监控 + 采集）
│   ├── seed.js             # 演示数据生成
│   └── check-stats.js      # 采集状态检查工具
├── tests/                  # e2e / unit / stress / admin 测试
├── docs/ARCHITECTURE.md    # 架构设计文档
└── package.json
```

## 采集性能参考

在公网环境下（UDP 6881 出站），典型采集表现：

| 指标 | 1 分钟 | 5 分钟 | 10 分钟 |
|---|---|---|---|
| DHT 路由表节点 | 500-1000 | 1500-2000 | 2000 (满) |
| 发现 infohash | 100-500 | 1000-5000 | 5000-20000 |
| 采集速率 | 50-100/min | 100-200/min | 150-300/min |
| Tracker peers | 10-50 | 50-200 | 100-500 |
| 元数据解析 | 0-10 | 5-50 | 10-100 |

> 性能取决于网络环境、DHT 节点质量、tracker 可用性等因素。

## 技术要点

- **零依赖**：仅使用 Node.js 标准库 + `node:sqlite`，无需 `npm install`
- **自研 bencode**：完整 Bencode 编解码，支持 Buffer/字典序/原始字节区间提取
- **WAL 模式**：SQLite WAL + busy_timeout，支持高并发写入
- **日粒度去重**：同一 (ip, infohash, day) 仅计一次，减少写放大
- **端口自动检测**：IPv4/IPv6 双栈检测，被占用时自动切换
- **健康度评估**：综合 DHT 节点数、采集速率、元数据成功率评分

## 许可与声明

本项目仅用于技术研究与沙箱测试环境。采集的数据仅为元数据级别（infohash / 种子名 / 文件列表），不涉及任何内容数据的传输或存储。

## 技术栈

- Node.js ≥ 22.5（标准库 + `node:sqlite`）
- BitTorrent 协议：BEP-3 / BEP-5 / BEP-9 / BEP-10 / BEP-11 / BEP-15 / BEP-23 / BEP-51
- 前端：Bootstrap 3 + jQuery + Chart.js（全部本地化）
- 存储：SQLite (WAL 模式)
