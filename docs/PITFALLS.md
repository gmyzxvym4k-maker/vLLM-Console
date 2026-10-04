# 踩坑实录

每一条都真实付出过代价（宕机、整页假死、误杀推理实例、追查半天方向错误）。按主题分组，供后来者少交学费。

---

## A. 运行时稳定性

### 1. `execSync` 调 nvidia-smi，把整个控制台拖死（最贵的一课）

- **症状**：8889 页面彻底无响应，连静态页都打不开；杀掉服务后 systemd 自动重启又立刻卡死，循环。
- **根因**：GPU 驱动异常（CMP 170HX 的 GSP Booter 引导失败，错误码 0x31，`RmInitAdapter failed 0x62:0x65:2119`）时，`nvidia-smi` 进程进入 **D 状态（不可中断睡眠）**，机器上堆了 43 个。`execSync` 的 `timeout` 选项靠**发信号**实现，对 D 状态进程无效——Node 主线程被永久阻塞。
- **修法（铁律）**：
  1. 任何外部命令一律 `spawn`/`execFile` 异步 + **自身定时器放弃等待**（不等进程退出，超时即当作失败），禁止 `execSync`/`execFileSync` 进请求路径；
  2. GPU 采样集中到 1s 周期的后台采样器，结果写全局缓存 `global.__gpuLive/__gpuStatic`，API 只读缓存；
  3. 全局熔断器：连续超时即**永久停用** GPU 采样，保住控制台核心功能。
- **延伸**：此类 GPU Falcon/GSP 挂死故障 **warm reboot 无效，必须完全断电冷启动**（power cycle）才能复位。另外配套坑：`/usr/local/bin/gpu-power-limit.sh` 首行裸调 `nvidia-smi -pm 1` 不等驱动就绪就抢跑，是死锁放大源。
- **复盘**：09-22 修停刷问题时又在 `/v1/internal/power` 里发现残留一处 `execSync nvidia-smi`——铁律要靠 grep 定期巡检，不能靠记性。

### 2. 仪表盘停刷 · 第一案（2026-09-22，版本 20260922-r1）

- **症状**：数据隔一会儿停刷。
- **根因链**：模型重启/加载窗口内 `resolveBackendPort()` 探不到 vLLM 进程 → 硬回落 `return 8000`（机器上根本没有 8000 监听）→ 端口自愈机制 `maybeReDetectBackend` 把这个**兜底值当成真值**，把主端口从 18420 横跳到 8000 → stats 抓不到东西返回 `{}` → 前端只挡了 `!s` 挡不住 `{}` → 整页假死。
- **判据**：`server-error.log` 刷 `[backend] 端口变化 18420 -> 8000`。
- **修法**：探不到返回 `null`，调用方保持当前端口；config 初始化处 `|| 8000` 只做缺省。同案第二根因见 A1 的 power 端点残留。
- **教训**：**凡「后端探不到就返回缺省值」的兜底，都可能被自愈机制当成真值横跳。宁返 null 让调用方保持现状。**

### 3. 仪表盘停刷 · 第二案（2026-09-23，版本 20260923-r1）——与第一案根因完全不同

- **症状**：页面开久了整页数字定格，**必须手动刷新才恢复**；后端一切正常。
- **根因**：前端轮询链条一旦卡死（某个 await 永不 settle），无任何外力可拉回。两个深层坑：
  1. **停摆看门狗的判据如果取「请求是否成功」会被永久掩盖**——并发卡片旁路 `_concTick` 每 500ms 独立拉 stats 且一直成功。判据只能取「渲染是否推进」（`_lastRenderAt`）。这条是用 **node 仿真实锤**的：mock setInterval/fetch 跑多场景（卡死自愈/正常不误伤/上游返回 `{}`），发现请求判据下 renders 恒 0、看门狗永不触发。
  2. **`AbortSignal.timeout()` 在标签页被节能冻结后不工作**：Chrome Memory Saver 冻结标签页，解冻时 pending fetch 常被网络栈直接丢弃——既不 resolve 也不 reject 也不派发 abort → `await` 永不 settle。必须自建 `AbortController + setTimeout`，settle 时 `clearTimeout`。
- **修法**：2s 看门狗（走不受 hidden 门控的 `__origSetInterval`）+ 前台 6s 无渲染即清忙标志、整体重建、补刷 + 回前台挂 `visibilitychange/pageshow/focus/online` 四类事件（只挂 visibilitychange 就是「必须刷新」的缺口）+ 右上角数据新鲜度徽章。
- **方法论**：把内联 JS 片段抽出来在 node 里 mock 定时器/fetch 跑场景仿真，**比静态读代码猜快，且能证伪自己的方案**。

