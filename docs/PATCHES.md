# 补丁全录

本项目的所有改动分两类：

- **A 类：控制台自身迭代**——直接改 `server.js` / `index.html` / 脚本，每次改动前在线上留时间戳备份（命名约定 `<文件>.bak-<主题>-<月日>`，如 `server.js.bak-bench-0923`）。备份在线上部署目录，不入库；本表即索引。
- **B 类：对外部系统的补丁**——对 chroot 镜像内 vLLM site-packages、部署脚本的幂等修改，以可重放脚本形式存档在 [`patches/`](../patches/)。每个脚本自带 `--check / --apply / --revert`，应用前自动备份。

---

## A. 控制台迭代时间线

### 2026-09-18 · `FN_EXTRA_ENV` 展开修复（脚本化模型环境变量静默失效）

- **症状**：控制台「vLLM 附加环境变量」输入框（如切 `FN_PLE_INT8` 档位）长期不生效。
- **根因**：`server.js` 的 `scriptModelLaunchPlan()` 把内容塞进单个字符串变量 `FN_EXTRA_ENV`，而外层启动脚本从不展开它——env 从未到达 chroot 内层。
- **修法**：`start-flash-next-w4a16.sh` 补齐展开逻辑：展开后写进 ENVF 文件末尾（`source` 时用户值覆盖缺省值）。
- **回滚**：`start-flash-next-w4a16.sh.bak-plefield-0923` 等系列备份。

### 2026-09-19 · 快速启动预设体系

- `quickstart-presets.json` 引入 + 热加载（改 JSON 即生效）；预设弹窗支持 TP/PP、MTP、YaRN 512K/1M、KV offload 参数组合。
- 同日机型方案文件 `flashnext-scheme-170hx(-local).json`（170HX 硬件能力描述：CUFile/PLE 产物探测、显存几何）。
- 关联备份：`server.js.bak-quickstart-0919`、`index.html.bak-scheme-0919`、`index.html.bak-delconfigtab-0919`（删掉冗余配置页）。
- 模型侧预设演进（同日多次）：`*.bak-512k-0919`、`*.bak-p2p-0919`、`*.bak-pp0-0919`、`*.bak-reppen-0919`、`*.bak-temp03-0919`、`*.bak-cachedtok-0919`、`*.bak-mmwarmup-0919`。

### 2026-09-19 · 磁盘读取速度走势卡（patch-disktrend-0919.py）

- 硬件监视页新增「磁盘 IO 走势」：后端每 tick 维护逐秒速率历史 `global.__diskHistory`（1s/点、保留 30 分钟），新端点 `/v1/internal/disk-trend?win=秒` 纯内存读取（不碰 lsblk/smartctl，可 2s 轮询）。
- **曾整版回退过一次**（`server.js.reverted-disktrend-0919` / `index.html.reverted-disktrend-0919`），后以更轻的实现重新落地。补丁脚本与说明存档：`patches/patch-disktrend-0919.py`、`docs/`。

### 2026-09-20 · 性能大改造（perf0920）

- 请求入口全面 async 化 + 全局 `unhandledRejection`/`uncaughtException` 兜底；
- `fetchMetricsCached`：上游 `/metrics`（单次 ~64KB）加 400ms TTL 缓存 + 单飞合流；
- `installGzip` 白名单压缩（内部 API/页面/静态；**chat 流式代理禁压**）；`index.html` 实时读盘 + ETag；
- 前端 `setInterval` 包 visibilitychange 门控（后台标签自动停轮询）。
- 备份：`server.js.bak-perf0920`、`index.html.bak-perf0920`。

### 2026-09-20 · Tailwind 预编译 + 控制台鉴权

- **弃用 `static/tailwind.js` 浏览器 JIT**（407KB 脚本每次进页面现编样式，首屏明显卡顿）→ 预编译 `static/tailwind-build.css`（9.4KB）。⚠️ 此后**改了 index.html 的新 class 必须跑 [`ops/build-tailwind.sh`](../ops/build-tailwind.sh) 重建**，否则新 class 无样式（踩过多回）。
- `console-auth.json` 存在即拦 `/v1/internal/` POST（`X-Console-Token` 或 `?ct=`），5 秒热生效，删文件即关；GET 与 `/v1` 代理不受影响。
- 备份：`server.js.bak-gencfg-0921`（同窗口期）。

