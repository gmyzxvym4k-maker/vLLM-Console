# 更新日志

本文件记录对外发布的版本变更。版本号遵循语义化版本，标签形如 `v1.0.0`。

---

---

## Unreleased — 2026-10-10 崩溃记录标签（页面戳 20261010-r22）

新功能：控制台新增「崩溃记录」标签，记录 **vLLM/SGLang 引擎每次崩溃的时间与根因**（含证据原文），并回填上线前的历史崩溃。

- **架构（零中断设计）**：不改 server.js、**不重启 dsh-console**（vLLM 在其 cgroup 内，重启连坐引擎）。新增独立守护进程 `crash-watch.mjs`（systemd --user `fnx-crash-watch.service`，ll 身份，Nice=10），把记录写成 `static/crash-records.json`（/static/ 路由每请求读盘），前端独立页 `static/crash.html` 走「iframe 懒加载」接入（口径同 bench/cpu 标签）。
- **检测四路**：① model-manager 实例快照连续两轮缺席 + `/proc/<pid>` 校验 = 进程消失；② 看门狗日志 `fnx-*-watchdog.log`「确认离线」行（18420 最权威的精确时间戳）；③ dmesg OOM Killer / NVRM Xid（±6min 窗口归因）；④ 同端口 pid 突变（重启太快 API 不断档的补漏）。**抑制误报**：server.log 启停事件增量解析——人工停止（script-model/quickstart/pd-stop/hotshield）600s 内、控制台重启连坐 300s 内的离线不记崩溃；API 不可达时保留快照不判缺席。
- **根因签名**（11 类，specific 优先）：CUDA OOM / 非法内存访问 / NCCL 超时 / 段错误 / 断言失败 / 磁盘满 / CUDA 驱动 / EngineDead / Worker 死亡 / Python 异常 / 终止信号；日志选取沿用 10-05 判据（祖先链 cmdline 的 .log token，root 进程 cmdline 全局可读）；时间戳自 vLLM 行内 `MM-DD HH:MM:SS` 解析、跨年回退。看门狗「拉起/安全模式」行给记录附「已自动恢复/已降级拉起」备注。
- **历史回填**（首跑一次）：全量扫 `fnx-*-watchdog.log` + `vllm*.log`（≤300MB 流式，SIGNAL_TERM 不建事件防吞真因）+ dmesg，同端口 ±3min 归并、根因按具体度择优、ts 取更早者（崩溃时刻先于离线确认时刻）。
- **前端**（crash.html）：KPI 四卡（总次数/近7天/最近一次/最高频根因）、端口/原因/来源筛选 + 全文搜索、证据原文折叠、徽章按根因上色；遵守 09-23/09-25/10-03 铁律（自建 AbortController 超时、失败保留上一帧不清屏、轮询链 safeRun、回前台补帧）。
- **验证**：本地用线上真实日志（watchdog 116KB + vllm 日志尾部样本）重放回填——10-10 18:35 那次真实崩溃正确归因 ILLEGAL_MEM(port=18420) 并与看门狗离线合并附拉起备注；渲染仿真 84 条无异常；上线前后内联 JS node --check 全过。
- 新增文件：`crash-watch.mjs`、`crash.html`（部署为 `static/crash.html`）、`systemd/fnx-crash-watch.service`。

---

## Unreleased — 2026-10-09 GPU 高温自动关机守护（页面戳 20261009-r21）

新功能：任一张 GPU 的核心/显存温度 ≥ 阈值并持续一段时间后，控制台**自动停止全部推理实例并关闭本机**（防散热失效烧卡）。

