# 架构与关键设计

本文档描述 `server.js`（约 9900 行）与 `index.html`（约 6600 行，内联 JS）的内部结构。**改代码前必读**——这里记录的多数设计都是被事故逼出来的，看似多余的防御其实各有一段血泪（详见 [PITFALLS.md](PITFALLS.md)）。

## 1. 总体形态

```
浏览器 ──HTTP──▶ server.js（单进程 Node，零依赖）
                  │
                  ├─ 静态层     index.html / bench.html / mobile.html / static/*（实时读盘 + ETag）
                  ├─ 内部 API   /v1/internal/*（GET 只读免鉴权；POST 受 console-auth 拦截）
                  ├─ OpenAI 代理 /v1/*（按 served-model-name 路由到实例端口，流式透传）
                  │
                  └─▶ 本机推理实例（vLLM / SGLang，多端口）
                        ▲ 启动：控制台 spawn 子进程（quickstart 预设 / 脚本化模型三层脚本）
                        ▲ 观测：/metrics 抓取 + 日志解析 + dsh_vllm_logger 插件 jsonl
```

单文件是刻意的：这台机器上「改一行就能 scp 上去重启」的运维速度比模块化的优雅更重要。

## 2. 后端关键机制

### 2.1 进程发现与端口自愈

- 扫描 `/proc/*/cmdline`，正则解析 `--port`、`--model-path`、`--served-model-name`，识别 vLLM/SGLang 实例及其端口；兼容 docker cgroup（`/proc/<pid>/cgroup` 里提取容器 ID）。
- `resolveBackendPort()`：主后端端口探测。**探不到返回 `null`，调用方保持当前端口**——绝不回落缺省值。09-22 曾因硬回落 `8000`（无监听端口）导致整页假死，见 PITFALLS §3。
- `maybeReDetectBackend()` 周期性重探，模型重启后自动跟回真实端口。

### 2.2 `/metrics` 缓存（fetchMetricsCached）

上游 vLLM `/metrics` 单次约 **64KB** 文本。多个前端卡片同秒拉同一端口时：

- **400ms TTL 缓存** + **单飞（single-flight）**：并发请求共享一次真实抓取。
- 要改前端轮询频率之前，先想清楚这个缓存；无脑加频只会放大上游压力。

### 2.3 指标解析

- Prometheus 文本 → 结构化：`vllm:request_success`、`time_to_first_token_seconds`、`request_generation_tokens`、直方图 bucket（`parseBucketHist`）等。
- **逐秒速度**由本地 ticker 差分计算（计数器差 ÷ 时间差），并维护 `lastSecond` 快照。
- 日志侧真值通道：解析 vLLM 日志 `Prefill batch, #new-seq: …, #new-token: …, #cached-token: …` 行（两种格式变体都有正则）；`dsh_vllm_logger` 插件写 `request-traces.jsonl` / `vllm-live-prefill.jsonl` 提供逐请求与逐 chunk 粒度。

### 2.4 GPU 采样：异步 + 熔断（铁律）

- **禁止 `execSync`/`execFileSync` 调 `nvidia-smi`**。GPU 驱动异常时 nvidia-smi 进入 D 状态（不可中断睡眠），`execSync` 的 timeout 靠发信号实现、对 D 状态无效，会永久阻塞事件循环，8889 整机无响应（真实事故：43 个 D 状态进程拖垮控制台）。
- 正确实现：1 秒周期 `spawn`/`execFile` 异步采样 → 结果写 `global.__gpuLive` / `global.__gpuStatic` 缓存；各 API 只读缓存，绝不在请求路径上现采。
- 全局熔断器：连续超时即永久停用 GPU 采样，保住控制台核心功能。
- 请求入口已 async 化，且有全局 `unhandledRejection` / `uncaughtException` 兜底——任何采样器异常都不允许杀死进程。

### 2.5 gzip 与 ETag

- `installGzip` 白名单：内部 API、页面、静态资源。**chat 代理流式路径禁止压缩**（压缩会破坏 SSE/流式透传的及时性）。
- `index.html` 每次请求实时读盘 + ETag：**改前端刷新浏览器即生效，不需要重启服务**。改 `server.js` 才需要重启——而且注意：vLLM 实例运行在同一 cgroup 内时，重启必须保 `KillMode=process`。

### 2.6 鉴权

