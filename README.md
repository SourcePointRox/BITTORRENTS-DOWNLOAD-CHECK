# BITTORRENTS-DOWNLOAD-CHECK

BitTorrent 网络元数据抓取与采集监控系统 —— 全量接入全球 DHT / PEX / Tracker / P2P 网络，实时监控与采集种子元数据，**全链路 IPv6 支持 + BitTorrent v2 (BEP-52) + 标准 Kademlia K-bucket 路由 + 动态 Tracker 健康检查 + 独立冷存储进程 + 协议加密 (MSE/PE) + uTP (BEP-29) 检测 + TF-IDF + Softmax 分类器**。

零第三方依赖（Node.js ≥ 22.5 标准库 + 内置 `node:sqlite`），可离线启动。

## 功能概览

- **全网络采集**：DHT (BEP-5/51/52) + PEX (BEP-11) + Tracker (HTTP/UDP, BEP-3/15/7) + BitTorrent P2P (BEP-9/10)
- **IPv6 全链路**：DHT 双栈 UDP 监听 + PEX `added6` 解析 + Tracker `peers6` (BEP-7) + 元数据 TCP v6 连接
- **BitTorrent v2 (BEP-52)**：SHA-256 infohash / 64-hex / multihash `btmh` 磁链 / file tree / piece layers / hybrid 混合种子
- **协议加密 (MSE/PE, BEP-8)**：纯 JS RC4 + 768-bit DH 密钥交换，连接要求加密的 peer，握手失败自动回退明文
- **uTP 检测 (BEP-29)**：通过 DHT `announce_peer` 的 `implied_port` 标志识别 uTP peer，统计监控面板可见
- **TF-IDF + Softmax 分类器**：替代纯正则规则，多项逻辑回归 + 混合策略（正则硬规则优先 + ML 处理其余），8 类自动分类
- **标准 Kademlia 路由**：160 桶 × K=8 LRU 路由表（替代平面 Map），节点 ID 周期性刷新扩大覆盖
- **动态 Tracker 管理**：自动从 ngosang/trackerslist 拉取远程列表（24h），5 分钟健康检查 + 3 次失败剔除
- **独立冷存储进程**：分离进程转存种子元数据到独立 SQLite（仅 name/size/magnet/v1/v2），主进程状态可查
- **真实 GeoIP**：基于 ip-api.com 批量查询（中文返回），内存+DB 双层缓存，30 天自动刷新，批量补写 country_daily
- **元数据解析**：BT 握手（置 BEP-52 v2 位）→ ut_metadata 拉取 info 字典 → SHA-1/SHA-256 校验 → 自动分类，并行 20 peer + 重试
- **长跑稳定**：TTL 化去重 Map（25h 过期）+ obs_log 30 天 TTL + 写队列批处理（500ms / 50 条）+ WAL 模式
- **Web 站点**：完整复刻 iknowwhatyoudownload.com 全站功能，daily statistics 默认 "Global" 视图
- **REST API**：对齐官方 Peer/Torrent/Content API，免 Key 沙箱模式
- **监控 WebUI**：独立端口，多来源堆叠图表（平滑过渡）、IPv6/v2/冷存储/Tracker 健康度面板、健康度评估、系统资源趋势
- **自动端口检测**：默认端口被占用时自动切换到可用端口

## 快速开始

### 环境要求

- **Node.js ≥ 22.5**（需要内置 `node:sqlite` 模块）
- 公网 UDP/TCP 出站能力（真实采集模式需要；模拟模式无需联网）
- 外网访问 ip-api.com（GeoIP 解析；不可用时降级为占位，不阻断服务）

### 一键启动

```bash
# 模拟采集模式（默认，无需公网，生成演示数据）
node scripts/start.js

# 真实 DHT + PEX + Tracker 全网络采集（含 IPv6 + BEP-52 hybrid）
node scripts/start.js --live

# 指定端口 + DHT 端口
node scripts/start.js --live --port 9000 --monitor-port 9090 --dht-port 6881

# 仅启动站点（不启动采集器）
node scripts/start.js --no-collector

# 最小化：仅站点，不启动监控和采集器
node scripts/start.js --no-collector --no-monitor

# 强制重新生成演示数据
node scripts/start.js --seed

# 查看帮助
node scripts/start.js --help
```

Windows 下也可双击 `start.bat`。

启动后控制台输出各服务地址：

```
[start] ========================================
[start] 主站点:        http://localhost:9080
[start] 监控WebUI:     http://localhost:9090
[start] 采集模式:      live
[start] ========================================
[dht] listening on udp4 UDP 6881
[dht] listening on udp6 UDP 6881        ← IPv6 双栈
[cold-storage] synced +1000 updated 0   ← 冷存储独立工作
[ikwyd] collector: live DHT+PEX+Tracker mode
[monitor] 监控 WebUI: http://localhost:9090/
```

### 独立启动冷存储进程（可选）

```bash
# 单独运行冷存储 worker（与主进程分离）
node scripts/cold-storage-worker.js
```

### 访问地址

