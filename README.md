# vLLM Console — vLLM / SGLang 推理实例管理控制台

单文件 Node.js 实现的 vLLM 推理引擎**本机管理控制台**（默认端口 `8889`）：实时性能仪表盘、多实例启停管理、OpenAI 兼容代理、硬件监视、基准测试、计费与能耗统计。零 npm 依赖，只用 Node 标准库，`node server.js` 即跑。

本仓库内容 = 生产环境（一台 2×CMP 170HX 推理机，跑 Qwen3.8-Flash-Next W4A16，vLLM PP2 + chroot）**正在运行的版本**，逐文件 sha256 与线上核对一致。页面版本戳 `20260923-r1`（可在仪表盘右上角看到）。

> 📌 为什么做这个控制台：vLLM 官方只有 `/metrics` 文本端点和命令行。要把「多实例并发、KV 缓存命中、预填充进度、投机解码收益、逐请求 tok/s、GPU/PCIe/内存带宽」聚合成一屏可操作的运维页面，并支持网页一键启停推理实例（含 TP/PP、MTP 投机解码、PD 分离、KV offload 等几十种启动参数组合），就需要这样一个贴身运维层。

## 目录

- [功能一览](#功能一览)
- [快速复现（部署）](#快速复现部署)
- [目录结构](#目录结构)
- [配置详解](#配置详解)
- [环境变量](#环境变量)
- [鉴权（可选）](#鉴权可选)
- [复现边界：哪些功能绑定了原作者机器](#复现边界哪些功能绑定了原作者机器)
- [深入文档](#深入文档)
- [License](#license)

---

## 功能一览

| 模块 | 说明 |
|---|---|
| **仪表盘** | 每秒刷新：运行中请求数、decode/prefill 实时 tok/s、KV 缓存占用与命中率、预填充进度（TTFT/排队）、投机解码接受率、PD（prefill-decode 分离）走势曲线、逐秒吞吐折线。多实例（多端口）并列展示 |
| **实例管理** | 网页弹窗一键启动/停止 vLLM、SGLang 实例：TP/PP 并行、MTP/DFlash/DSpark/EAGLE 投机解码、YaRN 长上下文（512K/1M）、KV offload 到 CPU、PD 分离；「快速启动预设」把整套启动参数存成 JSON 按钮（`quickstart-presets.json` 热加载） |
| **OpenAI 兼容代理** | 客户端统一指向 `http://<host>:8889/v1`，控制台按 `--served-model-name` 路由到对应实例端口；流式透传（不压缩不缓冲） |
| **最近完成请求** | 逐请求真实 tok/s 表格。数据源双轨：vLLM 侧由 `dsh-logger-pkg` 插件写 `request-traces.jsonl`；SGLang 侧直接解析其日志与 metrics |
| **硬件监视** | GPU 实时（利用率/显存/功耗/温度，异步采样+熔断保护）、PCIe 拓扑、CPU 详情、内存带宽（perf 可选）、磁盘 SMART/IO 走势 |
| **基准测试** | 移植自 [bench-console v2.2.1](https://github.com/polyuij42-del/bench-console)（MIT）：单流解码（13/6 类提示词）· 并发档位扫描 · 预填充 TTFT，三种模式各自独立，测试期间 1s 实时折线，结果落盘 `bench-results/` 可 A/B 对比。UI 为独立页 `/bench.html`，主界面 iframe 懒加载 |
| **计费/能耗** | 按 token 计费台账（`billing-config.json`）、RAPL 功耗采样与电费估算（`energy-config.json`） |
| **日志查看** | 网页内 tail vLLM/SGLang 启动日志，支持关键字过滤 |
| **移动视图** | `/mobile.html` 精简只读面板 |

## 快速复现（部署）

### 环境要求

- **Linux**（必需：靠 `/proc` 扫描同机 vLLM/SGLang 进程，需与推理引擎同机部署。macOS 可启动看页面，但进程发现与硬件采样不可用）
- **Node.js ≥ 14**（实测 v10 可跑，生产用 v22；无任何 npm 依赖）
- 可选：`nvidia-smi`（GPU 卡片）、`sudo smartctl` 免密（磁盘 SMART）、`lspci`/`perf`（PCIe 拓扑/内存带宽）。缺失只影响对应卡片，不影响主功能：
  ```bash
  echo "$USER ALL=(root) NOPASSWD: /usr/sbin/smartctl" | sudo tee /etc/sudoers.d/dsh-smartctl
  ```

### 跑起来

```bash
git clone https://github.com/gmyzxvym4k-maker/vLLM-Console.git
cd vLLM-Console
node --check server.js     # 语法自检
node server.js             # 前台试跑
# 浏览器打开 http://<机器IP>:8889
```

控制台默认**自动扫描本机进程**发现 vLLM/SGLang 实例（从 cmdline 里解析 `--port`/`--model-path`/`--served-model-name`）。扫不到时可设 `VLLM_PORT=8000` 固定主后端。没有任何推理实例时页面也能打开，只是数据为空。

### 按你的机器改 4 个常量（仅当你需要用「网页启动实例」功能）

在 `server.js` 里搜索常量名（别按行号，行号会漂移）：

| 常量 | 缺省值（原作者机器） | 作用 |
|---|---|---|
| `MODELS_DIR` | `/media/ll/data/models` | 模型根目录扫描 |
| `EXTRA_MODELS_DIRS` | `[]` | 附加扫描目录 |
| `VLLM_ENV` | `/home/ll/vllm-env` | 启动 vLLM 用的 Python venv |
| `SGLANG_VENV` | `/home/ll/sglang-env` | 启动 SGLang 用的 venv |

另有少量 `/home/ll/deploy/...` 绝对路径是**脚本化模型（Flash-Next）专用**，部署目录不同时整体 `sed` 替换即可；文件不存在时对应按钮自动禁用，不影响其余功能。详见[复现边界](#复现边界哪些功能绑定了原作者机器)。

### 常驻运行（systemd 用户级服务）

```bash
mkdir -p ~/.config/systemd/user
sed 's|/home/ll/deploy|/your/deploy/dir|g; s|/usr/local/bin/node|'"$(which node)"'|' \
  systemd/dsh-console.service > ~/.config/systemd/user/dsh-console.service
systemctl --user daemon-reload
systemctl --user enable --now dsh-console
loginctl enable-linger $USER   # 无登录会话也常驻
```

> ⚠️ **`KillMode=process` 必须保留**。缺省 `control-group` 会在 `systemctl restart` 时把控制台**启动的 vLLM/SGLang 实例一并杀掉**（它们是服务的子进程）。这是踩过的一次真实事故。

### 可选组件

- **`dsh-logger-pkg/`（推荐）**：vLLM `stat_logger` 插件，逐请求把 prefill/decode 统计写到部署目录 `request-traces.jsonl`，是「最近完成请求」表与行级真实 tok/s 的数据源。
  ```bash
  pip install ./dsh-logger-pkg     # 装进 vLLM 所在 venv
  # 装后需重启 vLLM 实例才加载
  ```
  SGLang 实例不需要插件（控制台直接解析其日志）。
- **日志轮转**：`ops/logrotate-console.conf`（cron 每小时 17 分，50M×4 份，`copytruncate`——不能 move，因为 node 持有文件句柄）。

## 目录结构

**仓库根目录 = 部署目录**（线上 `/home/ll/deploy` 的镜像）。server.js 用 `path.join(__dirname, ...)` 读同级运行时文件（`quickstart-presets.json`、`billing-config.json`、`console-auth.json`、`prompts/`、`bench-services.json`…），**请勿挪动这些文件的位置**，否则要同步改 server.js 常量。

```
├── server.js                  # 控制台主体（约 9900 行：HTTP 服务 + 进程发现 + 指标解析 + 硬件采样 + bench 引擎）
├── index.html                 # 主控制台页（内联 JS，每次请求实时读盘+ETag，改完刷新即生效）
├── bench.html                 # 基准测试页（iframe 嵌入主界面「基准测试」标签）
├── mobile.html                # 移动端只读视图
├── static/                    # 预编译 tailwind CSS、本地字体、Chart.js（全部本地托管，无 CDN 硬依赖）
├── prompts/                   # bench 提示词库（prompts13.json / prompts6.json，随便改）
├── systemd/dsh-console.service# systemd --user 单元模板
├── dsh-logger-pkg/            # vLLM stat_logger 插件（pip install 即装）
│
├── quickstart-presets.json    # 快速启动预设（热加载）
├── billing-config.json        # 计费单价配置
├── energy-config.json         # 能耗/电价配置
├── power-config.json          # 功率偏置
├── flashnext-scheme-170hx*.json # 脚本化模型的启动方案描述（170HX 硬件档）
├── flash-next-w4a16-launch.env  # 一次真实启动的参数快照（示例）
├── bench-services.json.example  # 远端被测服务配置样例
│
├── start-flash-next-w4a16.sh / flash-next-w4a16-inner.sh / stop-flash-next-w4a16.sh
│                              # 「脚本化模型」三层启停：外层→chroot 内层→停止（含 FN_EXTRA_ENV 展开）
├── flash-next-prewarm.sh / setup-chroot.sh / _chroot_verify.sh / fnx-18420-watchdog.sh / start-official-18420.sh
│                              # 预热、chroot 搭建与校验、端口看门狗
├── patches/                   # 历史补丁脚本存档（对 vLLM site-packages / 部署脚本的幂等修改，见 docs/PATCHES.md）
├── tools/                     # 排障辅助（A/B 换引擎脚本、KV offload 验证窗、内存测试、基准脚本）
├── ops/                       # 运维脚本（tailwind 重建、logrotate、开机提速、硬件探测）
└── docs/                      # 架构 / 补丁全录 / 踩坑实录 / 原始部署记录
```

运行时自动创建（已 gitignore）：`bench-results/`、`request-traces.jsonl`、`vllm-live-prefill.jsonl`、`*-state.json`、`server.log`、`server-error.log`。

## 配置详解

### `quickstart-presets.json`（启动预设，热加载）

数组，每项 = 一个「一键启动」按钮：`name`、`desc`、`engine`（vllm/sglang）、`args`（完整 vllm serve 参数数组，支持占位符）、`env`（附加环境变量）。改 JSON 即生效，无需重启控制台。仓库里带的示例是原作者机型的（PP2/MTP/YaRN/KV offload），照着改成你自己的启动命令即可。

### `bench-services.json`（可选，热读）

缺省 bench 只测「受管实例」（跟随控制台自动发现的端口）。要测远端引擎时按 `bench-services.json.example` 建 `bench-services.json`：数组 `{id, port, name, baseUrl, apiKey}`；`apiKey` 只在服务端使用、绝不下发浏览器。

### `billing-config.json` / `energy-config.json`

计费单价与电价/功率偏置。`billing-state.json`、`energy-state.json` 是运行时累计状态（gitignore 剔除，首次运行自动新建）。

## 环境变量

写进 systemd 单元 `Environment=` 或 shell 导出：

| 变量 | 缺省 | 说明 |
|---|---|---|
| `SERVER_PORT` | `8889` | 控制台端口 |
| `VLLM_HOST` | `127.0.0.1` | 主后端探测主机 |
| `VLLM_PORT` | 自动扫描 | 固定主后端端口（关掉端口自愈时用） |
| `VLLM_MODEL_PORTS` | `{}` | JSON 映射 `模型名→端口`（路由代理用，缺省运行时从进程自动注册） |
| `PD_MODEL_PORTS` | `{}` | PD 分离模式的模型→端口映射 |
| `VLLM_CHAT_TRIM` / `VLLM_CHAT_CAP_MAX_CHARS` / `VLLM_CHAT_KEEP_OLD_CHARS` / `VLLM_CHAT_KEEP_TAIL_CHARS` / `VLLM_CHAT_KEEP_MSG_CHARS` / `VLLM_CHAT_TRIM_CONTENT` | 内置 | 聊天代理的历史裁剪策略（长对话防爆上下文） |

## 鉴权（可选启用）

放置 `console-auth.json` 即启用（5 秒热生效，无需重启；**删除文件即关闭**）：

```bash
printf '{"token":"你的口令"}' > console-auth.json
```

- 拦截范围：`/v1/internal/` 的 **POST**（启停实例、重置计费等写操作）。前端收到 401 自动弹口令框一次，存 localStorage。
- **不受影响**：所有 GET 只读接口、`/v1` OpenAI 代理（用你原来的方式保护）。
- 该文件含口令，已 gitignore，切勿入库。

## 复现边界：哪些功能绑定了原作者机器

这是一个真实生产环境的原样开源，以下部分与原作者的硬件/路径强绑定，别人复现时按需改造：

1. **「脚本化模型」启停链路**（`start-flash-next-w4a16.sh` → `flash-next-w4a16-inner.sh` → chroot）：
   - 依赖 chroot 镜像 `/media/ll/data/vllm-image/rootfs`（Ubuntu 22 + vLLM nightly）、模型权重 `/media/ll/data/models*`、PLE n-gram 表 `/media/ll/data/ple*`。
   - 硬件是 **2×NVIDIA CMP 170HX**（矿卡魔改，第三方 cmpunlocker 解锁驱动，profile=8gb + unlock_geometry=64GB，强制 PCIe Gen2）。`setup-chroot.sh` 给出 chroot 搭建方法。
   - 不用这套时：`quickstart-presets.json` 里删掉 `script:true` 的预设即可，其余功能不受影响。
2. **`server.js` 里的机型常量**：`FLASHNEXT_SCHEME_FILE`、`SGLANG_*` 草稿模型路径等，指向不存在的路径时相关按钮禁用/隐藏，不影响核心监控。
3. **RAPL 能耗采样**：读 `/sys/devices/power/energy_uj`，Intel 平台有效；AMD/无权限时该卡片显示空。
4. **`patches/` 目录**：是对**特定 vLLM 版本**（v0.1.dev20073，chroot 镜像内）源码的补丁存档，记录我们给上游 KV offload / metrics 修 bug 的完整过程，**不需要也不应该**盲目应用到你的 vLLM 上——把它们当「上游 bug 复现与修法参考」读。

## 深入文档

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — 内部架构：进程发现、`/metrics` 缓存（400ms TTL + 单飞）、gzip/ETag 白名单、GPU 异步采样与熔断、前端轮询门控与停摆看门狗、bench 引擎闭包设计。改代码前必读。
- **[docs/PATCHES.md](docs/PATCHES.md)** — 全部补丁清单：控制台自身的每次功能/修复迭代（含回滚文件名），以及 `patches/` 里 11 个 vLLM 侧补丁的动机、内容、验证与结论。
- **[docs/PITFALLS.md](docs/PITFALLS.md)** — 踩坑实录：GPU 驱动 D 状态拖死控制台、仪表盘两次停刷的不同根因、tailwind 浏览器 JIT 性能坑、`AbortSignal.timeout` 冻结标签页不 settle……每一条都是真实付出过代价的经验。
- **[docs/DEPLOY-127-20260919.md](docs/DEPLOY-127-20260919.md)** / **[docs/README-部署说明.md](docs/README-部署说明.md)** — 原始部署记录存档。

## License

MIT（见 [LICENSE](LICENSE)）。bench 引擎移植自 bench-console v2.2.1（MIT）；Chart.js（MIT）与 Inter / IBM Plex Mono 字体（OFL 1.1）随仓库本地分发。