### 4. tailwind.js 浏览器 JIT：407KB 现编样式的代价

- 页面引入 tailwind 运行时 JIT 编译器（407KB），每次进页面在浏览器里现场编译样式，首屏明显卡顿。
- 09-20 改为**预编译** `static/tailwind-build.css`（9.4KB）。**新坑随之而来**：改了 `index.html` 里的新 class 忘了跑 [`ops/build-tailwind.sh`](../ops/build-tailwind.sh) 重建，新样式无声消失——排查了半天「class 明明写了」。**改 class 必重建**，已写进项目约定。

### 5. 前端超时与流式代理的两条红线

- 聊天代理（`/v1` 转发）**禁止 gzip**：压缩缓冲会破坏 SSE/流式 token 的实时性，表现为「憋一大段再吐」。`installGzip` 走白名单就是为了这个。
- 上游 vLLM `/metrics` 单次约 **64KB**。想加大前端轮询频率之前，先想清楚服务端的 400ms TTL + 单飞缓存还够不够——无脑加频只会把开销转嫁给上游。

### 6. logrotate 必须 `copytruncate`

- node 进程持有 `server.log` 文件句柄。logrotate 用默认 move 策略轮转后，进程继续往旧句柄写，新文件永远是空的。配置见 `ops/logrotate-console.conf`（50M×4 保留）。

---

## B. 部署与服务管理

### 7. `KillMode=process`：不加这行，重启控制台会杀掉推理实例

- systemd 缺省 `KillMode=control-group`：`systemctl restart` 时把 cgroup 内**所有**进程一起 SIGKILL——包括控制台 spawn 出去的 vLLM/SGLang（模型加载十几分钟，杀一次哭一次）。
- 单元模板里这行注释了原因，**移植时务必保留**：见 `systemd/dsh-console.service`。
- 推论：**改前端（index.html/bench.html/static）根本不需要重启服务**（实时读盘 + ETag），别手痒 restart。`server.js` 改动才需要。

### 8. 部署纪律：线上/本地分叉与备份命名

- 流程固定：scp 到 `/tmp` → `node --check` → 替换 `/home/ll/deploy/{server.js,index.html}` →（仅后端改动才）`systemctl --user restart`。
- 每次替换前留 `<文件>.bak-<主题>-<月日>` 备份。09-23 曾出现「线上 = 旧基线 + bench 补丁，本地还含未上线改动」的分叉，diff/部署稍有不慎就把别人的半成品推上线。**动手前先和线上 diff。**
- 线上有 3 个 `.bak-*` 文件属 root 且权限 0111，ll 用户 rsync 必报 Permission denied——不是遗漏，要取得加 sudo。

### 9. 密钥文件入库风险

- `console-auth.json`（控制台口令）、`bench-services.json`（可能含远端 apiKey）**绝不入库**，已在 `.gitignore`。对外打包/开源时先跑一遍敏感扫描。

### 10. 开机卡 30 秒以上

- 根因三连：`GRUB_TIMEOUT=10` + 异常关机后 recordfail 默认等 30s（这机器 GPU 故障经常异常关机，是最大来源）+ `NetworkManager-wait-online` 6.6s 卡住 docker→multi-user 关键路径。
- 修法见 [`ops/boot-speedup-127.sh`](../ops/boot-speedup-127.sh)（幂等、含回滚说明）：TIMEOUT=0、RECORDFAIL_TIMEOUT=3、disable 一堆无关服务。55s→~35s，剩余是 BIOS 自检。
- 注意：**模型服务不随开机自启**，重启后要在控制台手动拉起（这是特性不是 bug——避免开机风暴里 GPU 驱动没就绪就抢跑，见 A1 延伸）。

---

## C. 模型启动链路（脚本化模型）

### 11. 控制台「附加环境变量」静默失效（09-18）

- 现象：网页上给脚本化模型配 `FN_PLE_INT8=1` 之类的变量，切档毫无反应。
- 根因：`server.js` 把用户 env 拼成**单个字符串** `FN_EXTRA_ENV` 传给外层脚本，而脚本从不展开它——变量根本没进环境。这类「链路上某一环默默吞了参数」的 bug，**在每个交接点打印最终值**是唯一省事的查法。
- 修法：外层脚本展开 `FN_EXTRA_ENV` 写入 ENVF 末尾（source 时用户值胜出）。