| 服务 | URL | 说明 |
|---|---|---|
| 主站点 | `http://localhost:<site-port>/` | 首页即"你的 IP"下载记录页 |
| 内嵌管理 | `http://localhost:<site-port>/admin/` | 采集控制 + 实时事件流 |
| **独立监控 WebUI** | `http://localhost:<monitor-port>/` | 专门监控后端运行状态（含 IPv6/v2/冷存储/Tracker 面板） |
| 冷存储信息 | `http://localhost:<site-port>/en/cold-storage/` | 显示本地冷存储数据库路径 |
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
# 真实采集模式（全量接入 DHT/PEX/Tracker/P2P 网络 + IPv6 + BEP-52）
node scripts/start.js --live
```

首次启动会自动生成演示数据（约 30 天模拟采集量），随后启动：
- 主站点（前端 + 后端 API + 冷存储信息页）
- 独立监控 WebUI（独立端口，含 IPv6/v2/冷存储/Tracker 面板）
- 独立冷存储同步进程（嵌入主进程内 unref，或单独 worker）
- 采集器（DHT 双栈 + PEX + Tracker + GeoIP 批量查询 + TrackerManager）

### 3. 验证运行

打开监控 WebUI（控制台输出的地址），确认：
- **采集模式** 显示 `LIVE`
- **DHT 节点** 数量持续增长（正常 1-2 分钟内可达 1000+）
- **来源分布** 出现 `dht_active` / `dht_sample` / `tracker` 来源
- **健康度** 显示绿色（≥ 70）
- **IPv6 占比** 非零（公网环境应有 v6 peer）
- **Tracker 健康度** 显示 `alive/total`，平均延迟合理
- **冷存储状态** 显示 `运行中`，已同步数持续增长

### 4. 验证 GeoIP 解析

```bash
# 查看已解析的 IP 地理位置（应为真实城市）
node -e "const db=require('./src/server/db'); db.open(); db.get().prepare('SELECT ip,cc,region,city,isp FROM ip_geo LIMIT 10').all().forEach(r=>console.log(r.ip,'|',r.cc,r.region,r.city,'|',r.isp));"
```

预期输出（示例）：
```
221.0.47.175 | CN Shandong Qingdao | CNC Group CHINA169 Shandong Province Network
223.73.130.144 | CN Guangdong Foshan | China Mobile communications corporation
18.163.110.130 | HK Central and Western Hong Kong | Amazon Technologies Inc.
```

### 5. 验证 IPv6 与 BEP-52 支持

```bash
# 查看 IPv6 peer 采集情况
node -e "const db=require('./src/server/db'); db.open(); db.get().prepare(\"SELECT COUNT(DISTINCT ip) AS c FROM obs_log WHERE ip LIKE '%:%'\").get().forEach=r=>console.log('IPv6 peers:', r.c);"

# 查看 v2 种子（如有）
node -e "const db=require('./src/server/db'); db.open(); db.get().prepare('SELECT COUNT(*) AS c FROM torrents WHERE hash_version=2 OR hash_version=3').get();"
```

### 6. 生产部署建议

```bash
# 使用 PM2 等进程管理器
pm2 start scripts/start.js --name bittorrents-monitor -- --live

# 独立冷存储 worker（可选，与主进程分离更彻底）
pm2 start scripts/cold-storage-worker.js --name bittorrents-cold

