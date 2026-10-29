# 更新日志

## 2026-10-29 [gpu-uptime-inforom 1029] 通电时间主值切换出厂真值口径（已上线 .127，页面 r52）
- **纠错**：首版（r50/r51）误判"硬件不提供出厂累计通电时间"。用户提示"之前能精确查到每张显卡通电时间"，翻查 08-21 历史会话转录（`~/.dsh/sessions/**/session.jsonl.zstd` 用 python zstandard 解压检索）实锤——出厂真值一直可读：`nvidia-smi --query-gpu=bbx.time_run`（= `-q` 的 `Inforom Time Data → Time Run`，NVML `nvmlDeviceGetBBXTimeData`），是存于显卡 INFOROM 的终身通电计数器，断电不丢、逐卡独立、驱动 610.43.03 实测支持。
- **漏检根因（教训）**：首版用 `grep -iE 'hours|uptime|lifetime|power.on'` 检索 nvidia-smi 输出，而该字段名是 **"Time Run"**（`bbx.time_run`），一个关键词都没命中，于是错误地下了"硬件不提供"的结论。查字段存在性必须多名字变体 + 通读 `-q` 全文 + 翻历史会话，不能只信一轮关键词检索。
- 逐卡主值改为 INFOROM 出厂真值（power_on_basis=inforom）；wtmp∪journal 系统开机区间口径降为"系统口径对账"列，并显示 **出厂真值 − 系统口径 = 该卡来本机之前的通电时间**（>1 天才显示）。驱动不支持 bbx.time_run 时主值自动回落系统口径并标黄"系统口径"，绝不以缺省值冒充。
- 本机三卡出厂通电实测：GPU0=143.2 天 / GPU1=165.2 天 / GPU2=125.0 天（均为二手矿卡，来本机之前已通电 91~132 天）；整机系统口径 33.7 天不变（主板无出厂计数器，仍用开机记录口径）。
- 后端 uptimeRefresh 增加第三数据源 `gpuQuery(['--query-gpu=index,uuid,bbx.time_run',...])`（走 09-20 铁律放弃式熔断通道），upParseTimeRun 解析（N/A/0/非法值一律缺省不入库，宁缺毋假）；全源失败才保留上一帧。
- 回归：unit 48/0（+2：upParseTimeRun 正常解析含带单位列、N/A/0/垃圾行不冒充）；pages 22 场景 0 失败（真实载荷场景断言升级为出厂真值徽标 + 系统口径对账"之前 N 天"）；fixture 重抓线上真实帧（含 time_run_sec/system_power_on_sec/power_on_basis）。
- 卡内脚注固化勘误说明。回滚：deploy/{server.js,index.html}.bak-gpuuptime-1029-1743。

## 2026-10-29 [gpu-uptime-live 1029] 通电时间精度修复（已上线 .127，页面 r51）
- 用户实锤"时间没对，日期没准确，需要精确的时间"，三处根因一次修完：
- ① **实时尾段**：区间表 10min 一采，当前开机区间 end 钉在采样时刻——整机累计通电两次采样间冻结（最长 10min 偏差、越看越旧），"本次开机"因 `now-e<90s` 判据在每次重采 90 秒后直接显示 --。后端区间帧加 live_tail 标记，uptimeStatus 读取时把尾段延到 now（纯函数 upLiveIv 便于单测），逐秒实时。
- ② **本次开机起点精确化**：wtmp/journal 的 boot 记录是启动过程中写入的（比真实内核启动晚数秒，与 `uptime -s` 对照即见偏差）——改用 /proc/uptime 反推内核启动时刻（procfs 读取微秒级，同步可接受；macOS 开发机无 /proc 如实回落），线上验证 current_boot_since=16:22:10.4 ≡ uptime -s 16:22:10。
- ③ **显示精度**：时间戳全部带年份到秒（YYYY-MM-DD HH:mm:ss 手工拼接不受 locale 影响）、时长到秒；摘要新增「可追溯窗口 − 累计停机 = 通电」对账核算（window_sec/downtime_sec 后端直出）；逐卡首见口径带完整时刻；表格 DOM 重建指纹降分钟粒度防逐秒抖 DOM。
- 精度上限如实写进卡内脚注：历史每次开机记录点晚于真实上电/早于断电约 0.5~2min（BIOS 自检与关机流程无日志），累计误差量级≈开机次数×1min，硬件不提供真实通断电时钟，无法秒级还原历史。
- 回归：unit 46/0（+3 upLiveIv 三态：延尾/起点提前/非 live 原样）；pages 22 场景 0 失败（真实载荷场景断言升级：年份秒级时间戳、累计停机对账、本次开机非 --、秒精度时长；fixture 重抓线上真实帧）；线上 35s 双采样增量=35s 实锤实时累计。
- 回滚：deploy/{server.js,index.html}.bak-gpuuptime-1029-1743（同 r50）。