### 12. 采样参数三处不一致（09-21）

- 弹窗、预设、chroot 内层脚本各有一份采样参数，inner 硬编码不读 `FN_GENCFG` → 前端改了等于没改。`patches/patch-gencfg-0921.py` 三处统一。**参数只应有一个权威来源，其余全部透传。**

### 12b. 采样参数第二案：wrapper 白名单漏 `FN_GENCFG`（09-26）

- 现象：弹窗填 temperature=0.1 / repetition=1.2 启动，控制台「采样参数」卡仍显示 0.6 / 1.05。
- **卡片没骗人**：它读的是引擎真实 `--override-generation-config`，那两组值正是 inner 脚本的 `GENCFG_DEFAULT`。
- 链路断点：`server.js` 的 `scriptModelLaunchPlan()` 确实算出了 `FN_GENCFG`（日志 `[script-model] start ... gen={"temperature":0.1,...}` 可证），但
  1. `start-flash-next-w4a16.sh` 落盘 ENVFILE 用的是一份**手写 FN_\* 白名单**，里面没有 `FN_GENCFG`；
  2. 脚本末尾 `sudo -S setsid chroot` 会重置环境（sudo env_reset），弹窗传进来的 `FN_*` 只有写进 ENVFILE 的那部分进得了 chroot。
  ⇒ `FN_GENCFG` 在 wrapper 这一跳被丢，inner 只能用自己的缺省值。
- 同批被白名单吞掉的还有 `FN_CHATKWARGS / FN_PREFIX_CACHE / FN_CHUNKED / FN_SCHED_POLICY / FN_SEED / FN_NOLOG / FN_KV_DTYPE / FN_LIMIT_MM / FN_MAX_SCHED_TOKENS / FN_CPU_OFFLOAD_GB / FN_ENFORCE_EAGER`；另外 `FN_ENFORCE_EAGER`（server 侧）与 `FN_EAGER`（inner 侧）**根本不同名**，勾了也没用。
- 修法：wrapper 改成动态扫全部 `FN_*`（排除 `FN_ENVFILE` 自身）落盘，今后 server.js 加键不必再改这张表；inner 认 `FN_ENFORCE_EAGER` 为 `FN_EAGER` 别名。前提已核：控制台进程环境不含任何 `FN_*`（否则会被一起透传）。
- 排障套路（本案两分钟可定位）：① `tr '\0' ' ' < /proc/<引擎pid>/cmdline` 看引擎真实参数；② `cat flash-next-w4a16-launch.env` 看落盘了什么；③ `grep "script-model] start" server.log` 看弹窗本来想下发什么。三者一比，断点在哪一跳一目了然。
- 遗留（未修，需要时再做）：上面那批 `FN_*` 现在能进 chroot，但 inner 仍不消费 `FN_CHATKWARGS/FN_PREFIX_CACHE/FN_CHUNKED/FN_SCHED_POLICY/FN_SEED/FN_NOLOG/FN_KV_DTYPE/FN_LIMIT_MM/FN_MAX_SCHED_TOKENS/FN_CPU_OFFLOAD_GB`——要真生效还得在 inner 里接上对应 ARGS。

### 13. PLE n-gram 表驻留判断：`free` 会骗人，要用 `fincore`

- BF16 原生 95.37GiB 的 n-gram 表走 safetensors mmap，「是否全驻留页缓存」用 `free` 看不出来（页缓存不算任何进程头上）。判据：
  - 加载路径：日志 `[FN-PLE-DISK] n-gram table attached ... dtype=` 一行；
  - 驻留比例：`fincore` 看实际 resident 页（实测 100.00% 时热态 decode 87~93 tok/s）。
- 代价：冷启动 210s→460s（内存扩容到 157GiB 后才划算）。

### 14. vLLM 上游补丁链：KV offload 的连环坑（09-22~23）

简版（详见 [PATCHES.md](PATCHES.md) B 节）：

- **一个未注册的 gauge 炸掉全部请求**：`manager.py set_gauge(CPU_CACHE_FILL_PERC)`，但 `spec.py` 没注册元数据 → 每请求路径上的 `assert` 抛错 → 全部 500。教训：**nightly 上游的断言就是地雷**，打补丁前先 grep 所有 set/observe 调用与注册表的差集。
- **稀疏键 vs 连续性要求**：滑动窗口组存储端每分段只留尾部检查点（稀疏键），查找端 eagle 却要求连续 sw+1 命中 → 命中率恒 0。四个纯日志探针补丁（c3b→c3e）逐级收窄实锤后，c4/c5a 才是真修。**探针先行、不改行为、用数据说话**，比凭猜想直接改省了一半以上时间。