- **后端 `[gpu-hotshield 1009]` 模块**（server.js）：判定复用 GPU 采样器 `global.__gpuLive`（1s 异步通道，09-20 铁律，不新增 nvidia-smi 压力），口径 = 各卡 max(核心温度, 显存温度)。防误触发三重：迟滞（回落到 阈值−2°C 才清计时）、`holdSec` 持续达标才行动、`graceSec` 关机倒计时（降温/数据盲态>15s 自动取消，可手动取消）；`cooldownMin` 防「关机→开机→仍热→再关机」振荡。触发流程 = 先优雅停 vLLM/SGLang 实例（脚本化模型走各自 stop 脚本、其余走 stopVllm，整段限时 45s 超时直达关机）→ `gpu-ctl halt`。
- **API**：`GET /v1/internal/hotshield`（配置+实时状态+事件历史，1s 轮询）、`POST .../cmd` `{action:save|cancel}`（参数钳位 40~105°C / 5~3600s / 0~600s / 0~1440min）。配置 `gpu-hotshield.json` mtime 热加载、缺省 **enabled=false**；状态与最近 50 条事件落 `gpu-hotshield-state.json`。
- **提权链扩展**：`gpu-ctl` 新增 `halt` 子命令（root：写 /run 关机原因 → sync 限时 8s → systemctl poweroff；刻意不走 nvidia-smi 通道，驱动 D 状态时仍可执行），sudoers 白名单（固定路径全参数）天然覆盖，无需改装。
- **前端**（硬件监视页「GPU 高温自动关机守护」卡）：开关（带确认弹窗防误触）、四项参数编辑、状态瓦片（运行中/持续计时/倒计时/冷却中/正在关机五态）、触发历史列表；**倒计时全屏红色脉冲横幅在任何标签页顶部可见**（1s 刷秒数 + 取消按钮），并有跨标签 BroadcastChannel alert 兜底提醒。
- **验证**：node 逻辑仿真 12 场景（触发/迟滞/降温取消/盲态取消/冷却/grace=0 直达关机）+ 前端 mock 仿真 7 场景（横幅生命周期/事件历史 XSS 转义/空字段不崩）+ tests/unit 39 项、tests/pages 14 场景全过；线上冒烟 save/非法参数/cancel 三路径 + 页面版本戳 r21。
- 线上回滚：`/home/ll/deploy/{server.js,index.html}.bak-hotshield-1009-2143`、`/usr/local/bin/gpu-ctl.bak-hotshield-1009`。

---

## Unreleased — 2026-10-05 基准测试·预填充档位扩到 1M（bench 2.3.0）

「基准测试 → 预填充」原来只给 5 个档位（1K~64K）、服务端还把 >128K 的档位一刀切掉。现按受管实例的真实上下文（1M = YaRN×4）放开档位并加固长档测试。

- **档位 1K → 1M 共 11 档**（1K/2K/4K/8K/16K/32K/64K/128K/256K/512K/1M），另可**手输自定义档位**（256~1048576，加出来的档带 `×` 可删、自动按长度插位）；开测前给预计耗时提示（按 4700 tok/s 粗估，1M×3 轮 ≈ 12 分钟起步）。
- **服务端档位边界 256~1M**（`PF_MIN_TOKENS`/`PF_MAX_TOKENS`），并以配置快照里的**引擎真实 `max_model_len` 再收一道**：非法/超 1M 的档、超引擎上下文的档分别在事件流点名原因后跳过，不再静默丢档；一上来就把整轮打死的情况消除。
- **单档失败不再中断整轮**：某一档 400（超长、KV 池放不下、引擎重启）时记下 `rec.error` + 跳过该档剩余轮次，继续测后面的档；汇总表/详情页把失败档点名显示，`final.failed` 回传失败清单。
- **顶格档按引擎上限留 1.5% 分词余量收口**（`charCap`），避免"照着 1M 凑字符、实际分词超了一点点 → 白跑三百多秒"。
- **1M 档材料构造改写**：逐段拼接（3 万次）改为「8 段材料按 variant 轮转成 unit + 倍增复制」，2.8M 字符 1ms 完成（快 5 倍），首段仍随轮次/档位变化 ⇒ 前缀缓存依旧命不中。
- **显示口径**：`fmtK` 支持 M（1048576 不再显示成 1024K）；TTFT ≥10s 自动换成秒（`fmtTtft`，1M 档 223456ms → 223.5 s）。
- 补丁落点 `patches/patch-prefill-tiers-1005.py`（幂等、自动备份、`node --check` 把关）；验收＝假引擎端到端仿真 17 项（跳过/收口/容错/汇总语义）+ 前端 node mock 仿真 + 线上 1K/8K/128K 实测冒烟。

---

## Unreleased — 2026-10-05 换装机适配（页面戳 20261006-r14）

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
