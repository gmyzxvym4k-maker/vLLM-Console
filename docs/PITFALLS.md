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

### 13. PLE n-gram 表驻留判断：`free` 会骗人，要用 `fincore`

- BF16 原生 95.37GiB 的 n-gram 表走 safetensors mmap，「是否全驻留页缓存」用 `free` 看不出来（页缓存不算任何进程头上）。判据：
  - 加载路径：日志 `[FN-PLE-DISK] n-gram table attached ... dtype=` 一行；
  - 驻留比例：`fincore` 看实际 resident 页（实测 100.00% 时热态 decode 87~93 tok/s）。
- 代价：冷启动 210s→460s（内存扩容到 157GiB 后才划算）。

### 14. vLLM 上游补丁链：KV offload 的连环坑（09-22~23）

简版（详见 [PATCHES.md](PATCHES.md) B 节）：

- **一个未注册的 gauge 炸掉全部请求**：`manager.py set_gauge(CPU_CACHE_FILL_PERC)`，但 `spec.py` 没注册元数据 → 每请求路径上的 `assert` 抛错 → 全部 500。教训：**nightly 上游的断言就是地雷**，打补丁前先 grep 所有 set/observe 调用与注册表的差集。
- **稀疏键 vs 连续性要求**：滑动窗口组存储端每分段只留尾部检查点（稀疏键），查找端 eagle 却要求连续 sw+1 命中 → 命中率恒 0。四个纯日志探针补丁（c3b→c3e）逐级收窄实锤后，c4/c5a 才是真修。**探针先行、不改行为、用数据说话**，比凭猜想直接改省了一半以上时间。

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

---

## E. 移植到别的机器时最容易踩的

1. 以为要 npm install——**零依赖**，只要 Node。
2. 把仓库子目录结构改了——server.js 按 `__dirname` 平铺找配置文件（见 README「目录结构」警告框）。
3. 忘改 `MODELS_DIR`/`VLLM_ENV`/`SGLANG_VENV` 常量就去点「启动实例」。
4. 在没有 nvidia-smi 的机器上疑惑 GPU 卡片空白——设计如此（缺失只隐藏对应卡片）。
5. 在非 Intel 平台找能耗数据——RAPL 特有。
6. 把 `patches/` 里的 vLLM 补丁往自己环境的 vLLM 上盲打——那是针对 v0.1.dev20073 特定源码行的存档，当读物，不当输入。