### 14b. 引擎换栈后指标名失配：仪表盘「二级缓存·CPU」卡整张消失（09-27）

- **症状**：仪表盘没有 KV Cache 的二级缓存卡。引擎侧其实**开着**（`FN_KVOFF=1`、`--kv-transfer-config` 带 `cpu_bytes_to_use=103079215104`＝96 GiB、`vllm:kv_offload_store_bytes_total` 已累计 27.3 GiB / 61 次写入）。
- **根因**：控制台采样 `/metrics` 时**只认旧栈（自研镜像 + kvfill 补丁）的 `vllm:kv_offload_cpu_cache_fill_perc` 作为「二级缓存已启用」的唯一开关**；官方 0.30.0 新栈没有这个补丁指标，只有上游原生 `vllm:kv_offload_cpu_cache_usage_perc`。找不到 fillKey → `tk.kvOffload` 恒 null → `kv_offload_ports` 返回 `[]` → 前端 `display:none`。**后端静默给空数组、前端静默隐藏，全链路无一处报错**，所以看起来像"功能没了"。
- **修法（已上线 09-27）**：[`patches/patch-kvoff-0300-metric-0930.py`](../patches/patch-kvoff-0300-metric-0930.py)——两栈任一 gauge 在即认定启用；写入/回载字节与次数先取新栈无标签序列（`store_bytes_total` / `load_bytes_total` / `store_size_count` / `load_size_count`），回落旧栈 `total_bytes_total{transfer_type}` / `size_count{transfer_type}`；用 `metric_kind` 把口径透传到前端。
- **口径红线**：两者**不是一回事**——`fill_perc`（旧栈）= 已存数据占内存档比例；`usage_perc`（新栈）= 官方文档写明的「被在飞传输钉住」的比例，空闲时恒 0。**把 usage 当驻留显示，会把"缓存塞满"和"完全空闲"画成同一个数**。新栈无驻留 gauge，故前端主值改显「容量 · 已启用」，钉住比例只进小字与 tooltip。
- **判障顺序（这类"卡不见了"通用）**：① 引擎真实 cmdline 里有没有开关（`tr '\0' ' ' < /proc/<pid>/cmdline`）；② `/metrics` 里该指标族到底叫什么（`grep '^# TYPE vllm:kv_offload'`）；③ `curl /v1/internal/stats` 看后端字段是空数组还是缺字段；④ 最后才看前端 filter 与 `display`。**先证引擎开着，再往后端找，别一上来改前端。**

### 14c. 引擎换栈后日志判据失配：运行参数卡不显示 PLE 精度/驻留（09-27）

- **症状**：仪表盘「运行参数」里没有 `PLE 表精度`（INT8 还是 BF16）与 `PLE 表驻留`（硬盘还是内存）两行；引擎其实正常跑着（PLE 表已加载）。
- **根因**：控制台的 PLE 判据是**按旧栈自研镜像的日志标记写死的**——只认 `[FN-PLE-*]` 行（`[FN-PLE-INT8] ... n-gram table attached`、inner echo 的「INT8 磁盘驻留」等）。官方 0.30.0 新栈压根不打这些行，它的判据是 `Initialized PLE embedding ... weight_dtype=torch.bfloat16, weight_device=cpu, pinned=True` 与 `[rt-patch] PLE pinned alloc: 95.368 GiB registered in 2 chunk(s)`；旧栈的 `FN_PLE_INT8`/`FN_PLE_LOC` 在新栈是 NOOP（不生效）。`readPleStatusCached` 扫不到任何判据 → `ple_table=null` → 前端两行整段不渲染。
- **修法（已上线 09-27）**：`matchPleLine()` 双栈判据 + 反向扫尾 64MB，最近一条判据行赢；**主判据缺 GiB 时只往回补一条**（新栈「Initialized PLE embedding」行不带尺寸，靠上一条 `PLE pinned alloc` 补 95.368 GiB），不跨启动合并。归档：[`patches/patch-ple-0300-display-0930.diff`](../patches/patch-ple-0300-display-0930.diff)（线上 `patch -i ... /home/ll/deploy/server.js`，备份 `.bak-ple0300-0927`）。
- **新增驻留态 `pinned`**：锁页主机内存（`cuMemHostRegister`），**不可回收也不可换出**，与旧栈的 `heap`（匿名堆，不可回收但可换出）是两码事；前端四态显示 disk/heap/pinned/gpu，别再把 pinned 显示成「匿名堆」。
- **口径**：`pinned alloc` 那条能力提示行（`>60 GiB tables go through chunked cuMemHostRegister`）**不是**实建行，判据必须要求同时含 `registered`，否则会把"准备分块"当成"已分配 0 GiB"。
- **教训**：凡是"从日志文本反解引擎状态"的显示，换引擎/换镜像后都必然失配；这类判据要写成**按信息量排序的多形态匹配**，并且**只信日志**（弹窗/FN_* 请求值在新栈可能是 NOOP）。

