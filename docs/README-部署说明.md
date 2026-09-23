# vLLM 管理控制台（8889）部署说明

单文件 Node 应用（零 npm 依赖，只用 Node 标准库），提供：
- 仪表盘：多实例/多卡并发请求、实时 tok/s、缓存命中率、预填充进度、PD 走势曲线
- 启动器：网页弹窗/快速启动预设一键启动 vLLM、SGLang 实例（含 TP/PP、投机解码 MTP/DFlash/DSpark/EAGLE、PD 分离模式）
- OpenAI 兼容代理：按模型名路由到对应实例端口（客户端统一指向 8889 的 /v1）
- 硬件监视页：GPU 实时/PCIe 拓扑、CPU 详情、内存带宽、磁盘 SMART/IO

## 一、环境要求
- **Linux**（依赖 /proc 探测同机 vLLM/SGLang 进程，需与推理引擎同机部署）
- **Node.js**（实测 v10 可跑，建议 ≥14）
- 可选：nvidia-smi（GPU 卡片）；smartmontools（磁盘 SMART，需 sudo 免密：
  \`echo "用户 ALL=(root) NOPASSWD: /usr/sbin/smartctl" | sudo tee /etc/sudoers.d/dsh-smartctl\`；
  lspci/perf 同理可选，缺失只影响对应卡片，不影响主功能）

## 二、部署步骤
1. 解压到部署目录（示例 \`/home/ll/deploy/\`）：把 server.js、index.html 放入。
2. **按本机修改 4 个常量**（server.js 内搜索即得）：
   - \`MODELS_DIR\`（约 4640 行）：模型根目录，默认 \`/home/ll/models\`
   - \`EXTRA_MODELS_DIRS\`（约 4643 行）：附加扫描目录，不用可改成 \`[]\`
   - \`VENV\`（约 5232 行）：vLLM 虚拟环境路径，默认 \`/home/ll/vllm-env\`
   - \`SGLANG_VENV\`（约 934 行）：SGLang 虚拟环境路径，默认 \`/home/ll/sglang-env\`
   - 文件内还有少量 \`/home/ll/deploy/...\` 绝对路径（脚本化模型 Flash-Next 专用），
     部署目录不同且不用该功能时可整体 sed 替换，不影响其余功能（文件不存在时按钮自动禁用）。
3. 先直接试跑：\`node server.js\`，浏览器打开 \`http://<机器IP>:8889\`。
4. 常驻运行：复制 systemd/dsh-console.service（用户级服务放 \`~/.config/systemd/user/\`），
   改好路径后 \`systemctl --user enable --now dsh-console\`。
   **KillMode=process 必须保留**，否则重启控制台会杀掉它启动的推理实例。

## 三、可选组件
- **dsh-logger-pkg/**（推荐）：vLLM 逐请求统计插件，"最近完成请求"表与行级速度（engine 源）的数据源。
  安装：\`pip install ./dsh-logger-pkg\`（装进 vLLM 所在 venv），**装后需重启 vLLM 实例**才加载。
  SGLang 实例无需插件（控制台直接解析其日志与 metrics）。
- 环境变量（可选，写进 service 的 Environment=）：
  \`VLLM_PORT\` 固定主后端端口（缺省自动扫描进程，支持端口自愈）；
  \`SERVER_PORT\` 控制台端口（缺省 8889）；
  \`VLLM_MODEL_PORTS\` / \`PD_MODEL_PORTS\` JSON 型模型→端口映射（缺省运行时自动注册）。

## 四、使用要点
- index.html 每次请求实时读取：**改前端刷新页面即生效**，无需重启服务；改 server.js 需重启。
- 「最近完成请求」若整表无数据：检查 vLLM venv 是否装了 dsh-logger-pkg 并在启动**之前**装好
  （与 vLLM 同分钟安装不会被加载，重启一次即可），vLLM 日志里应出现
  \`Available plugins for group vllm.stat_logger_plugins: - dsh_vllm_logger\`。
- 客户端接入：OpenAI base_url 填 \`http://<机器IP>:8889/v1\`，模型名用仪表盘"模型信息"里显示的名字。
- 数据文件（request-traces.jsonl 等）都写在部署目录下，磁盘紧张时定期清理即可。