# 或使用 systemd（Linux）
```

生产环境注意事项：
- **UDP 6881 出站**：DHT 需要 UDP 出站，确保防火墙放行（IPv4 + IPv6）
- **TCP 6881 入站**（可选）：作为可被连接的 BT 客户端时需要
- **公网 IP**：真实采集需要公网 IP 或 NAT 穿透
- **带宽**：DHT 采集约产生 10-50 KB/s 流量
- **磁盘**：SQLite 主库约 1-10 MB/万种子；冷存储库约 0.5-5 MB/万种子
- **ip-api.com 限速**：免费版 45 请求/分钟，批量接口每批 100 IP。系统已内置 5 秒间隔的批量队列

## 采集网络详解

### DHT 爬虫（BEP-5 / BEP-51 / BEP-52）

`src/collector/dht.js` — Mainline DHT 爬虫

- **IPv4 + IPv6 双栈 UDP 监听**：`udp4` + `udp6` 同时 bind 6881，独立收发
- **标准 Kademlia K-bucket 路由表**：160 桶 × K=8，LRU 淘汰，总容量上限 2000 节点
- **XOR 距离前导零定位桶索引**：`bucketIndex()` 增量维护，避免全量排序
- **节点 ID 周期性刷新**：每 15 分钟更换自身节点 ID，扩大路由覆盖
- **v2 infohash 兼容**：64-hex v2 infohash 在 DHT 层面截断为前 20 字节（SHA-256 前 160 位）
- **主动模式**：向路由表节点发 `get_peers`，从响应 `values` 提取 (ip, port, infohash)
  - 50% 概率用已知 infohash 查询（更可能获得 peer 列表）
  - 50% 概率用随机 infohash 查询（发现新种子）
  - IPv4(6B) + IPv6(18B) compact peer 解析
- **被动模式**：应答他人的 `get_peers` / `announce_peer`，从 `announce_peer` 捕获真实做种
- **BEP-51**：`sample_infohashes` 批量发现 infohash，发现后立即对其 `get_peers` 找 peer
- **Bootstrap**：19 个全球 DHT 引导节点（去重），并行入网，失败自动串行重试
- **端口冲突处理**：UDP 6881 被占用时自动递增端口（最多重试 20 个）

### PEX 采集器（BEP-11）

`src/collector/pex.js` — Peer Exchange

- 在已有 BT TCP 连接上发送/接收 `ut_pex` 扩展消息
- 从 PEX 消息中提取新增 peer（**IPv4 `added` + IPv6 `added6`**）
- 支持 `added` / `added6` / `dropped` 紧凑格式解析
- 每 45 秒对活跃种子做 PEX 扩散
- IPv6 peer 现在有真实上游来源（DHT/Tracker 双栈产出 v6 peer）

### Tracker 抓取器（BEP-3 / BEP-15 / BEP-7）

`src/collector/tracker.js` — HTTP + UDP Tracker

- **HTTP Tracker**（BEP-3）：紧凑 peer 格式解析，支持 `peers6` (BEP-7) IPv6 字段
- **UDP Tracker**（BEP-15）：连接握手 → announce → peer 列表
  - **DNS 解析并发竞速**：自动获取所有 A/AAAA 记录，IPv4/IPv6 同时尝试，首个成功立即返回
  - 支持 `udp4` + `udp6` socket
  - 兼容非标准混合/纯 IPv6 响应（`parseCompactPeersMixed` 按 6/18 字节对齐解析）
- **静态 18 个公共 Tracker**：按 hostname 去重，覆盖全球各地区（HTTP + UDP）
- **动态 TrackerManager**：
  - 24 小时从 ngosang/trackerslist 拉取远程列表（`trackers_all.txt` + `trackers_best.txt`）
  - 5 分钟健康检查：对每个 tracker 发轻量 announce（numwant=1），记录延迟与存活
  - 连续 3 次失败标记为 dead，自动驱逐给新 tracker 让位
  - 容量上限 30 个，超出时优先驱逐 dead 条目
  - `getAlive()` 返回存活列表；首轮检查未完成时回退为全部，避免 harvest 空跑
- 分批并发请求（每批 5 个），避免瞬时连接爆炸

### 元数据抓取（BEP-9 / BEP-10 / BEP-52）

`src/collector/metadata.js` — BitTorrent 元数据

- TCP 连接 peer（**IPv4 和 IPv6**）→ **MSE/PE 加密握手** → BT 握手 → `ut_metadata` 扩展分片拉取
- **握手 reserved bytes 置 BEP-52 v2 支持位**
- bencode 解析 name / files / **file tree (BEP-52 v2)** / **piece layers**
- **SHA-1 校验 v1 infohash** / **SHA-256 校验 v2 infohash**
- v2 种子解析 `meta version=2` 的 file tree 递归结构，提取文件大小
- **TF-IDF + Softmax 分类**（详见下方"种子分类器"），8 类自动分类
- **并行 20 peer**（DHT peer 质量参差，并行提高成功率）
- **重试机制**：每 10 秒对有 peer 但无 metadata 的种子重新解析，优先 announce_peer 真实做种者

### 协议加密 MSE/PE（BEP-8）

`src/collector/mse.js` — Message Stream Encryption / Protocol Encryption

- **768-bit DH 密钥交换**：使用 Node.js `crypto.createDiffieHellman` 与 BEP-8 规定的固定大素数
- **纯 JS RC4 实现**：Node.js v24 已移除内置 RC4，本模块用 ~30 行 JS 实现 RC4 + RC4-drop（丢弃前 1024 字节输出，安全增强）
- **MSE 握手流程**（initiator 角色）：
  1. 生成 DH 密钥对，发送 Y_A（96 字节）
  2. 接收 Y_B，计算共享密钥 S
  3. 发送 crypto negotiation：`HASH('req1',S) + HASH('req2',SKEY) XOR HASH('req3',S) + crypto_provide + IA(BT握手)`
  4. 接收 crypto_select + IB(BT握手)
  5. 若选择 RC4，后续数据用 RC4 加密
- **混合支持**：crypto_provide 同时声明 `PLAINTEXT(0x01) | RC4(0x02)`，peer 可任选
- **自动回退**：MSE 握手超时/失败时，自动回退到明文 BT 握手（`fetchFromPeerAuto`）
- 集成于 `metadata.js`：`fetchFromPeerMSE` 优先尝试 MSE，失败回退 `_fetchPlaintext`

### uTP 检测（BEP-29）

`src/collector/dht.js` — uTP (Micro Transport Protocol) peer 识别

- **implied_port 标志**：DHT `announce_peer` 消息中 `implied_port=1` 表示 peer 端口应取自 UDP 包源端口（而非 a.port 字段），这是 BEP-29 uTP 客户端的典型行为
- **被动检测**：在 `announce_peer` 处理路径中检测 `implied_port` 标志，统计 uTP peer 数量
- **监控可见**：DHT stats 新增 `utpPeers` 字段，监控 WebUI IPv6 面板新增 uTP 计数显示

### 种子分类器（TF-IDF + Softmax）

`src/collector/classifier.js` — 替代纯正则规则的 ML 分类器

- **TF-IDF 向量化器**：
  - 分词器：lowercase + 非字母数字分割 + 停用词过滤
  - 特征归一化：4 位年份归一化为 `__year__`、`SxxExx` 归一化为 `__sxxexx__`（避免每个年份/集号作为独立无区分度 token）
  - bi-gram 特征：相邻 token 配对，提升命名模式识别（如 `web_dl___year__`）
  - IDF 加权：`ln(N / (1 + df))` + 1 平滑
  - L2 归一化：稀疏向量归一化
- **多项逻辑回归（Softmax）**：
  - 9 类输出：XXX / TV / Anime / Movies / Music / Games / Books / Software / Unsorted
  - 小批量梯度下降训练（400 epochs，lr=0.6 衰减，L2=0.002）
  - 稀疏权重矩阵（Float32Array），仅更新非零特征
- **混合分类策略**（保证准确率 + 泛化能力）：
  1. **正则硬规则优先**：apk/SxxExx/FitGirl/erai-raws 等强信号直接分类
  2. **ML 处理其余**：词表命中走 Softmax 预测，取 argmax
  3. **空向量回退**：词表完全未命中返回 Unsorted
- **内置训练语料**：8 类 × 15 条精选样本（覆盖主流发布组命名模式），启动时训练 <50ms
- **API**：
  - `classify(name)` — 返回类别字符串（与原函数兼容）
  - `classifyWithConfidence(name)` — 返回 `{ category, confidence, source }`
  - `retrain()` — 重置单例并重新训练

### 冷存储进程（独立）

`src/collector/cold-storage.js` + `scripts/cold-storage-worker.js`

- **进程分离**：可嵌入主进程（unref，不阻塞退出）或独立 worker 运行
- **只录入 5 项**：`name / size / magnet / infohash_v1 / infohash_v2`
- **版本检测**：40-hex = v1 (SHA-1) / 64-hex = v2 (SHA-256) 自动识别
- **v2 磁力链接**：multihash `btmh:1220...` + base32 编码（BEP-52 标准）
- **增量同步**：rowid 游标分批扫描，初始全量完成后切换为增量模式（60s 重叠窗口防丢失）
- **回填机制**：对冷库中 name 为空的行从主库补全
- **状态可见**：监控 WebUI 显示 `running / total / synced / pending / dbPath / lastSync`
- **WAL 模式**：冷库独立 SQLite + WAL + busy_timeout 5s
- **主库只读**：避免与主进程写入冲突

### 长跑稳定性优化

`src/collector/pipeline.js`

- **TTL 化去重 Map**：`seenThisRun / torrentsTouched / peersTouched` 由 Set 改为 Map<key, ts>，每小时清理 25h+ 过期条目
- **obs_log TTL 清理**：每 1 小时清理 30 天前的 obs_log（`db.pruneObsLog(30)`），并在删除 1 万+ 条后触发 `wal_checkpoint(TRUNCATE)`
- **写队列批处理**：事件先入内存队列（容量 50 条），每 500ms 批量写入 SQLite + BEGIN/COMMIT 事务
  - 单条失败不影响整批
  - 事务失败自动回退为逐条写入
- **WAL + busy_timeout 5s**：减少 SQLite 锁竞争
- **日粒度去重**：同一 (ip, infohash, day) 仅计一次，减少写放大

### GeoIP 地理位置解析

`src/server/geo.js` — 基于 ip-api.com 的真实批量查询

- **批量查询**：ip-api.com batch API（每批 100 IP，中文返回，含省/市/ISP/经纬度/时区）
- **三层缓存**：内存缓存 → DB 缓存 → API 查询
- **后台队列**：新 IP 同步返回占位值，异步加入待查队列，每 5 秒批量处理
- **定期刷新**：每 2 小时刷新超 30 天的旧缓存
- **补写机制**：每 30 秒补写之前因占位跳过的 country_daily 统计
- **私有 IP 检测**：10.x / 172.16-31.x / 192.168.x / 127.x / IPv6 ULA 直接返回 Local
- **降级策略**：API 不可用时返回占位值（`_pending: true`），不阻断服务

```bash
# 验证 ip-api.com 批量查询
node -e "async function t(){const ips=['8.8.8.8','114.114.114.114','218.26.74.1'];const r=await fetch('http://ip-api.com/batch?fields=query,countryCode,regionName,city,isp&lang=zh',{method:'POST',body:JSON.stringify(ips),headers:{'Content-Type':'application/json'}});(await r.json()).forEach(x=>console.log(x.query,'|',x.countryCode,x.regionName,x.city,'|',x.isp));}t();"
```

预期输出：
```
8.8.8.8 | US Virginia Ashburn | Google LLC
114.114.114.114 | CN Shandong Jinan | China Unicom Shandong Province network
218.26.74.1 | CN Shanxi Taiyuan | CNC Group CHINA169 Shanxi Province Network
```

## 监控 WebUI

独立运行在单独端口的监控面板，实时展示：

| 模块 | 内容 |
|---|---|
| 核心指标（8 列） | 采集模式 / 种子总数 / IP 节点 / 采集速率（含峰值均值）/ DHT 节点 / 元数据成功率 / 累计事件 / 健康度 |
| 采集器状态 | DHT / Tracker / PEX 各采集器运行状态 + 发现 peer 数 + rx/tx 流量 |
| 趋势图表 | 多来源堆叠面积图（DHT被动/主动/采样 + Tracker + PEX），15m/1h/3h/6h 时间窗口切换 |
| 来源分布 | 百分比 + 进度条 |
| 元数据进度 | 种子总数 / 已解析名 / 已解析 size / 元数据 OK + size 落库率进度条 |
| Top 国家 | 近 24h 地理分布 |
| **IPv6 采集统计** | v6 peer 总数 / v4 peer 总数 / v6 (1h) / v6 (24h) + IPv6 占比进度条 + DHT 直接捕获 v6 数 |
| **Info Hash v2 (BEP-52)** | v1 / v2 / hybrid 种子数 + piece layers / file tree 落库数 + v2 落库率进度条 |
| **冷存储状态** | 冷库总数 / 已同步 / 待同步 / 同步率 + 数据库路径 + 最近同步时间 |
| **Tracker 健康度** | 总数 / 存活 / 死亡 / 平均延迟 + 存活率进度条 |
| Tracker 详情表 | URL / 状态（存活/死亡/未检）/ 延迟 / 失败次数（按延迟升序，最多 20 条） |
| 采集器综合统计 | 会话累计 / 本次新增 / DHT announce / DHT sample + 收发流量 + 模式/端口 |
| 实时事件流 | 最近 30 条观测（时间 / IP / 资源名 / **大小** / 来源徽章） |
| DHT 路由表 | 节点 ID / 地址 / 年龄 |
| 系统资源 | 内存 RSS / 堆使用 / 运行时长 / Node 版本 + 内存占用趋势曲线 |

### 平滑过渡

图表使用 `chart.update()` 而非 `destroy() + new Chart()`，避免整图闪动重建，配合 400ms easeOutQuart 动画实现顺滑过渡。

### 健康度评估

| 分数 | 状态 | 含义 |
|---|---|---|
| 70-100 | 健康（绿色） | 采集正常，DHT 节点充足 |
| 30-69 | 警告（黄色） | 节点不足或速率偏低 |
| 0-29 | 异常（红色） | 采集器停止或无数据 |

### JSON 接口

| 端点 | 说明 |
|---|---|
| `GET /api/stats?mins=60` | 完整采集统计 + 系统指标 + 多来源分时数据 + Top国家 + IPv6 + v2 + 冷存储 + Tracker 列表 |
| `GET /api/nodes` | DHT 路由表节点列表 |
| `GET /api/health` | 健康度 + 系统信息 |
| `GET /api/trend` | 近 6 小时采集趋势 |
| `GET /api/system` | 系统资源指标 |

## 站点功能

完整复刻 [iknowwhatyoudownload.com](https://iknowwhatyoudownload.com) 全站功能：

| 页面 | 路由 | 说明 |
|---|---|---|
| IP 下载记录 | `/en/peer/?ip=` | 地理标签 + 下载表格（含 infohash / magnet / first-seen / **资源大小**） |
| Track Downloads | `/en/link/` | 短链追踪 → 访问记录 → 轮询 |
| 日统计 | `/en/stat/daily` | 三项比率 + 分类饼图 + Top 12 + 海报墙（**默认 Global 视图**） |
| 年度统计 | `/en/stat/annual` | 月度分类汇总 + 柱状图 |
| 种子详情 | `/en/torrent/{hash}/{slug}` | 磁力链接框 + 30 天 peer 曲线 + 文件列表（**支持 v1 (40-hex) 和 v2 (64-hex) 路由**） |
| **冷存储信息** | `/en/cold-storage/` | 显示本地冷存储数据库文件路径 |
| API 文档 | `/en/api/` | 合作说明 + Demo Key |
| About Us | `/en/contacts/` | 联系信息 |

### Daily Statistics Global 视图

`/en/stat/daily?cc=GL` 显示全球汇总数据，替换原"United States"字样，使用全球 80 亿人口 + 65% 互联网普及率计算每百万人比率。

### REST API

| 端点 | 说明 |
|---|---|
| `GET /api/history/peer?ip=&days=&contents=` | Peer 下载历史（含 magnet + firstSeen + size） |
| `GET /api/history/peers?cidr=` | CIDR 内已知 IP |
| `GET /api/history/exist?ip=` | IP 是否存在 |
| `GET /api/torrent/info/{infohash}` | 种子信息（含 magnet + files + size + v2 字段） |
| `GET /api/torrent/peers/{infohash}?day=` | 按日 peer 统计 |
| `GET /api/content/summary?day=` | 内容汇总报告 |
| `GET /api/content/downloads?day=` | 日下载报告 |
| `GET /api/stat/daily?date=&cc=` | 日统计页数据（cc=GL 即全球） |

## 测试

```bash
node tests/unit.js      # 采集层组件：bencode/DHT/元数据/分类器
node tests/e2e.js       # 全链路：模拟采集→入库→API→页面→短链闭环
node tests/stress.js    # 压力与边界：5.5 万事件灌入、吞吐/延迟、XSS
node tests/admin.js     # 后台 WEBUI：仪表盘/统计 API/采集控制
# 或 npm test（依次全部运行）
```

## 目录结构

```
├── src/
│   ├── collector/
│   │   ├── dht.js              # DHT 爬虫（BEP-5/51/52，IPv4+IPv6 双栈，Kademlia K-bucket 路由表，uTP 检测）
│   │   ├── pex.js              # PEX 采集器（BEP-11 ut_pex，IPv4 added + IPv6 added6）
│   │   ├── tracker.js          # Tracker 抓取器（HTTP BEP-3 + UDP BEP-15 + BEP-7 peers6 + TrackerManager）
│   │   ├── metadata.js         # 元数据抓取（BEP-9/10/52，MSE/PE 加密，SHA-1/SHA-256 校验，file tree，并行 20 peer）
│   │   ├── mse.js              # 协议加密 MSE/PE（BEP-8，纯 JS RC4 + 768-bit DH 密钥交换）
│   │   ├── classifier.js       # TF-IDF + Softmax 分类器（混合策略：正则硬规则 + ML）
│   │   ├── pipeline.js         # 统一采集管道（TTL Map + 写队列批处理 + obs_log TTL）
│   │   ├── service.js          # 采集服务调度（sim/live 模式 + TrackerManager + 冷存储集成 + uTP 统计）
│   │   ├── cold-storage.js     # 冷存储模块（独立 SQLite，name/size/magnet/v1/v2）
│   │   ├── simulator.js       # 沙箱模拟数据源
│   │   └── run.js             # 独立采集入口（--dht --tracker --pex）
│   ├── common/
│   │   ├── bencode.js          # Bencode 编解码（BEP-3，decodeWithNext 精确定位）
│   │   ├── util.js             # 通用工具（SHA-1/SHA-256/magnet btih+btmh/IPv6 校验/格式化）
│   │   └── ports.js            # 端口自动检测工具（IPv4/IPv6 双栈）
│   └── server/
│       ├── index.js           # HTTP 服务主入口
│       ├── api.js             # REST API 层
│       ├── pages.js           # SSR 页面渲染（含 Global 视图 + 冷存储信息页）
│       ├── admin.js           # 内嵌管理面板
│       ├── monitor.js         # 独立监控 WebUI（IPv6/v2/冷存储/Tracker 面板 + 平滑过渡）
│       ├── db.js              # 存储层（node:sqlite，WAL，迁移兼容，obs_log TTL）
│       └── geo.js             # GeoIP 模块（ip-api.com 批量查询，三层缓存，降级策略）
├── scripts/
│   ├── start.js               # 一键启动（端口检测 → 站点 + 监控 + 采集 + 冷存储）
│   ├── cold-storage-worker.js # 独立冷存储 worker 入口
│   └── seed.js                # 演示数据生成
├── public/assets/             # 静态资源（Bootstrap/jQuery/Chart.js/FontAwesome 本地化）
├── tests/                     # e2e / unit / stress / admin 测试
├── docs/ARCHITECTURE.md       # 架构设计文档
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
| IPv6 peer 占比 | 1-5% | 5-15% | 10-20% |
| Tracker 存活率 | 50-70% | 60-80% | 70-85% |
| GeoIP 解析 | 实时批量 | — | — |
| 冷存储同步 | — | 增量追平主库 | — |