### 14d. 「二级缓存·CPU」卡要常驻：三态显示 + /dev/shm 物理驻留真值（09-27）

- **需求**：仪表盘常驻显示内存二级缓存（CPU KV offload）信息。改造前有两处让它"消失"：① 后端 `kvOffloadPortsInfo()` 对**未启用 / 尚未采到指标**的实例直接 `continue` → 返回 `[]`；② 前端见空数组就 `display:none`。于是引擎每次冷启动（约 8 分钟）或未配内存档时，整卡不见 —— 恰好是用户最想盯着看的时候。
- **修法（已上线 09-27）**：后端改为**每个受管实例都出条目**并带 `enabled` 布尔（判据 = `/metrics` 已有 kv_offload 指标 **或** cmdline 已含 `cpu_bytes_to_use`，后者覆盖"配置已定、指标未暴露"的加载窗口）；前端三态常驻：已启用→数值 / 有实例未配→灰字「未启用」/ 无实例→灰字「--（引擎未运行 / 加载中）」。另在 `refreshDashboard` 的 `stats === {}` 早退分支里单独把该卡置为离线态 —— **否则引擎重启窗口内整轮跳过，卡会停在上一次的数字**（看起来像卡住）。
- **新栈驻留真值**：新栈没有驻留 gauge（见 14b），但内存档的物理驻留可直接从 tmpfs 读：`fs.statfsSync('/dev/shm')` → `(blocks - bavail) * bsize`。本机 `/dev/shm` 只有 vLLM offload 在用（实测 c8 共享区建好后 used ≈ 68.9 GB ≈ 配置 64 GiB，引擎停止后回落到 64 KB），**无需 root、不 spawn 子进程**（引擎由 root 启动，`/proc/<pid>/smaps_rollup` 普通用户读不到，别走那条路）。口径写进 tooltip：整机 tmpfs 用量，多实例共享时不可按实例切分，故只在单实例时用它当主值。
- **顺带补全命中维度**：新增 `vllm:external_prefix_cache_queries_total` / `hits_total`（OffloadingConnector 的二级缓存查询/命中），与原有 `prompt_tokens_by_source{source=external_kv_transfer}`（免重算 token 量）互补 —— 排查"缓存建起来了但一次没命中"（queries 涨、hits 恒 0）时，前者才是判据。
- **本卡口径**：主值「驻留 / 容量 GiB」；小字三档 `在飞 p%`（新栈钉住比例，**不是驻留**）/ `查 N/中 M` / `存 X GiB`；只有旧栈 `fill` 口径才把百分比标成「驻留」。改动落点：`server.js` 的 `kvOffloadShmUsage()` / `kvOffloadPortsInfo()` / ticker 采样 + `index.html` 渲染块与 `stats` 空分支；线上备份 `server.js.bak-kvofflive-0927` / `index.html.bak-kvofflive-0927`，`PAGE_VERSION=20260927-r3`。

### 14e. vLLM 运行日志面板空白：日志源不能依赖 `SCRIPT_MODELS` 注册表（09-29，已上线）