## 2026-10-29 [gpu-uptime 1029] GPU 累计通电时间（已上线 .127，页面 r50）
- 硬件监视页新增「GPU 累计通电时间」卡：整机累计通电时长、追溯起点、开机次数、本次开机已通时长，逐卡（GPU0/1/2）按 UUID 列出累计通电（天/时分双口径）、首见口径与在场状态。
- **口径铁律**：NVIDIA CMP/消费级卡的驱动与 NVML **不提供"出厂至今累计通电时间"**（10-29 实测 `nvidia-smi -q` 全文与 `--help-query-gpu` 均无该字段；ECC aggregate 是唯一 lifetime 计数但无时间轴），卡内如实标注，绝不让估算值冒充出厂真值。
- 可追溯口径 = **wtmp ∪ journal 开机区间并集**：`last -x -F reboot`（干净配对 end=关机时刻，still running 延到 now）∪ `journalctl --list-boots`（当前 boot 延到 now），60s 容差合并去重叠；逐卡 = 区间 ∩ [UUID 首见, now]，首见持久化 gpu-uptime.json（模块首跑在场的卡按追溯起点计=coverage，此后新 UUID 按实测计=observed——换卡新卡从换卡时刻起算，旧卡保留历史标「已离场」）。
- 上线当日实锤修复**时钟漂移虚增**：该机 BIOS RTC 曾复位，NTP 同步前写入的 boot 记录带假时间戳（"Thu Jan 1 08:17:32 2026 - Sun Sep 20 16:20:12 2026 (262+08:02)" 一行虚增 262 天，整机通电从 33.7 天被抬成 294 天）——以 `wtmp begins` 行作下限钳制区间起点（钳出窗口与同期真实开机重叠，合并后几乎无误差）；并强制 `env LC_ALL=C` 跑 last/journalctl（systemd 服务环境带 LANG=zh_CN 时星期/月份名翻译会让解析器静默失效）。
- 后端 [gpu-uptime 1029] 模块：GET /v1/internal/gpu-uptime（只读，无 POST）；采集走放弃式 spawnCollect（countFail=false 不连坐 GPU 熔断，ll 直读零提权零 nvidia-smi），启动即刷 + 10min 重采 + 60s 在场跟踪（脏才写盘，tmp+rename 原子替换）；两源同时无数据保留上一帧（宁旧勿空，10-07 教训）；缺失一律 null 不以 0 冒充。
- 前端卡 30s 轮询（hidden 门控）+ 指纹防 DOM 重建；错误态黄字透传不静默。
- 回归：unit 45/0（新增 6 项：wtmp/journal 解析、容差合并、∩求和、两源并集不重复计、漂移钳制含 floor=0 回落）；pages 22 场景 0 失败（新增通电卡真实载荷渲染 + gpus=[] 空态 2 场景）；fixture gpu-uptime.json 为线上真实抓取。
- 线上验证：追溯起点 09-19 07:32（=wtmp begins）、整机通电 33.7 天（40.4 天窗口扣 ~6.8 天停机，与夜间关机/重启风暴实况吻合）、boots 218、本次开机 16:22 与 uptime -s 一致、三卡在场 coverage；重启 dsh-console 引擎 pid 不变（引擎属 fnx-18420-watchdog cgroup）。
- 回滚：deploy/{server.js,index.html}.bak-gpuuptime-1029-1743 + 删 deploy/gpu-uptime.json。

## 2026-10-27 [client-ips 1027] 调用方 IP 与归属地（已上线 .127，页面 r49）
- 新标签「调用方 IP」：显示谁在调用模型 API——IP、网络类型（内网/回环/公网）、归属地（国家/省市/运营商）、模型调用数、探活数、最近活跃时间、来源（直连引擎/经控制台代理），行展开看路径明细与状态码分布。
- 数据源两路合并：①引擎访问日志增量 tail（uvicorn 行，覆盖直连引擎端口的全部调用方；日志行无逐行时间戳，lastSeen=控制台观测时刻 ±3s；首次运行从日志尾 ≤4MB 回填计数标「历史」；日志文件跟随 getVllmLogSource argv/fd 判据链并缓存 30s，fallback/docker/tty 来源不解析防陈年日志冒充）②控制台 /v1 代理入口记真实客户端 IP（引擎侧只见 127.0.0.1；代理生成请求 pending 对账去重不双计）。
- 归属地：回环/私网/CGNAT/链路本地走本地规则不外查；公网 IPv4 走 ip-api.com 中文批量解析（≤50/批、7 天缓存、失败退避 10 分钟）；IPv6 公网如实标「免费库不解析」。
- 后端 [client-ips 1027] 模块：GET /v1/internal/client-ips、POST .../cmd {clear|save}（口令拦截同规）；配置 client-ips.json 热加载（activeWindowSec/retentionDays/maxIps/geoEnabled）；计数落盘 client-ips-state.json（重启不丢），归属地缓存 client-ips-geo.json；前端页 static/client-ips.html（iframe 懒加载口径同 crash/compute，自愈轮询）。
- 同窗上线 10-17 遗留的 kvoff-simple-metric 后端段（simple_kv_offload_* 指标族，前端 r46 已双态兼容）；并按「线上为基线」把 10-22 的 restore160/kvoff96-fix/heapoffload-guard 三处线上独有改动补入库（分叉清零）。
- 部署验证：重启 dsh-console 后引擎 pid 15012 未变（引擎属 fnx-18420-watchdog cgroup，控制台重启不连坐）；线上回填即抓到 192.168.1.36（6324 次模型调用·内网）与公网 IP 110.184.28.37（1 次 chat 调用→解析为 中国 四川 成都·Chinanet）。
- 上线当日实锤修复：`POST /v1/messages/count_tokens`（控制台为 SGLang 预填充进度自发引擎的辅助计数调用）原被 `/v1/messages` 前缀误归 model 类，会**劫持代理 pending 对账**（count_tokens 先落日志消耗掉 pending，真实 chat 回环行漏跳 → 127.0.0.1 虚增模型调用）；已单列归 other。回归=受控实验「一次代理请求：127 model 不涨、真实客户端 IP +1、pending 归零」。
- 回滚：deploy/{server.js,index.html}.bak-cip-1027-<ts> + 删 static/client-ips.html。

## 2026-10-25 [gpu-powerlog 1025] GPU 高功耗记录（已上线 .127，页面 r48）
- 硬件监视页新卡：任一张 GPU 功耗 ≥ 阈值（默认 300W 可配）即记越阈快照——各单卡功耗 / GPU 合计 / 当时整机估算总功耗（与能耗页同口径，采样未就绪记 -- 不冒充 0）/ 利用率 / 温度 / SM 频率。
- 判定复用 1s GPU 采样帧（零新增 nvidia-smi 压力，盲态 >15s 不判定）；同卡去抖 minIntervalSec（默认 5s）防洪泛；落盘 gpu-power-log.jsonl（重启不丢，环形 maxRecords 摊还截尾）；配置 gpu-powerlog.json mtime 热加载、缺省启用。
- API：GET /v1/internal/power-log（状态+最近 120 条），POST .../cmd {save|clear}（口令拦截同规）。
- 部署 = 线上基线 + 本模块（diff 审清：线上含 10-22 OOM 加固、本地 kvoff-simple-metric 段仍未上线未混提）；回滚 deploy/{server.js,index.html}.bak-powerlog-1025-<ts>。
- 线上实测：60W 降阈造测即出真实快照（GPU0 130W/GPU1 180W/GPU2 39W、GPU 合计 349.6W、整机 503.7W），复原 300W 后保留。