### 2026-09-21 · 采样参数统一（patch-gencfg-0921.py）

- 18420 Flash-Next「复读」问题排查结论之一：弹窗/预设/内层脚本三处采样参数不一致，且 `flash-next-w4a16-inner.sh` 硬编码不读 `FN_GENCFG` → 弹窗改采样参数静默失效。
- 补丁：inner 新增 `GENCFG_DEFAULT`，override-generation-config 改读 `"${FN_GENCFG:-$GENCFG_DEFAULT}"`；server.js 弹窗与预设三处统一。
- 备份：`*.bak-gencfg-0921` 系列。

### 2026-09-22 · 仪表盘停刷修复 r1（20260922-r1）

两个根因（详见 [PITFALLS.md](PITFALLS.md) §3）：

1. `resolveBackendPort()` 探不到 vLLM 进程时硬回落 `return 8000`（无监听）→ 端口自愈把主端口横跳 → 主 stats 返回 `{}` → 整页假死。**改为探不到返回 `null`，调用方保持现状。**
2. `/v1/internal/power` 残留 `execSync nvidia-smi`（违反 09-20 铁律）→ 改读 `global.__gpuLive/__gpuStatic` 缓存。
- 前端加固：请求超时 8s；`{}` 视为无数据跳过渲染。备份：`index.html.bak-dashfix-0923`、`server.js.bak-kvoffsync-0923` 窗口。

### 2026-09-22 · KV offload 前端联动系列

- `kvoffdash-0922`：仪表盘接入 CPU KV 二级缓存指标；`kvoffhit-0922`：offload 命中率卡；`kvofftoggle-0922`：预设里 KV offload 开关；`cardorder-0922`：卡片排序调整。
- `memkv-preset-0922` / `p2pmtp1m-0922`：新增内存 KV 与 1M+MTP 预设。
- `pleint8-0922`：PLE INT8/BF16 档位切换预设落地（配合 09-18 的 FN_EXTRA_ENV 修复才真正生效）。

### 2026-09-22~23 · 页头指标与 PLE 展示系列

- `hdrmetrics/hdrperc/hdrtemp-0921`：页头常驻指标条（吞吐/百分位延迟/温度）。
- `plefield-0923` → `pledisp-0923` → `pleloc-0923` → `plelock-0923` → `plemem-0923`：模型启动表单逐步加入 PLE 表位置（heap/disk）、锁定与内存占用展示；`ra128-0923`：RA 窗口参数；`mtpdefault-0923`：MTP 缺省档位调整。

### 2026-09-23 · 前端自愈层（20260923-r1）

「页面开久了整页数字定格、必须刷新才恢复」的第二代修复（详见 [PITFALLS.md](PITFALLS.md) §4）：

- 停摆看门狗（判据=`_lastRenderAt` 渲染推进，2s 巡检、前台 6s 无渲染即整体重建定时器并补刷）；
- 自建 `AbortController + setTimeout` 替换 `AbortSignal.timeout()`（后者在标签页冻结解冻后永不 settle）；
- 回前台四类事件 `visibilitychange/pageshow/focus/online`；
- 右上角 `dataFresh` 新鲜度徽章 + `PAGE_VERSION` 版本戳（识别浏览器旧缓存页）。
- 落点全在 `index.html`；备份 `index.html.bak-dashfix-0923`。

### 2026-09-23 · 基准测试标签（bench-console v2.2.1 移植）

- 引擎进 `server.js` 的 **BENCH IIFE 闭包**（外层已有同名 `sleep`/`parseMetrics`，必须闭包隔离）；API 挂 `/v1/internal/bench/*`；UI 独立页 `/bench.html`，主界面「基准测试」标签 iframe 懒加载。
- 被测服务 = 受管实例（动态跟随 `config.vllmPort`）+ 可选 `bench-services.json`（热读）；提示词 `prompts/prompts{13,6}.json`；结果落盘 `bench-results/`；Chart.js 本地托管 `static/chart.umd.min.js`。
- 上游：https://github.com/polyuij42-del/bench-console （MIT）。回滚：`server.js.bak-bench-0923`。

### 2026-09-23 · KV offload 控制台同步系列

- `kvoff1-0923` / `kvoffdefault-0923` / `kvoffsync-0923`：预设里 KV offload 开关与内层脚本缺省值三方同步（此前切档只改预设不改进程）。

---