- **症状**：「vLLM 运行日志」面板空白，接口返回 `{"logs":"","totalLines":0,"file":"/home/ll/deploy/vllm.log","stale_min":56,"cleared":true}`；引擎其实跑得好好的（18420 正常出 token）。
- **根因**：`getVllmLogSource()` 的日志源优先级是 ① 脚本模型（遍历 `SCRIPT_MODELS`，靠 `scriptModelInstance()` 按**注册表里的模型路径**去 cmdline 里认领）→ ②③ 读进程 fd → ⑤ 兜底 `./vllm.log`。09-29 现场在跑的是 uncensored 栈（模型 `/media/ll/data/models-1m/Qwen3.8-Flash-Next-Uncensored-NVFP4-FP8PLE-1M`），**注册表只有 NVFP4 / W4A16 两条**，`scriptModelInstance()` 对两条都返 null → ① 段零候选；引擎由 root 起、`/proc/<pid>/fd/1` ll 读不到 → ②③ 空；一路掉到 ⑤，于是显示的是两小时前一次启动失败留下的 `vllm.log`。
- **修法（已上线 09-29）**：新增 `pickLogFromProcs()`，在 `getVllmLogSource()` 最前面加 **⓪ 段通用判据**——任何在跑的 vLLM 进程，真实日志路径就写在它自己启动 wrapper 的 argv 里（形态 `sudo -S sh -c 'exec setsid bash "$1" >> "$2"' _ <inner> <logfile>`），用祖先链 `cmdline`（全局可读，root 进程同样适用）取 `.log`；主实例端口优先、其次 mtime 最新，且**候选全部停写 >24h 就不采用**（防拿残留进程的旧日志冒充当前日志）。
- **为什么这是治本**：同一病因已犯三次——09-26（w4a16 → 官方 0.30.0 换栈）、09-27（两栈并存）、09-29（换 uncensored）。凡是「显示判据要先去注册表登记新东西」的结构，上新模型时必失配，而且**静默回落、无一处报错**。判据要挂在「进程」这个真值源上，不是挂在「配置表」上。
- **落点与回滚**：`server.js` 的 `pickLogFromProcs()` / `getVllmLogSource()` ⓪ 段；线上备份 `server.js.bak-logsrc-0929`。验证手法：`curl /v1/internal/vllm-logs?tailLines=400` 看返回的 `file` 是否等于 wrapper argv 里那份日志（对照 `ps` 的 argv），再看 `stale_min` 归零。

### 14e-2. argv 判据第四次失灵：重定向发生在 wrapper shell 内部时 cmdline 里没有 .log（10-05，已上线）

- **症状**：与 14e 同款——接口返回 `"file":"/home/ll/deploy/vllm.log","stale_min":4386,"cleared":true`，面板空白；引擎 189200 在跑、`vllm-flash-next-w4a16.log` 每秒都在写。
- **根因**：14e 的 ⓪ 段判据「祖先链 cmdline 里的 .log token」**隐含前提是日志路径以独立 argv 参数出现**（当时的 wrapper 形态 `sh -c 'exec setsid bash "$1" >> "$2"' _ <inner> <logfile>`）。10-05 现场的启动链换成**看门狗托管**：`fnx-watchdog → bash start-flash-next-w4a16.sh`（最后一行 `sudo_run setsid chroot … >> "$LOG" 2>&1` 的重定向由 wrapper **shell 自己**做，不进任何 cmdline）→ `sudo(root)` → chroot 引擎(root)。祖先链各级 cmdline 实测零个 `.log` token → argv 判据失明；① 段注册表打分又不命中（引擎模型路径换新为 `models-1m/Qwen3.8-Flash-Next-Channel-INT8-w8a8-1M`，与注册表路径不同源）；②③ 读 root 引擎 fd 是 EACCES → 三路全断，再次跌 ⑤ 兜底。
- **修法（已上线 10-05，PAGE_VERSION 20261006-r16）**：新增 `ancestorFdLogFiles()/ancestorFdLogFile()`——argv 判据落空时沿祖先链找**本用户可读**进程（看门狗/wrapper 属 ll）的 `fd1/fd2` 所指 `.log`（bash 把重定向继承给 exec 的子进程，wrapper 的 fd1 就是日志真身），并用「引擎模型路径 or `(APIServer pid=N)`」做 `logFileMentions` 内容交叉校验防拿错文件；接入 `pickLogFromProcs()`（⓪ 段）与 `pickScriptModelLogFile()`（①′ 后加 ①″，PLE 显示共用）。另加透明化：⑤ 兜底返回 `fallback:true` → 端点透传 → 前端红条「未能定位当前运行引擎所写的日志文件」，杜绝静默显示陈年文件。
- **推广教训**：argv 判据与 fd 判据是互补关系不是替代关系——**重定向在哪一层做，真值就在哪一层的 fd 上**；判据链至少要备齐「cmdline token」「祖先 fd」「内容校验」三种形态才不会随启动器演化再度失明。
- **落点与回滚**：`server.js` 的 `ancestorFdLogFiles/ancestorFdLogFile/pickLogFromProcs/pickScriptModelLogFile/getVllmLogSource` + `index.html` fallback 红条；线上备份 `server.js.bak-logsrc-1005-0020` / `index.html.bak-logsrc-1005-0020`。验证手法同上（`file` 应为引擎祖先 wrapper fd1 指向的日志、`fallback:false`、`stale_min` 归零）。