本文件记录对外发布的版本变更。版本号遵循语义化版本，标签形如 `v1.0.0`。

---

## v1.1.0 — 2026-10-16

自 [v1.0.0](#v100--2026-10-07) 以来的第二次正式发布：**46 次提交、71 个文件、+8168 / −685 行**。页面版本戳 `20261016-r45`，与生产环境（受管机 8889 控制台）逐字节一致。

### 本版亮点

- **三个新标签页**：「崩溃记录」（引擎每次崩溃的时间+根因+证据原文，独立守护进程 crash-watch.mjs 零重启接入）、「卡算力」（逐卡理论峰值 FP32 双口径 / 实时估算 TFLOPS / Tensor 参考 / 频率达成率 / 功耗墙限频原因 / 5 分钟曲线，零后端改动）、「⚙ 设置」（勾选要显示的标签，localStorage 仅本浏览器生效）。
- **并发请求显示推倒重建（conc-v2）**：固定槽位板 + rid 身份链，行数恒等于 max-num-seqs，根治「4 并发显示 14 行」「一行变多行」十年老形态；实时测速 v3.1 修复并发稀释（0.2 tok/s 假值）。
- **GPU 安全与运维**：nvidia-smi 统一放弃式查询通道 + 熔断（09-20 铁律的控制台落地，超时值按线上实测定档）；GPU 高温自动关机守护（迟滞/盲态不判定/全屏倒计时可取消）；GPU 功耗/频率调节（gpu-ctl 白名单提权 + pl 联动开机持久化 drop-in）。
- **引擎稳定性**：rt-patch #14 实锤修复「160G 二级缓存六崩」（官方 SimpleCPUOffloadConnector load 路径缺 compute-done 跨流屏障，上游 PR 未合并只能运行时补丁）；看门狗 tier-keep 保留档策略（连崩 ≥3 次才剥档）。
- **换装机适配**：EPYC 7F52 + H12D-8D + 3×CMP 170HX 64GB + 32GB 内存（cpu-ctl v3 跨平台 boost/no_turbo 双通道、k10temp 回落、封装温度与 CPU 缓存双口径修复、主端口自愈三层防御）。
- **Strata 监控**：电源控制卡（WOL 魔术包唤醒 / 远程关机 / 启动脚本，经 .127→.38 SSH 链）。
- **仪表盘停刷根治（r18）**：stats 350ms 结果缓存 + 并发卡独立心跳盖章 + PD 曲线 500ms/EMA/贝塞尔平滑。
- 修复开源发布混入的调试残留（每次刷新 700ms 后自动跳「硬件监视」标签）。

### 明细（按日期）

---

### 2026-10-16 卡算力标签 + 标签显示设置（页面戳 20261016-r44/r45）

- **「卡算力」标签**（`static/compute.html`，零重启零后端改动）：数据全复用只读接口 `GET /v1/internal/gpu`（静态规格+1s 采样合并帧）+ `GET /v1/internal/gpu-ctl`（clocks_event_reasons 限频位/显存频率）。逐卡展示理论峰值 FP32（**双口径**：芯片表档 @clocks.max.sm 系统性偏高 vs 观测加速档=会话实测频率顶）、实时估算算力（峰值×频率达成率×利用率，页脚固化「利用率≠数据通路占用」警示）、Tensor 参考（GA100 倍率 TF32 8×/FP16 16×/INT8 32×）、5 分钟算力曲线。轮询纪律按 09-23/09-25/10-03 铁律（自建超时/finally 续排/失败保帧/后台门控）。
- **「⚙ 设置」标签显隐**：导航最右齿轮弹窗勾选 13 个标签的显示，存 localStorage `consoleHiddenTabs` 仅本浏览器生效；隐藏=导航项 display:none（内容与已加载 iframe 不动），激活标签被隐藏自动切首个可见，至少保留一个防自锁；`switchTab` 高亮从 DOM 序号 map 改 `data-tab` 查找（新增标签免维护）。
- 快启 standard 档固化 512K 上下文[512k-reg-1016]：w8a8 新建 YaRN×2 配置副本注册。
- 验证：真实线上载荷渲染仿真、unit 39/39、pages 17 场景 0 失败（compute.html 新增 3 场景）。

---

### 2026-10-14 并发请求显示机制重构（固定槽位板 + rid 身份链）

- **并发请求卡改为固定槽位板**（用户方案）：行数恒等于引擎 `max-num-seqs`（每实例独立，`model-params` 真值 30s 缓存），每个 vLLM 请求按 rid 装配进槽位——先占先得、存续期槽号不变、结束（>1.5s 无数据）释放；空槽显示「槽位 N · 空闲」占位行。行数从结构上不可能再随后端行集抖动超发（此前实测 4 并发显示 14 行）。
- **输出速度直接嵌入槽行**（Strata 监控 Speed 卡版式）：每行双列大数字——Decode（本行实时 → 全程均值 → 上一显示值 → 分摊兜底，标签标明口径，与「GPU 排队·处理」卡同源）+ Prefill（未缓存 prompt ÷ 预填充耗时，同 Strata `(prompt−reused)/prompt_ms` 式）；行内实时曲线改用引擎真值 `tokens_generated` 逐拍 Δg/Δt 采样（500ms/点、窗 15s、贝塞尔平滑），rid 键跨行轮换连续不断线。
- **前端推倒重写为单一「请求注册表」模型**（conc-v2）：清空十轮叠加的行位固定/缺席保持/封顶/缓存补丁层；空闲态显示「上次请求 Decode/Prefill」实测（Strata 空闲口径）。
- **后端两处总根源修复**（需控制台重启，已做且引擎进程无恙）：① v3 激活时行↔rid 绑定稳定化（活跃 rid 行永不退绑、最近邻重绑仅限从未绑定行、容差 30s→10s、行数权威=注册行）——真实配对采样实锤此前绑定每拍错位；② 幽灵 rid 封死（引擎完成行携裸 rid、进度行携 -8hex 后缀 rid，后缀序列永等不到完成标记、滞留活跃集 30s 被放大成虚高行数；现完成行联动标记兄弟序列 + 活跃集 8s 新鲜度过滤）。
- 验证：conc-v2 仿真 V1~V12、真实 stats 逐帧回灌 0 重复行、8 路突发负载压测行数贴合物理上限、unit 39/39、pages 全场景回归 0 失败。线上回滚备份 `server.js.bak-ridstable-1014` / `server.js.bak-ghostdone-1014` / `index.html.bak-pre-concv2-1014`。

---

### 2026-10-11 二级缓存 160G 崩溃根因修复（rt-patch #14，引擎已带补丁运行）

「修复崩溃 bug」深挖闭环：六崩根因**不是** CPU 池越界（#13 握手 clamp 在位，4194→3355 生效），而是官方 vLLM 0.31 `SimpleCPUOffloadConnector` 的 **load 路径缺 compute-done 跨流屏障**——请求结束释放的 GPU 块立即复用给异步 CPU→GPU load 时，compute stream 上先前排队的 kernel（MTP 投机步）仍在读该块，DMA 写与计算读并发 → 索引/元数据行读出一半垃圾 → 后续 kernel 越界（Xid 13 illegal memory access，恒由最后一个 PP stage 报出）。上游同案实锤：issue #59768（Qwen3.8-Flash-Next 同栈同签名）、#47282，修复 PR #47324/#60078 **均未合并**——升级 release 无效，必须运行时补丁。

- **rt-patch #14**（`vllm-0310/patches-extra/dsh_simple_offload_rt.py`）：钩 `SimpleCPUOffloadWorker.start_load_kv`——提交 load 前在 compute stream record **专用** event（独立于 store 的 `_store_compute_done`，防两提交点互相 re-record 漂移），经 `launch_copy(wait_event=…)` 交给 DMA 后台线程（`stream.wait_event` 机制现成，与 store 路径对称）。开关 `DSH_SIMPLE_WAR_SYNC=0`。验证三连：生产 venv 真实类 `__dict__`+`inspect.getsourcefile` 归属断言 / 假 torch 语义仿真（wait_event 传入+record 时序）/ 引擎启动日志四 worker 全挂线 + clamp 4194→3355 复现。
- **量化佐证**：PP2 每块 16.27MiB vs PP0/1 13.02MiB（MTP draft KV 在末 stage）——池不一致方向差 25%，clamp 后仍崩 → 排除池越界路径，锁 WAR 竞态。
- **恢复 160G 生产定版**：launch.env `FN_SIMPLE_OFFLOAD=160` + quickstart standard 档回 `kvoff=simple/160`（关缓存档降为 A/B 对照）。watchdog 崩溃计数已清零，自愈首拉即带档。
- **crash-watch 防误报增强**：CLEAN_STOP 特征补 `Waiting for application shutdown / Shutting down / engine client stopped`（手工 stop 优雅停机的尾行曾被记成 PY_FATAL/ENGINE_DEAD 假崩溃）；CLEAN_STOP 判定任何来源一律不入库。
- **运维新坑（本次自触发实锤）**：①`start-flash-next-0310.sh` **裸调**（调用方 shell 无 FN_*）会把 launch.env **重写为空**（复读链清零，inner 落内置缺省）——手工带档启动必须先 `set -a; . launch.env; set +a`；②watchdog 安全模式剥档经 wrapper 落盘会把降级**持久化**（00:12 那次 160→无档就是这么来的）；③重启链上 `python /tmp/x.py` 的 sys.path[0]=/tmp，验证补丁文件务必先部署到 patches-extra 再跑。
- 上线时序：00:25 引擎带 #14+160G 重启就绪（init 26.7s，health 200，冒烟推理正常）；观察判据 = 崩溃记录页零新增 ILLEGAL_MEM + `kv_offload_ports` 有值。

---

### 2026-10-10 崩溃记录标签（页面戳 20261010-r22）

新功能：控制台新增「崩溃记录」标签，记录 **vLLM/SGLang 引擎每次崩溃的时间与根因**（含证据原文），并回填上线前的历史崩溃。

- **架构（零中断设计）**：不改 server.js、**不重启 dsh-console**（vLLM 在其 cgroup 内，重启连坐引擎）。新增独立守护进程 `crash-watch.mjs`（systemd --user `fnx-crash-watch.service`，ll 身份，Nice=10），把记录写成 `static/crash-records.json`（/static/ 路由每请求读盘），前端独立页 `static/crash.html` 走「iframe 懒加载」接入（口径同 bench/cpu 标签）。
- **检测四路**：① model-manager 实例快照连续两轮缺席 + `/proc/<pid>` 校验 = 进程消失；② 看门狗日志 `fnx-*-watchdog.log`「确认离线」行（18420 最权威的精确时间戳）；③ dmesg OOM Killer / NVRM Xid（±6min 窗口归因）；④ 同端口 pid 突变（重启太快 API 不断档的补漏）。**抑制误报**：server.log 启停事件增量解析——人工停止（script-model/quickstart/pd-stop/hotshield）600s 内、控制台重启连坐 300s 内的离线不记崩溃；API 不可达时保留快照不判缺席。
- **根因签名**（11 类，specific 优先）：CUDA OOM / 非法内存访问 / NCCL 超时 / 段错误 / 断言失败 / 磁盘满 / CUDA 驱动 / EngineDead / Worker 死亡 / Python 异常 / 终止信号；日志选取沿用 10-05 判据（祖先链 cmdline 的 .log token，root 进程 cmdline 全局可读）；时间戳自 vLLM 行内 `MM-DD HH:MM:SS` 解析、跨年回退。看门狗「拉起/安全模式」行给记录附「已自动恢复/已降级拉起」备注。
- **历史回填**（首跑一次）：全量扫 `fnx-*-watchdog.log` + `vllm*.log`（≤300MB 流式，SIGNAL_TERM 不建事件防吞真因）+ dmesg，同端口 ±3min 归并、根因按具体度择优、ts 取更早者（崩溃时刻先于离线确认时刻）。
- **前端**（crash.html）：KPI 四卡（总次数/近7天/最近一次/最高频根因）、端口/原因/来源筛选 + 全文搜索、证据原文折叠、徽章按根因上色；遵守 09-23/09-25/10-03 铁律（自建 AbortController 超时、失败保留上一帧不清屏、轮询链 safeRun、回前台补帧）。
- **验证**：本地用线上真实日志（watchdog 116KB + vllm 日志尾部样本）重放回填——10-10 18:35 那次真实崩溃正确归因 ILLEGAL_MEM(port=18420) 并与看门狗离线合并附拉起备注；渲染仿真 84 条无异常；上线前后内联 JS node --check 全过。
- 新增文件：`crash-watch.mjs`、`crash.html`（部署为 `static/crash.html`）、`systemd/fnx-crash-watch.service`。

---

### 2026-10-09 GPU 高温自动关机守护（页面戳 20261009-r21）

新功能：任一张 GPU 的核心/显存温度 ≥ 阈值并持续一段时间后，控制台**自动停止全部推理实例并关闭本机**（防散热失效烧卡）。

- **后端 `[gpu-hotshield 1009]` 模块**（server.js）：判定复用 GPU 采样器 `global.__gpuLive`（1s 异步通道，09-20 铁律，不新增 nvidia-smi 压力），口径 = 各卡 max(核心温度, 显存温度)。防误触发三重：迟滞（回落到 阈值−2°C 才清计时）、`holdSec` 持续达标才行动、`graceSec` 关机倒计时（降温/数据盲态>15s 自动取消，可手动取消）；`cooldownMin` 防「关机→开机→仍热→再关机」振荡。触发流程 = 先优雅停 vLLM/SGLang 实例（脚本化模型走各自 stop 脚本、其余走 stopVllm，整段限时 45s 超时直达关机）→ `gpu-ctl halt`。
- **API**：`GET /v1/internal/hotshield`（配置+实时状态+事件历史，1s 轮询）、`POST .../cmd` `{action:save|cancel}`（参数钳位 40~105°C / 5~3600s / 0~600s / 0~1440min）。配置 `gpu-hotshield.json` mtime 热加载、缺省 **enabled=false**；状态与最近 50 条事件落 `gpu-hotshield-state.json`。
- **提权链扩展**：`gpu-ctl` 新增 `halt` 子命令（root：写 /run 关机原因 → sync 限时 8s → systemctl poweroff；刻意不走 nvidia-smi 通道，驱动 D 状态时仍可执行），sudoers 白名单（固定路径全参数）天然覆盖，无需改装。
- **前端**（硬件监视页「GPU 高温自动关机守护」卡）：开关（带确认弹窗防误触）、四项参数编辑、状态瓦片（运行中/持续计时/倒计时/冷却中/正在关机五态）、触发历史列表；**倒计时全屏红色脉冲横幅在任何标签页顶部可见**（1s 刷秒数 + 取消按钮），并有跨标签 BroadcastChannel alert 兜底提醒。
- **验证**：node 逻辑仿真 12 场景（触发/迟滞/降温取消/盲态取消/冷却/grace=0 直达关机）+ 前端 mock 仿真 7 场景（横幅生命周期/事件历史 XSS 转义/空字段不崩）+ tests/unit 39 项、tests/pages 14 场景全过；线上冒烟 save/非法参数/cancel 三路径 + 页面版本戳 r21。
- 线上回滚：`/home/ll/deploy/{server.js,index.html}.bak-hotshield-1009-2143`、`/usr/local/bin/gpu-ctl.bak-hotshield-1009`。

---

### 2026-10-05 基准测试·预填充档位扩到 1M（bench 2.3.0）

「基准测试 → 预填充」原来只给 5 个档位（1K~64K）、服务端还把 >128K 的档位一刀切掉。现按受管实例的真实上下文（1M = YaRN×4）放开档位并加固长档测试。

- **档位 1K → 1M 共 11 档**（1K/2K/4K/8K/16K/32K/64K/128K/256K/512K/1M），另可**手输自定义档位**（256~1048576，加出来的档带 `×` 可删、自动按长度插位）；开测前给预计耗时提示（按 4700 tok/s 粗估，1M×3 轮 ≈ 12 分钟起步）。
- **服务端档位边界 256~1M**（`PF_MIN_TOKENS`/`PF_MAX_TOKENS`），并以配置快照里的**引擎真实 `max_model_len` 再收一道**：非法/超 1M 的档、超引擎上下文的档分别在事件流点名原因后跳过，不再静默丢档；一上来就把整轮打死的情况消除。
- **单档失败不再中断整轮**：某一档 400（超长、KV 池放不下、引擎重启）时记下 `rec.error` + 跳过该档剩余轮次，继续测后面的档；汇总表/详情页把失败档点名显示，`final.failed` 回传失败清单。
- **顶格档按引擎上限留 1.5% 分词余量收口**（`charCap`），避免"照着 1M 凑字符、实际分词超了一点点 → 白跑三百多秒"。
- **1M 档材料构造改写**：逐段拼接（3 万次）改为「8 段材料按 variant 轮转成 unit + 倍增复制」，2.8M 字符 1ms 完成（快 5 倍），首段仍随轮次/档位变化 ⇒ 前缀缓存依旧命不中。
- **显示口径**：`fmtK` 支持 M（1048576 不再显示成 1024K）；TTFT ≥10s 自动换成秒（`fmtTtft`，1M 档 223456ms → 223.5 s）。
- 补丁落点 `patches/patch-prefill-tiers-1005.py`（幂等、自动备份、`node --check` 把关）；验收＝假引擎端到端仿真 17 项（跳过/收口/容错/汇总语义）+ 前端 node mock 仿真 + 线上 1K/8K/128K 实测冒烟。

---

### 2026-10-05 换装机适配（页面戳 20261006-r14）

受管机（ll-desktop）换装：Intel E5-2696 v4/X99/双卡/64GB → **AMD EPYC 7F52 16C/32T + HUANANZHI H12D-8D + 3×CMP 170HX + 32GB**，内核回原生 5.15.0-139，控制台地址随之变为 `http://192.168.1.126:8889/`。

- **server.js 主端口自愈三层防御**：6s 定时兜底重探（`maybeReDetectBackend`）、ticker `busy`>15s 强制放行、`/v1/internal/stats` 空数据触发纠偏。修复换装开机时序竞态导致的「引擎在跑、`/metrics` 直连 200、仪表盘却恒 `{}`、代理打 8000」整页假死。
- **`SCRIPT_MODELS.base` 与快启预设按 32GB 内存账重固**：`pp:3`、二级缓存关（96/100GiB 档在 32GB 机必 OOM，降级为〔旧机档〕）、PLE 唯一可行档 INT8+disk；新 standard 档 `current-pp3-1m-mtp4-int8disk-32g` 逐键复刻 10-04 实跑实例（验收＝线上 `scriptModelLaunchPlan()` 输出与 `flash-next-w4a16-launch.env` 全键 diff 为零）。
- **cpu-ctl v3 跨平台化**：睿频通道自适应（`intel_pstate/no_turbo` ⇄ `cpufreq/boost`，语义自动反转）、温度自适应（coretemp 逐核 ⇄ k10temp/zenpower 封装级回落）、平台/机型串运行时生成，去除 X99/E5 硬编码；`cpu.html` 标题、睿频文案、逐核温度（缺逐核传感时显示封装温度带 `*`）同步适配。
- **启停脚本安全整改落地线上**：`start/stop/watchdog` 切换到 `lib/sudo-pass.sh` 口令链路（`~/.console-sudo`，600），受管机上的明文口令版本就此替换；watchdog 合并保留线上领先的栈路由逻辑。
- **文案卡数自适应**：「启动双卡/两卡合计/PP 双卡」等措辞改为全部卡/跨卡合计/PP 多卡；GPU 功耗与采样链路实测三卡全自动纳管（`gpu-ctl` 三卡 210W、能耗页「3 卡合计」）。
- `ops/` 脚本与文档的目标机指向 192.168.1.126。

---

## v1.0.0 — 2026-10-07

自 [v0.9.0](#v090--2026-09-23) 开源首发以来的首次正式发布，收录生产环境连续运行十余天沉淀下来的全部改动：**44 次提交、45 个文件、+11765 / −724 行**。页面版本戳 `20261006-r13`。

本版包含一项**安全相关变更**（见下节），并从 git 历史中移除了此前误提交的明文凭据——升级方式与其他版本一样是一次 `git pull`，但请务必读完「安全」一节。

### ⚠️ 安全：运维脚本不再含明文 sudo 口令

**问题**：`start-flash-next-w4a16.sh`、`stop-flash-next-w4a16.sh`、`fnx-18420-watchdog.sh`、`tools/gpu-ab-offset.sh`、`tools/postpower-diskcheck.sh` 等脚本里硬编码了形如 `echo <口令> | sudo -S` 的明文 root 口令。仓库是公开的，这等于把受管机器的 root 权限随源码一起发出，且明文已经进入 git 历史。

**现在的做法**：新增 `lib/sudo-pass.sh` 作为唯一的凭据入口，按优先级取口令，三者皆无则**直接报错退出**（绝不静默拿错口令去试）：

1. 环境变量 `CONSOLE_SUDO_PASS`
2. 文件 `${CONSOLE_SUDO_FILE:-~/.console-sudo}`（取首行，权限非 600 会提示）
3. 交互式输入（有 TTY 时）

```bash
umask 077 && printf '%s\n' '<你的sudo口令>' > ~/.console-sudo
```

细节与几处刻意的设计取舍（都做过实测，改动前请先读注释）：

- **无口令时自动回退裸 `sudo`**：对本机已配 `NOPASSWD` 白名单的用户（`cpu-ctl` / `gpu-ctl` 就是这条路数）零负担。
- **看门狗容灾**：`fnx-18420-watchdog.sh` 跑在 systemd user 定时器里，取不到口令时**只关闭「卡死取证」**（`py-spy dump` 需要 root），探活与自愈拉起照常工作；同时禁用交互式兜底，避免在无 TTY 环境堵在读输入上。
- **`sudo_run` 不注入 `-p ''`**：否则调用方自带的 `-p ''` 会变成重复参数，多出来的那个 `-p` 会把紧随其后的命令名当成提示语吃掉——表现为命令静默不执行。
- **不对口令做裁剪**：首尾空格可能就是口令的一部分。只对口令文件剥行尾 CR（兼容记事本保存的文件）。
- **凡是穿过 GNU `timeout` 的提权**（`timeout` 以 `env -i` 起子进程，父 shell 的函数与普通变量都过不去，bash < 4.3 甚至不支持导出函数；也别用 `timeout ... NAME=val cmd`，那个赋值前缀会绑到 `timeout` 自己身上并被当成命令名而直接报错），改用 `sudo_run_quoted`，借助 `printf %q` 把口令烤成命令串字面量。已针对含空格、单/双引号、`$`、反引号、`;()`、反斜杠等八类对抗性口令做**逐字节送达校验**。

**给老用户的提醒**：如果你在 v0.9.0 时代 clone 过本仓库，请把那时脚本里的口令视为**已经泄露**并尽快在受管机器上改密。

### 新增能力

#### 逐请求实时测速 v3（推翻旧架构）

并发面板的每行 tok/s 换成引擎真实的每步输出真值流。原先的做法是用 `/metrics` 的聚合直方图反推个体（驻留估计并发、总吞吐除以在跑行数），这在数学上不成立：各行恒定同值、整体滞后，行与请求的归属全靠到达时间猜。本版改为在引擎侧 hook `IterationStats.update_from_output`，逐 token 落盘 `vllm-live-stream.jsonl`，控制台按 `request_id` 维护各自的滑动窗口速度与真实首 token 时刻。

- 数据来源全部是官方现成字段（`output.request_id`、`req_stats.num_generation_tokens`、`arrival_time`），不额外造轮子。
- 验收金标准：与 `request-traces.jsonl` 记录的 `decode_tps` 全程均值对照，实测 65.2 = 65.2。
- 无插件的实例（SGLang、远端服务）自动降级到 `v2-hist` 分摊口径并在界面上标明来源，不与实测值混淆。
- 配套三轮尖峰治理：回放旧行整行丢弃、接管观测窗从实际观测点起算、碎窗钳制，根除「开局上千 tok/s」的假峰值；另有 skew EWMA 哨兵兜住时钟异常。
- 降级总闸：`DSH_STREAM_RT_DISABLE=1`。

#### SGLang 全链路适配

从只支持 vLLM 扩展到 vLLM + SGLang 双引擎：脚本栈参数走独立的 `SG_*` 下发链、实例按运行时归因、投机解码 gauge 单独解析，并新增彼此独立的引擎监控页 `/vllm.html`、`/sglang.html`。

#### KV 二级缓存可观测性

- 新增聚合接口 `GET /v1/internal/kv-detail`：连接器类型、容量、tmpfs 物理驻留、命中率、累计存入/取回、6 秒滑窗速率、整机内存压力。
- vLLM 标签页的详细二级缓存卡（进度条 + 四张明细表），仪表盘那张卡改为常驻三态（已启用 / 未启用 / 引擎离线），不再“没数据就整卡消失”。
- 驻留主值改用 `statfs('/dev/shm')` 求得——新版引擎不提供驻留量 gauge，而这条路既不需要 root 也不用 spawn 进程。
- 命中维度补上 `external_prefix_cache_queries/hits_total`，与 `prompt_tokens_by_source` 互补，可以区分「缓存建了但没命中」和「根本没启用」。
- 指标口径兼容性：旧栈（自研镜像 + kvfill 补丁）的 `kv_offload_cpu_cache_fill_perc` 与新栈上游的 `kv_offload_cpu_cache_usage_perc` 都能识别，并明确二者含义不同（后者是被在飞传输钉住的比例，空闲恒 0，**不等于驻留占比**），界面按 `metricKind` 分别标注口径。

#### 硬件与调优

- **GPU 功耗 / 频率调节卡**（硬件监视页）：设功耗上限、锁定/解锁 SM 频率，提权走 `gpu-ctl` + sudoers 固定路径白名单，`nvidia-smi` 全部 `timeout` 包裹。设功耗成功后**自动联动开机持久化**（写 systemd drop-in），避免“重启被打回默认值”这一常见坑。
- **GPU 显存温度**全链路显示；SM 数量改走 CUDA 属性直读 `cuDeviceGetAttribute(MULTIPROCESSOR_COUNT)`——先前按 NVML 核数折算有两重错误（GA102 每 SM 是 64 核而非 128，且 NVML 的核数字段是固件静态表，不随 SM 重配置变化）。
- **CPU 控制标签页**：X99-T8 / E5-2696 v4 平台定制版，逐核上下线、睿频开关、锁频（自动记忆原值可一键还原）、调速器、逐核温度与体质测试。全部是运行时写 sysfs 的软控制，重启回到 BIOS/内核默认。
- **CPU 核心上下线脚本** `ops/cpu-cores-127.sh`：同构核机器上按编号精确关停半数物理核的实验工具。

#### 可靠性工程（本版重点之一）

三处“页面看起来还活着、数字却已经定格”的顽疾被根除，方法论值得记下：

- **仪表盘停刷**（前端自愈准则）：停摆看门狗的判据只能取“渲染是否推进”，绝不能取“请求是否成功”——并发卡片有一条每 500 ms 独立拉数的旁路，它以请求为准就会被持续成功的旁路永久掩盖主链停摆。此外前端超时不能用 `AbortSignal.timeout()`：标签页被浏览器节能冻结后，解冻时 pending fetch 常被网络栈直接丢弃，既不 resolve 也不 reject 也不派发 abort，await 永不 settle。必须自建 `AbortController + setTimeout` 并在 settle 时清定时器。回前台要同时接 `visibilitychange`、`pageshow`、`focus`、`online`——只挂 `visibilitychange` 正是"必须刷新才恢复"的缺口。
- **后端端口横跳导致整页假死**：探不到后端进程时原先硬回落 `return 8000`（那里并没有监听），于是模型重启窗口会触发端口自愈把主端口横跳过去，`stats` 返回空对象 `{}`，而前端只挡 `!s` 挡不住 `{}`。改为探不到就返回 `null`、由调用方保持现状。**教训：任何“探不到就返回缺省值”的兜底，都可能被上层自愈机制当成真值。**
- **监控页误报「无运行中实例」**：两层根因缺一不可。后端为了取一个 `metadata.total_size` 把 34 MB 索引文件整份 `readFileSync + JSON.parse`（实测单次 267–390 ms，还被多处重复调用），同步按住事件循环，密集请求下甚至响应体截断；前端 `catch(() => null)` 之后把“取数失败”渲染成“没有实例”。修法是分块读到目标字段即停 + 两级缓存，前端把空态拆成三态（取数失败保留上一帧并标"上次成功"、本运行时实例消失要有 6 秒宽限期、从未有过才是正常空态）。
- **看门狗误判**：主进程死亡后 `setproctitle` 改名的 worker 成为孤儿，仍然匹配 `^VLLM::`，令旧版误以为“实例还活着”而静默不自愈（实测拖延 12 分钟，期间两个孤儿 worker 占着 126 GB 显存）。进程判据收紧为只认主 APIServer。
- **参数三跳静默失效**：脚本化模型的弹窗参数要走 `scriptModelLaunchPlan()` → 启动 wrapper 落盘 → chroot 内层 source 三跳，任何一跳漏键都会彻底静默失效（`sudo env_reset` 之下只有落进 env 文件的键能进 chroot）。启动 wrapper 的手写白名单改为动态扫描全部 `FN_*`，此后新增参数键不必再来改表。
- **前端脚本静默瘫痪**：一处分号/括号错误能让整页 JS 失效而 HTTP 仍返回 200。确立上线前铁律：提取"将要上线的那个文件"的全部内联 `<script>` 跑 `node --check`，再对改动的模板片段做渲染仿真。
- **轮询链单点脆弱**：`bench.html` 曾把渲染和末尾 `setTimeout(poll)` 写在同一个 `.then` 里，渲染函数任何一次抛错都会吃掉重排句柄，轮询永久停摆且刷新后第一帧再撞同一个错（看起来就是"图表全空白"）。现为 `applyState` + `safeRun` 分段兜底 + fetch 失败重试。
- **换栈后显示判据失配**：引擎升级到官方 0.30.0 后，控制台里两处“按旧栈写死”的判据同时静默失配（二级缓存卡整卡消失、PLE 运行参数两行为空）。确立通用判障顺序：**引擎真实 cmdline → `/metrics` 里的指标族真名 → 接口字段是空数组还是缺字段 → 最后才看前端 filter**。

#### 基准测试增强

测试结果新增 `env` 配置快照（按引擎真实 cmdline 解析的运行参数、落盘的启动 env、模型与生成配置、GPU 功耗上限），历史详情页展示「配置快照」卡，A/B 对比新增「配置差异」表——避免拿两次参数不同的测量互相比较。另修复单流模式图表空白与时区显示问题。

#### 运维修护与工具

- `ops/build-tailwind.sh` 的目标机改为 `CONSOLE_HOST` 变量（控制台机是 DHCP 地址，历史上多次变更）。
- 新增 GPU P2P 通路探针与 NCCL transport 判决探针（拓扑 / 能力 / 实际带宽三层取证，零中断复用生产 NCCL 变量抓取 `via P2P/IPC` 判决行）。**判障备忘**：`/dev/shm/nccl-*` 有映射不能作为“走 SHM”的证据，走 P2P 时同样持有百 MiB 级 nccl shm 映射。
- 新增新旧推理栈回退脚本 `ops/switch-to-old-stack-1003.sh`，按"停净 → 置哨兵 → 预热页缓存 → 拉起"的干净顺序执行。
- 新增 prefill 速率实测工具 `tools/prefill_probe_strata.py`：发互不相同的长 prompt 破除前缀复用、`max_tokens=1`，再用多档长度差分扣掉固定开销得到边际速率。
- **prefill 速度双口径**：实算 `(prompt − cached) / prefill_s` 与表观 `prompt / prefill_s` 相差可达数十倍，后者只是高缓存命中的红利，不得当作算力依据。

#### 快启预设演进

默认档多次随生产实跑参数固化而来（逐键反推自引擎真实 argv 与落盘 env 双源核对，并用 `scriptModelLaunchPlan()` 离线复算 + `FN_DRY_RUN` 打印 argv 两种方式验收），并新增 TP2 张量并行档与抗复读档，旧档降级为 `legacy` 保留在下拉里以便回退。

### 修复（小结）

| 现象 | 根因层面 |
|---|---|
| 仪表盘开久停刷、必须刷新 | 前端轮询链无自愈；`AbortSignal.timeout` 在冻结标签页失效 |
| 整页数字变空 / 假死 | 后端探不到端口硬回落缺省值，`stats` 返回 `{}` 未被前端识别 |
| 监控页误报无实例 | 同步重 IO 拖垮接口 + 前端把取数失败渲染成空态 |
| 实例挂了看不出来 | 看门狗把孤儿 worker 当存活 |
| 弹窗改参数不生效 | 三跳链路白名单漏键，`sudo env_reset` 后静默失效 |
| 二级缓存卡 / PLE 行不见 | 判据写死旧栈指标名与日志格式 |
| 基准测试图表空白 | 轮询排程写在渲染同一 `.then`，抛错即断链 |
| GPU 信息全空、整机被拖死 | `execSync nvidia-smi` 对 D 状态无效会永久阻塞事件循环 → 全部改异步 + 熔断 |

### 已知限制

- 大量功能与原作者的硬件/路径强绑定（chroot 镜像、模型权重路径、CMP 170HX 魔改驱动、X99 平台的 sysfs 布局），他人复现需按需改造，详见 README「复现边界」。
- 官方 0.30.0 新栈缺少「当前驻留 KV 量」的 gauge，仪表盘的该项数值在非单实例场景下无法切分到某一实例。
- 每请求 prefill 进度在新栈仍无真值（需要补调度器侧 hook），实时预填充面板对新栈暂无数据。
- `server.js` 仍有 71 处 `execSync` / `execFileSync`（`pgrep` / `lsof` / `nvidia-smi` 等），高负载或 GPU 驱动异常时会短暂按住事件循环。GPU 采样这条最危险的路径已改为异步 + 熔断，其余仍是同步；由于首发时为 63 处，本版实际是**净增**（新功能带来的欠债），列为后续待清理项。

---

## v0.9.0 — 2026-09-23

开源首发：生产环境 8889 控制台线上运行版，页面版本戳 `20260923-r1`。

- 单文件 Node.js 控制台（零 npm 依赖），实时性能仪表盘、多实例启停管理、OpenAI 兼容代理、硬件监视、日志查看、移动视图。
- 集成基准测试 bench-console v2.2.1（MIT）：单流解码 / 并发档位扫描 / 预填充 TTFT 三种模式。
- 性能改造：请求入口 async 化 + 全局异常兜底、上游 `/metrics` 400 ms TTL 单飞缓存、gzip/ETag 白名单（流式代理路径禁压缩）、前端 `visibilitychange` 门控轮询。
- 弃用浏览器端 Tailwind JIT，改预编译 `static/tailwind-build.css`。
- 可选控制台鉴权：`console-auth.json` 存在即拦截 `/v1/internal/` 的 POST，5 秒热生效。