> 性能取决于网络环境、DHT 节点质量、tracker 可用性、IPv6 双栈支持等因素。

## 技术要点

- **零依赖**：仅使用 Node.js 标准库 + `node:sqlite`，无需 `npm install`
- **自研 bencode**：完整 Bencode 编解码，支持 Buffer/字典序/`decodeWithNext` 精确定位
- **WAL 模式**：SQLite WAL + busy_timeout 5s，支持高并发写入
- **写队列批处理**：500ms / 50 条事件批量写入，减少锁竞争
- **TTL 化去重**：Map<key, ts> + 25h 过期清理，防止长跑内存无限增长
- **obs_log TTL**：30 天保留 + wal_checkpoint(TRUNCATE) 回收空间
- **日粒度去重**：同一 (ip, infohash, day) 仅计一次，减少写放大
- **端口自动检测**：IPv4/IPv6 双栈检测，被占用时自动切换
- **健康度评估**：综合 DHT 节点数、采集速率、元数据成功率评分
- **GeoIP 三层缓存**：内存 → DB → ip-api.com 批量查询，降级不阻断
- **Kademlia 标准**：160 桶 × K=8 LRU，XOR 距离增量定位
- **IPv6 全链路**：DHT 双栈 + PEX added6 + Tracker peers6 + TCP v6 元数据连接
- **BEP-52 完整支持**：SHA-256 / 64-hex / multihash btmh / file tree / piece layers / hybrid 种子
- **冷存储进程分离**：unref 嵌入或独立 worker，主库只读访问
- **MSE/PE 协议加密**：纯 JS RC4 + DH 密钥交换，无外部加密库依赖
- **uTP 被动检测**：复用 DHT announce_peer 的 implied_port 标志，零额外开销
- **ML 分类器**：TF-IDF + Softmax 纯 JS 实现，无 numpy/tensorflow 依赖