### 14f. 显存温度显示：`temperature.memory` 与核心温度阈值不能混用（09-29，已上线）

- **需求**：显卡信息加显存温度。`nvidia-smi --query-gpu=temperature.memory` 在 CMP 170HX（cmpunlocker 魔改驱动 610.43.03）实测可返回数值（核心 68/显存 74、核心 64/显存 68）。
- **两条采集链都要改**（容易只改一条）：① `GPU_LIVE_FIELDS` → `__gpuLive.temp_mem`，服务 `/v1/internal/gpu`（硬件监视页 + 页头 chip）；② `getGpuInfo()` 的 `--query-gpu` CSV → `gpu.temperature_mem` / `perGpu[].temperature_mem`，服务 `/v1/internal/gpu_info`（仪表盘温度卡与逐卡徽章）。**两条链的解析都是纯下标（`parts[N]` / `r[N]`），插字段必须把后面所有下标一起顺延**，否则功耗/温度整列错位。
- **阈值口径**：显存温度天然比核心高几度，**不能套核心的 85/70 报警**，否则空载就满屏橙。前端显存独立阈值 `tempMemColor` = 95 红 / 85 橙；核心仍 85/70。
- **缺值兼容**：`gpuNum()` 对 `[N/A]` 返 null、`gpu_info` 链对不支持时返 0，前端一律降级成 `--` / 不显示该项，不要显示 0 °C。
- **落点**：`server.js` 两处字段 + `index.html` 的 `renderStorageGpuCard`（KPI 副值与明细表列，`kpiCard` 加第 5 参 `subColor`）、`updateHdrFromGpu`（tooltip）、`_doRefreshDashboard`（逐卡徽章与 `tempSub`）+ `mobile.html` 同步；`PAGE_VERSION=20261006-r6`；线上备份 `*.bak-gputempmem-0929`。

### 15. chroot 搭建的琐碎坑

- bind mount 设备节点要用 **by-id 路径**（`/dev/disk/by-id/...`），裸 `/dev/nvmeXnY` 重启后可能换位（`start-flash-next-w4a16.sh.bak-byid-0919` 即修复前）。
- 每次内核升级后 cmpunlocker 魔改驱动必须重跑安装脚本，否则 GPU 直接不可见。
- 停止脚本要处理「prewarm 进程还挂着」的场景，直接 hardkill 会留脏显存（`stop-flash-next-w4a16.sh.bak-hardkill-0919` 教训）。

---

## D. 硬件与数据源

### 16. 内存电压列显示 `--` 不是 bug

- 这台 BIOS 把 SMBIOS type 17 的三个电压字段全填 Unknown；type 26 Voltage Probe 连同 34/35/36 全是 Award 模板占位（Address 0x00000000）。hwmon 只有 nvme/coretemp，无 BMC，RAPL 无 DRAM 域，NVML 从无显存电压字段——**所有常规通路都拿不到**。
- 唯一可行来源是 SMBus 上的 DIMM SPD EEPROM（DDR3 byte 6），但内核因 24 槽>4 拒绝自动实例化，需手动 `new_device eeprom`。探测工具：[`ops/vll-hwmon-probe.py`](../ops/vll-hwmon-probe.py)（只读）+ [`ops/install-hwmon-acl-127.sh`](../ops/install-hwmon-acl-127.sh)（sudoers 单命令白名单）。
- **权限模式**：控制台要读任何特权硬件数据，一律走「sudoers 白名单固定路径单命令」，不开通用 sudo。
- 同类已知：CMP 170HX 的显存功耗读数本身就是 N/A，别当成采集坏了。

### 17. 页面版本戳：区分「代码没生效」和「浏览器缓存」

- 改完前端用户说「没变化」，八成是旧缓存页。`index.html` 顶部 `PAGE_VERSION = '20260923-r1'` 显示在右上角，一眼定位。每次发版记得戳一下。

### 17b. 改 `index.html` 上线前必须对整页内联 JS 做 `node --check`（09-27）