- `console-auth.json` 存在且含 `token` → 拦截 `/v1/internal/` 的 POST（`X-Console-Token` 头或 `?ct=` 参数）。5 秒热生效（文件 mtime 轮询），删除文件即关闭。
- GET 只读与 `/v1` OpenAI 代理不受影响。

### 2.7 BENCH 引擎（必须闭包）

- bench-console v2.2.1 移植进 `server.js`，整个引擎包在 **IIFE 闭包**里导出 `{handleApi, VERSION}`。
- **原因**：外层已有同名 `sleep`、`parseMetrics` 符号，直接内联会互相覆盖。移植第三方代码进单文件时先查符号冲突。
- API 挂 `/v1/internal/bench/*`（POST 受鉴权拦截）；被测服务 = 受管实例（动态跟随 `config.vllmPort`）+ 可选 `bench-services.json`（热读）；提示词 `prompts/prompts{13,6}.json`；结果落盘 `bench-results/`。

## 3. 前端关键机制（index.html）

### 3.1 轮询门控

- 全局 `setInterval` 被包装为 **visibilitychange 门控版**：标签页隐藏时自动停轮询（省电省流量）。

### 3.2 停摆看门狗（20260923-r1 自愈层）

四条铁律，都是 09-22/09-23 两次停刷事故的结论：

1. **停摆判据只能取「渲染是否推进」（`_lastRenderAt`），绝不能取「请求是否成功」**——并发卡片旁路 `_concTick` 每 500ms 独立拉 stats 且一直成功，以请求为准会永久掩盖主链停摆（node 仿真实锤：renders 恒 0、看门狗不触发）。
2. **禁用 `AbortSignal.timeout()` 做前端超时**——它由浏览器内部定时器驱动，标签页被节能冻结（Chrome Memory Saver）后解冻时 pending fetch 常被网络栈直接丢弃，既不 resolve 也不 reject 也不派发 abort → `await` 永不 settle。必须自建 `AbortController + setTimeout`，settle 时 `clearTimeout`。
3. 看门狗定时器走 **`__origSetInterval`（不受 hidden 门控）**，业务定时器走门控版；前台 6s 无渲染即清忙标志、整体重建定时器、补刷一次；从未渲染过时按启动 12s 兜底。
4. **回前台要挂四类事件**：`visibilitychange` / `pageshow` / `focus` / `online`——只挂 visibilitychange 就是当年「必须手动刷新才恢复」的缺口。

另有右上角 `dataFresh` 新鲜度徽章：数据超过阈值未更新直接可见，不用猜。

### 3.3 忙标志与空数据防御

- `refreshDashboard` 有 `_dashBusy` 互斥 + 15s 看门狗。
- stats 返回 `{}`（后端存活但无数据）与请求超时都算「正常走完一轮」，会推进 `_lastRenderAt`，不会误触发看门狗；但主卡片与 `_concTick` 都把 `{}` 视为无数据跳过渲染。

## 4. 内部 API 一览

`GET /v1/internal/`：`stats`（聚合仪表盘）· `metrics` · `gpu` / `gpu_info` / `pcie-topo` · `cpu` / `sysmem` / `membw` · `storage` / `disk-trend` · `net` · `power` / `energy` · `billing` · `recent-requests` · `vllm-logs` · `model-manager` / `model-params` · `quickstart` · `pd-series` · `bench`（子路由 `/bench/*`）。

`POST /v1/internal/`（受鉴权）：`model-manager`（启停实例）· `quickstart/save` / `quickstart/delete` · `billing/reset` / `billing/days/delete` · `energy/reset` · `power/offset` · `reset-stats` · `bench/*`。

## 5. 脚本化模型三层启动链（Flash-Next 案例）

```
控制台 POST /v1/internal/model-manager (script:true)
  └─ server.js scriptModelLaunchPlan()：把预设 env 拼成 FN_EXTRA_ENV（单字符串）
      └─ start-flash-next-w4a16.sh（外层）：展开 FN_EXTRA_ENV 写入 ENVF 末尾（source 时用户值胜出）
          └─ flash-next-w4a16-inner.sh（chroot 内层）：读 ENVF → 组装 vllm serve 命令
```

09-18 之前外层脚本没人展开 `FN_EXTRA_ENV`，控制台「附加环境变量」长期静默失效——排查「切档不生效」先看这条链（PITFALLS §7）。判据：日志 `[FN-PLE-DISK] n-gram table attached ... dtype=`；驻留判据只能用 `fincore`，不能用 `free`。