## 许可与声明

本项目仅用于技术研究与沙箱测试环境。采集的数据仅为元数据级别（infohash / 种子名 / 文件列表），不涉及任何内容数据的传输或存储。

## 技术栈

- Node.js ≥ 22.5（标准库 + `node:sqlite`）
- BitTorrent 协议：BEP-3 / BEP-5 / BEP-7 / BEP-8 / BEP-9 / BEP-10 / BEP-11 / BEP-15 / BEP-23 / BEP-29 / BEP-51 / BEP-52
- Kademlia DHT：160 桶 × K=8 LRU 路由表
- IPv6：双栈 UDP + compact6 peers + TCP v6 + DNS AAAA 并发竞速
- 协议加密：MSE/PE (BEP-8) + 纯 JS RC4 + 768-bit DH
- uTP (BEP-29)：基于 DHT implied_port 被动检测
- ML 分类：TF-IDF + Softmax 多项逻辑回归（纯 JS 实现）
- GeoIP：ip-api.com batch API（中文返回，三层缓存）
- 前端：Bootstrap 5 + Chart.js 4（全部本地化，无 jQuery）
- 存储：SQLite (WAL 模式) + 独立冷存储 SQLite

---

## 更新日志

### v0.5.0 — 2026-07-29

#### 新增