- **事故**：给「运行参数」加 PLE 两行时，模板字符串里一处括号写错（`row(...)` 外层多一个 `)`），**整个内联 `<script>` 解析失败 → 页面全部 JS 失效**（仪表盘、轮询、按钮全停），而 HTTP 仍是 200、文件也只是几 KB 的变化——单看响应状态完全看不出来。
- **根因**：前端是 353KB 的单文件内联脚本，没有构建步骤、没有 lint，`.html` 后缀也让 `node --check` 不会自动覆盖到它。
- **铁律**：改完 `index.html`（或任何含内联 JS 的页面），上线前跑一次整页语法自检，**校验对象必须是"将要上线的那个文件"**：

```bash
python3 - <<'PY'
import re
src = open('/home/ll/deploy/index.html', encoding='utf-8').read()
for n, b in enumerate(re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', src, re.S)):
    open('/tmp/live_chk_%d.js' % n, 'w', encoding='utf-8').write(b)
PY
for f in /tmp/live_chk_*.js; do node --check "$f" || echo "❌ $f 语法错误"; done
```

- **配套**：局部片段（如某几行模板表达式）单独抽出来在 node 里跑一遍渲染仿真，能同时抓住"语法过但输出错"的情况；页面 HTTP 200 **不等于** JS 能跑。
- 备份命名 `index.html.bak-<tag>-<日期>`；回滚即 `cp` 回去（前端免重启，刷新即生效）。

---

### 18. 换装机（主板/CPU/GPU/内存变动）三连坑（10-05 实锤）
10-04 深夜该机从「Intel E5-2696 v4 + X99 + 双卡 + 64GB」换成「AMD EPYC 7F52(16C/32T) + HUANANZHI H12D-8D + 三卡 + 32GB」、内核回原生 5.15.0-139-generic 后，控制台依次暴雷：
1. **主端口粘滞缺省 8000、仪表盘整页假死 `{}`**：控制台开机比引擎早起，`resolveBackendPort()` 探不到按缺省 8000 起步；此后端口自愈只挂在 ticker 的 `req.on('error')` 一条腿上，那条腿一旦断（busy 滞留/首个请求悬挂），没有任何力量能把主端口纠回来——`/metrics` 直连明明 200，`stats` 却恒 `{}`。修成三层防御：6s 定时兜底重探 + ticker busy>15s 强制放行 + stats 空数据触发纠偏（判据宁取「渲染/数据没推进」也别只挂错误回调，参见 09-23 看门狗准则同源思想）。
2. **CPU 控制页全线哑火**：cpu-ctl v2 把睿频写死 `intel_pstate/no_turbo`、逐核温度写死 `coretemp`——AMD 机上是 acpi-cpufreq + `cpufreq/boost`（语义相反：1=开）+ k10temp（只有封装级 Tctl）。v3 改为双通道自适应 + 平台串运行时生成；前端逐核温度缺失时回落显示封装温度（带 `*` 角标）。
3. **旧内存档预设在新机必炸**：standard 档带的 `kvoff 96GiB`（shmem 撑爆）与 `pleLoc heap`（48.3GiB 匿名堆不可回收）在 32GB 内存上都是整机 OOM 配方。换装后第一件事是对着 `free -g` 重算内存账、重固预设与 `SCRIPT_MODELS.base`（10-05 定：PP3 + kvoff=0 + PLE INT8 disk，逐键复刻实跑 launch.env，验收=线上 scriptModelLaunchPlan 与 launch.env 全键 diff 为零）。
另外三件小事：DHCP 又换址（127→110→127→126，ops 脚本 `CONSOLE_HOST` 缺省已指 192.168.1.126）；BIOS/RTC 时钟漂转会伪造出「未来的」 systemd 启动时间戳，判进程寿命用 `ps lstart` 别信 `systemctl show`；新板的 CMP 170HX 三卡在原生内核 + cmpunlocker 下无 p2pdma 底子，NCCL 照旧走 SHM（inner 的 `NCCL_P2P_DISABLE=1` 维持）。

## E. 移植到别的机器时最容易踩的

1. 以为要 npm install——**零依赖**，只要 Node。
2. 把仓库子目录结构改了——server.js 按 `__dirname` 平铺找配置文件（见 README「目录结构」警告框）。
3. 忘改 `MODELS_DIR`/`VLLM_ENV`/`SGLANG_VENV` 常量就去点「启动实例」。
4. 在没有 nvidia-smi 的机器上疑惑 GPU 卡片空白——设计如此（缺失只隐藏对应卡片）。
5. 在非 Intel 平台找能耗数据——RAPL 特有。
6. 把 `patches/` 里的 vLLM 补丁往自己环境的 vLLM 上盲打——那是针对 v0.1.dev20073 特定源码行的存档，当读物，不当输入。