## B. `patches/` 目录逐个说明（对外部系统的补丁）

背景：chroot 镜像内 vLLM 为 **v0.1.dev20073**（nightly），启用了 `OffloadingConnector`（GPU→CPU KV 二级缓存）+ PP2 + QSA 环形缓冲（CircularBufferSpec）。以下补丁按时间序构成一条完整的「上游 bug 追凶链」：

| 脚本 | 日期 | 对象 | 内容 |
|---|---|---|---|
| `patch-disktrend-0919.py` | 09-19 | server.js + index.html | 磁盘 IO 走势卡（见 A 类同日条目） |
| `patch-gencfg-0921.py` | 09-21 | inner 脚本 + server.js + 预设 | 采样参数三处统一、`FN_GENCFG` 消费（见 A 类） |
| `patch-kvfill-metric-0922.py` | 09-22 | vLLM `offloading/spec.py` | **注册缺失修复**：manager.py 会 `set_gauge(CPU_CACHE_FILL_PERC)` 但 spec.py 的 `build_metric_definitions()` 没有该条元数据 → `metrics.py:489` 的 `assert key in self._offloading_metric_defs` 在每请求路径上抛 AssertionError → **全部请求 500 / 引擎退出**。补定义即可（幂等，带备份）。 |
| `patch-kvoffload-c1c2-0922.py` | 09-22 | vLLM offloading 三文件 13 处 | c1+c2 重建版：使 PP2 + QSA 环形缓冲组合能启用 CPU KV 二级缓存（原版散落在多次会话，此为可重放整合版）。 |
| `patch-kvoffload-c3-0923.py` | 09-23 | vLLM offloading | 修两个 bug：Bug A = 上述 metrics assert 崩溃的根治版（未知 key 不再炸请求路径）；Bug B = CPU 档 lookup 全零的初版修复尝试。 |
| `patch-kvoffload-c3b-0923.py` | 09-23 | scheduler.py | **探针**（只加 INFO 日志不改行为）：定位 CPU 档 lookup 全零断点在哪一组/哪一步。 |
| `patch-kvoffload-c3c-0923.py` | 09-23 | scheduler.py | 探针加强：分组网格 + store/lookup 键样本对照。 |
| `patch-kvoffload-c3d-0923.py` | 09-23 | scheduler.py | 探针加强：store 按组记录哈希范围，lookup 记录查询切片哈希首尾。 |
| `patch-kvoffload-c3e-0923.py` | 09-23 | scheduler.py | 探针收口：`_sliding_window_lookup` 逐键结果扫描（实锤 idx=60/55 孤立 HIT → 存储端是稀疏键）。 |
| `patch-kvoffload-c4-0923.py` | 09-23 | scheduler.py | **c4 真修 v2（最小改动）**：滑动窗口组在 GDN 对齐模式下，存储端每分段只留尾部检查点（稀疏键），而查找端 eagle 把 required_window 抬到 sw+1 并要求连续命中——稀疏键永远凑不出连续 2 → grp2 hit=0。修正查找端的连续性要求与窗口宽度。 |
| `patch-kvoff-c5a.py` | 09-23 | scheduler.py | **根因修复**：解除 offloading 查找侧 eagle `+1/-1` 双罚。 |

方法论备注（值得抄作业）：

1. 探针先行：c3b→c3e 四个纯日志补丁逐级收窄，**不改行为**，用实测数据替代猜想，最后 c4/c5a 一刀真修。
2. 每个补丁幂等 + 自动备份（`.bak-<tag>`）+ `--revert` 可撤。
3. 验证窗脚本存档在 [`tools/`](../tools/)：`kvoff-c3-window.sh`（结果 `kvoff-c3-window.result`）、`kvoff-c3-preempt-test.py`、`fnx-bench.py`、`ab-swap-official.sh`/`ab-restore-custom.sh`（官方镜像 vs 定制镜像 A/B 切换）。

## 版本分叉警示（部署纪律）

- `index.html` 每次请求实时读盘：**改前端刷新浏览器即生效，不要重启 dsh-console**（vLLM 在同一 cgroup 内）。
- `server.js` 改动需重启才生效；重启前确认 `KillMode=process`。
- 本地镜像与线上可能分叉（例如 09-23 曾有本地含未上线的日志时间戳换算改动）。部署前一定 `diff` 线上文件，**勿混提**。本仓库内容以线上 sha256 核对为准。