- **混合种子 (Hybrid Torrent) 全链路支持 (BEP-52)**：
  - 混合种子同时携带 v1 (SHA-1/40-hex) 和 v2 (SHA-256/64-hex) infohash，BEP-52 规范允许此类种子的 info dict 同时包含 v2 的 file tree 和 v1 的 files/pieces
  - **元数据解析**（`metadata.js`）：`parseInfo` 检测 hybrid（同时有 file tree 和 v1 字段），`resolveAndStore` 同时计算 v1+v2 哈希，以 v1 作为主键、v2 存入 `infohash_v2` 列，`hash_version=3`
  - **数据合并**（`pipeline.js`）：新增 `linkHybridInfohash(v1, v2)` 函数，将之前以 v2 infohash 登记的占位行数据合并到 v1 主键行——observations 合并 hits、obs_log 改写 infohash、torrent_daily 合并 peers 计数、删除 v2 占位行
  - **采集服务**（`service.js`）：hybrid 种子解析成功后注册 v2 infohash 到 DHT 查询，发现更多 peer
  - **API**（`api.js`）：`/api/torrent/info` 和 `/api/torrent/peers` 按 v2 infohash 查找时回退到 `infohash_v2` 列，返回 `infohashV2` / `hashVersion` 字段
  - **磁力链接**（`util.js`）：hybrid 磁链同时携带 `xt=urn:btih:` (v1) 和 `xt=urn:btmh:` (v2)，符合 BEP-52
  - **页面展示**（`pages.js`）：种子详情页同时展示 v1 和 v2 infohash，hybrid 标注 `(v1)` / `(hybrid)`
  - **冷存储**（`cold-storage.js`）：`syncOnce` 和回填均使用 hybrid-aware 的 `_splitHashFromRow`，正确提取 v1+v2 构建双 xt 磁链，同步去重集合同时追踪 v1 和 v2

- **快速启动脚本重写**（`scripts/start.js`）：
  - 完整 CLI 参数解析：`--live` / `--no-collector` / `--no-monitor` / `--port` / `--monitor-port` / `--dht-port` / `--seed` / `--help`
  - 环境预检：Node.js 版本检测（≥ 22.5）+ `node:sqlite` 可用性验证，失败给出明确提示
  - 健康探活：启动后自动请求 `/api/overview` 验证站点就绪，10 次重试
  - 优雅退出：SIGINT/SIGTERM 信号处理，按序关闭采集器 → 监控 WebUI → 站点 HTTP，3 秒兜底强制退出
  - 新增 `monitor.stop()` 函数，支持优雅关闭监控 WebUI
  - DHT 端口可配置：`--dht-port` 透传到 `startLive` → `DHTSpider`

#### 修复

- **冷存储 hybrid 同步 bug**：`syncOnce` 原使用 `_splitHash(row.infohash)` 单哈希解析，无法处理 hybrid 种子（v1 在 infohash 列、v2 在 infohash_v2 列）。修正为使用 `_splitHashFromRow(row)` 正确提取 v1+v2，磁链构建和去重集合均同步更新
- **冷存储回填磁链 bug**：回填 name 为空的行时使用单 infohash 构建磁链，hybrid 种子磁链缺失 v2 xt。修正为从主库行提取 v1+v2 构建正确双 xt 磁链

### v0.4.0 — 2026-07-29

#### 新增

