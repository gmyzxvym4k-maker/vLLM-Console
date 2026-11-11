# DSV4.1-Flash 专属配置服务（:8002）

线上位置：`/home/ll/dsv41-config-server.py`、`/home/ll/dsv41-config.html`，由系统级
`dsv41-config.service` 以 `ll` 用户运行，监听 `:8002`；8889 控制台的「DSV4.1 配置」标签
用 iframe 内嵌本页。

本目录保存的是这两份线上文件的源码副本（2026-11-11 抓取，md5 与线上一致后才修改）。
配方（recipe）路径：`/home/ll/dsv41-flash-cmp170hx-recipe`，配置文件为 recipe 下的 `.env`。

## 功能：默认启动配置（[default-start-1111]）

页面新增「默认启动配置」卡片，把一套确认可用的启动参数保存为可恢复的快照：

- **保存运行中配置为默认**：优先推荐。用当前容器真实 cmdline 的
  `--max-model-len / --max-num-seqs / --max-num-batched-tokens / --served-model-name`
  与宿主发布端口，覆盖到当前 `.env` 上生成快照；其余键（P2P、API Key 等）沿用 `.env`。
  这样即使 `.env` 里有尚未应用的「待生效」编辑，保存的也是实际在跑的那套参数。
- **保存 .env 为默认**：直接把当前 `.env` 存为快照（适用于容器未运行、或明确想保存
  下一次启动将使用的配置时）。
- **载入默认配置到表单**：只改表单，不写 `.env`；确认后点「保存」或「保存并应用」。
- **用默认配置覆盖 .env**：覆盖前自动备份当前 `.env`，不会重启容器；需再点
  「保存并应用」才生效。
- **清除默认配置**：只删除快照，不影响 `.env` 与运行中的容器。
- **启动模型时自动套用默认配置**（参数开关，缺省关闭）：启用后，「启动模型」会在
  `./start.sh start` 之前先把默认快照写回 `.env`（原 `.env` 自动备份到
  `logs/env-backups/`）；「保存并应用」（重建容器）不受此开关影响，始终使用表单保存的
  `.env`。套用失败会中止启动（fail closed），不会拿半改的 `.env` 去启动。

快照文件（均为 `600 ll:ll`）：

- `logs/default-start.env`：完整 `.env` 副本（含 API Key，仅在服务端可读）；
- `logs/default-start.json`：元数据（保存时间、来源 running/env、操作者 IP、脱敏后的展示值、
  `auto_start` 开关、sha256）；
- `logs/default-backups/default-*.env`：上一份默认快照的自动备份，最多保留 10 份。

API：

- `GET /api/config`、`GET /api/status`：响应新增 `defaults` 字段；
- `GET /api/defaults`：只读快照摘要；
- `POST /api/defaults`（需 `X-Admin-Key`）：
  - `{"action":"save","source":"running"}` 或 `{"source":"env"}`；
  - `{"action":"load"}`、`{"action":"clear"}`；
  - `{"action":"auto_start","value":true|false}`。
- `POST /api/config` 支持 `saveAsDefault: true`：保存表单到 `.env` 的同时更新默认快照
  （页面「同时存为默认启动配置」勾选框）。

## 部署

线上文件不在 8889 控制台的 `/home/ll/deploy` 下，而在 `/home/ll` 根目录：

```bash
ssh ll@192.168.1.127 '
  cd /home/ll
  cp -p dsv41-config-server.py dsv41-config-server.py.bak-$(date +%Y%m%d-%H%M%S)
  cp -p dsv41-config.html   dsv41-config.html.bak-$(date +%Y%m%d-%H%M%S)
'
scp dsv41-config-server.py ll@192.168.1.127:/home/ll/dsv41-config-server.py
scp dsv41-config.html      ll@192.168.1.127:/home/ll/dsv41-config.html
ssh ll@192.168.1.127 'python3 -m py_compile /home/ll/dsv41-config-server.py; \
  PW=$(cat ~/.console-sudo); echo "$PW" | sudo -S -p "" systemctl restart dsv41-config.service'
```

页面 HTML 每次请求读盘并返回 `Cache-Control: no-store`；修改页面**不需要重启服务**。
修改 Python 服务需要重启 `dsv41-config.service`（不影响 `dsv41-flash` 容器）。
控制台标签内的「重载页面」按钮会重新拉取 iframe。

2026-11-11 本次上线备份：

- `dsv41-config-server.py.bak-defaultcfg-1111-20261111-110219`
- `dsv41-config.html.bak-defaultcfg-1111-20261111-110219`
- `dsv41-config-*.bak-defaultcfg2-1111-20261111-110646`
- `dsv41-config-*.bak-defaultcfg3-1111-20261111-111022`

## 测试

```bash
cd dsv41-config
python3 test_default_config.py     # 纯标准库；在临时目录里跑，不碰生产 recipe
```

测试覆盖：快照保存/权限/元数据脱敏、`.env` 差异计算、自动套用参数、显式 load、
`_service_worker("start")` 的 fail-closed 套用路径、HTTP `/api/config`、`/api/status`、
`/api/defaults` 各 action，以及「无字段改动 + saveAsDefault」的 no-op 快照。

## 注意

- 默认快照是完整的 `.env` 副本，含 API Key；不要把它复制到仓库或对外发送。
- 生产 `.env` 与默认快照是两份独立文件；页面会显示两者的字段级差异。
- 若容器正在加载（`/health` 非 200），「保存运行中配置」按钮禁用，避免把回落的
  `.env` 值当成运行值保存。
- 配方升级（`./start.sh update`）不会自动改动 `logs/default-start.*`；如需保留旧默认，
  先在页面「保存 .env 为默认」或另存副本。