- **协议加密 MSE/PE (BEP-8)**：
  - 新增 `src/collector/mse.js` 模块，实现 BitTorrent 协议加密握手
  - 纯 JS RC4 实现（Node.js v24 已移除内置 RC4）+ RC4-drop 安全增强
  - 768-bit Diffie-Hellman 密钥交换（BEP-8 规定的固定大素数）
  - MSE 握手四阶段：Y_A 发送 → Y_B 接收计算 S → crypto negotiation → crypto_select + IB
  - 混合 crypto_provide：同时声明 PLAINTEXT(0x01) | RC4(0x02)，peer 可任选
  - 元数据抓取集成 `fetchFromPeerMSE`：优先尝试 MSE，失败自动回退明文（`fetchFromPeerAuto`）
  - 使项目能连接要求强制加密的 BitTorrent 客户端

- **uTP 传输协议检测 (BEP-29)**：
  - DHT `announce_peer` 消息的 `implied_port=1` 标志识别 uTP peer
  - DHT stats 新增 `utpPeers` 字段，统计 uTP peer 数量
  - 监控 WebUI IPv6 面板新增 uTP 计数显示
  - 零额外网络开销（复用现有 DHT 数据流）

- **TF-IDF + Softmax 种子分类器**：
  - 新增 `src/collector/classifier.js` 模块，替代纯正则规则
  - TF-IDF 向量化器：分词 + 停用词过滤 + bi-gram + IDF 加权 + L2 归一化
  - 特征归一化：年份 → `__year__`、`SxxExx` → `__sxxexx__`（提升泛化）
  - 多项逻辑回归（Softmax）：9 类输出，400 epochs 训练，L2 正则
  - 混合分类策略：正则硬规则优先（apk/FitGirl/SxxExx 等）+ ML 处理其余
  - 内置 8 类 × 15 条精选训练语料，启动训练 <50ms
  - API：`classify(name)` + `classifyWithConfidence(name)` + `retrain()`
  - 30/30 单元测试通过，泛化测试 14 条 13/14 正确

- **Anime 正则规则扩展**：
  - 新增主流动漫发布组：horriblesubs / crunchyroll / commie / doremi / anime-koi / mutiny / pgs / asw / suki
  - Anime 规则优先于 TV 规则匹配，避免 "Final Season" 等术语被误判为 TV

- **前端堆栈现代化**：
  - Bootstrap 3.3 → Bootstrap 5（所有组件类名迁移）
  - Chart.js 2.6 → Chart.js 4（scales 配置 + plugins.legend 重构）
  - jQuery 1.11 → 原生 JS（vanilla JS 替换所有 jQuery 调用）
  - 图表更新改用 `chart.update()` 而非 `destroy() + new Chart()`，消除闪动

#### 优化

- **元数据抓取链路**：MSE 优先策略使能连接到强制加密的 peer，提升抓取成功率
- **uTP peer 识别**：无需额外协议实现，通过 DHT 被动识别
- **分类准确率提升**：ML 处理 regex 未覆盖的命名模式（如 Linux.Mint.iso、Adobe.After.Effects）

### v0.3.0 — 2026-07-29

#### 新增

- **IPv6 全链路支持**：
  - DHT：`udp4` + `udp6` 双栈 UDP 监听 6881 端口，独立收发
  - DHT：IPv4(26B) + IPv6(38B) compact 节点列表解析
  - DHT：IPv4(6B) + IPv6(18B) compact peer 列表解析
  - PEX：`added6` 字段 IPv6 peer 解析（终于有上游 v6 peer 来源）
  - Tracker：HTTP `peers6` (BEP-7) 字段解析
  - Tracker：UDP tracker 通过 DNS AAAA 记录并发竞速 IPv6 地址
  - Tracker：`udp6` socket + 混合/纯 IPv6 响应兼容解析
  - 元数据：TCP v6 连接 peer 拉取 ut_metadata
  - 监控 WebUI：新增 IPv6 采集统计面板（v6 总数 / v4 总数 / 1h / 24h / 占比）

- **BitTorrent v2 / BEP-52 完整支持**：
  - util.js：`sha256hex()` + `isV2Infohash()` + `normalizeInfohash` 接受 64-hex
  - util.js：`magnetURI()` 支持 `xt=urn:btmh:1220...` multihash 格式
  - 元数据：握手 reserved bytes 置 BEP-52 v2 支持位
  - 元数据：v2 用 SHA-256 校验 infohash；v1 用 SHA-1
  - 元数据：解析 `meta version=2` 的 file tree 递归结构，提取文件大小
  - 元数据：piece layers 和 file tree 落库（`piece_layers_json` / `file_tree_json`）
  - DHT：v2 infohash (64-hex) 在 DHT 层面截断为前 20 字节（SHA-256 前 160 位）
  - 数据库：torrents 表新增 `hash_version` (1=v1, 2=v2, 3=hybrid) / `infohash_v2` / `piece_layers_json` / `file_tree_json` / `cold_synced`
  - 站点：种子详情页路由同时支持 v1 (40-hex) 和 v2 (64-hex) infohash
  - 监控 WebUI：新增 v2 统计面板（v1 / v2 / hybrid 种子数 + piece layers / file tree 落库率）

- **标准 Kademlia K-bucket 路由表**：
  - 替换原平面 Map 全量 XOR 排序的实现
  - 160 桶 × K=8 LRU 路由表
  - `bucketIndex()` 通过 XOR 前导零定位桶索引，增量维护
  - 桶满时淘汰最久未联系节点（LRU）
  - 节点 ID 每 15 分钟刷新，扩大路由覆盖
  - 总容量上限 2000 节点

- **动态 Tracker 管理 (TrackerManager)**：
  - 24 小时从 ngosang/trackerslist 拉取远程公开列表
  - 5 分钟健康检查：对每个 tracker 发轻量 announce (numwant=1)，记录延迟
  - 连续 3 次失败标记为 dead，自动驱逐给新 tracker 让位
  - 容量上限 30 个，超出时优先驱逐 dead 条目
  - `getAlive()` 智能回退：首轮检查未完成时返回全部，避免 harvest 空跑
  - `getTopTrackers(limit)` 按延迟升序返回详情列表
  - 监控 WebUI：新增 Tracker 健康度面板 + 详情列表表

- **独立冷存储进程**：
  - `src/collector/cold-storage.js` + `scripts/cold-storage-worker.js`
  - 进程分离：可嵌入主进程（unref）或独立 worker 运行
  - 只录入 5 项：name / size / magnet / infohash_v1 / infohash_v2
  - 版本检测：40-hex = v1 / 64-hex = v2 自动识别
  - v2 磁力链接：multihash `btmh:1220...` + base32 编码
  - 增量同步：rowid 游标分批扫描 + 60s 重叠窗口
  - 回填机制：对冷库中 name 为空的行从主库补全
  - WAL 模式 + 主库只读访问
  - 主站点：新增 `/en/cold-storage/` 页面显示本地冷存储数据库路径
  - 监控 WebUI：新增冷存储状态面板（总数 / 已同步 / 待同步 / 同步率 / 路径 / 最近同步）

- **监控 WebUI 新增面板**：
  - IPv6 采集统计（v6 总数 / v4 总数 / 1h / 24h / 占比 + 进度条）
  - Info Hash v2 (BEP-52)（v1 / v2 / hybrid + piece layers / file tree 落库率）
  - 冷存储状态（运行状态 + 同步进度 + 数据库路径）
  - Tracker 健康度（总数 / 存活 / 死亡 / 平均延迟 + 存活率）
  - Tracker 详情列表（URL / 状态 / 延迟 / 失败次数）
  - 采集器综合统计（会话累计 / DHT announce / sample / 收发流量）

#### 修复

- **数据库迁移 bug**：旧库已存在 torrents 表但缺 `hash_version` 等新列时，CREATE INDEX 在 ALTER TABLE 之前执行导致 `no such column` 错误。重构为：先执行基础表 SCHEMA_LEGACY_BASE → ALTER TABLE 补列 → 再创建依赖新列的索引 SCHEMA_INDEXES
- **SQL 参数不匹配**：`/api/torrent/peers` 中 `WHERE infohash=? AND ts LIMIT 20000` 改为 `WHERE infohash=? AND ts<? LIMIT 20000`，参数数量与占位符对齐
- **map 缺箭头**：`.map(r = r.ip)` 修正为 `.map(r => r.ip)`
- **Bootstrap nodes 去重**：移除 BOOTSTRAP_NODES 中重复的 router.bittorrent.com / dht.transmissionbt.com
- **Tracker 列表去重**：PUBLIC_TRACKERS 按 hostname 去重，避免 dler.org / openbittorrent.com 等重复
- **Daily statistics "United States" 字样**：替换为 `Global` 视图，使用全球人口与互联网普及率计算比率

#### 优化

- **长跑内存泄漏修复**：
  - `seenThisRun / torrentsTouched / peersTouched` 由永久 Set 改为 Map<key, ts>
  - 每小时清理 25h+ 过期条目（跨日保留）
  - 避免长跑数天后内存无限增长
- **obs_log TTL**：
  - 每小时执行 `pruneObsLog(30)` 删除 30 天前日志
  - 删除 1 万+ 条后触发 `wal_checkpoint(TRUNCATE)` 回收空间
  - 防止 obs_log 线性追加写导致数据库文件膨胀
- **写队列批处理**：
  - 事件先入内存队列（容量 50 条）
  - 每 500ms 批量写入 SQLite + BEGIN/COMMIT 事务
  - 单条失败不影响整批；事务失败自动回退为逐条写入
  - 大幅减少 SQLite 锁竞争，提高高并发吞吐
- **DHT 节点 ID 周期性刷新**：每 15 分钟更换自身节点 ID，触发路由表重排，扩大网络覆盖

### v0.2.0 — 2026-07-09

#### 新增

- **真实 GeoIP 解析**：基于 ip-api.com 批量查询（中文返回，含省/市/ISP/经纬度/时区），替换 demo 占位解析器
- **GeoIP 三层缓存**：内存缓存 → DB 缓存 → API 查询，降级不阻断
- **GeoIP 批量队列**：每 5 秒批量处理待查 IP，每批 100 IP
- **GeoIP 定期刷新**：每 2 小时刷新超 30 天的旧缓存
- **GeoIP 补写机制**：每 30 秒补写之前因占位跳过的 country_daily 统计
- **监控 WebUI 平滑过渡**：Chart.js 改用 `update()` 而非 `destroy() + new Chart()`，避免整图闪动重建
- **监控 WebUI 资源大小列**：实时事件流新增资源大小列
- **元数据 size 修复**：修正 msg_type=1 误判 + off-by-one infohash 切片，确保 size 正确落库

#### 修复

- 元数据 fetcher 中 msg_type 字段解析错误导致 size 无法落库
- infohash 切片边界错误导致 SHA 校验失败

### v0.1.0 — 2026-07-04

#### 初始发布

- **全网络采集**：DHT (BEP-5/51) + PEX (BEP-11) + Tracker (HTTP/UDP, BEP-3/15) + BitTorrent P2P (BEP-9/10)
- **完整 Web 站点**：复刻 iknowwhatyoudownload.com 全站功能
  - IP 下载记录页（含 infohash / magnet / first-seen / 资源大小增强列）
  - Track Downloads 短链追踪
  - 日统计 / 年度统计
  - 种子详情页（磁力链接 + 30 天 peer 曲线 + 文件列表）
  - API 文档 / About Us
- **REST API**：Peer / Torrent / Content API，对齐官方接口
- **独立监控 WebUI**：暗色后台风格，多来源堆叠图表
- **沙箱模拟模式**：30 天演示数据生成
- **端口自动检测**：默认端口被占用时自动切换
- **零依赖**：仅 Node.js 标准库 + `node:sqlite`
- **自研 bencode** 编解码
- **WAL 模式 + busy_timeout 5s**
- **健康度评估**
- **125 项测试全通过**（unit + e2e + stress + admin）
