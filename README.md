# VLL 管理台（8889 控制台）

- src/server.js + src/index.html：线上 ll@192.168.1.127:/home/ll/deploy/ 的工作镜像
- 部署：scp 到 /tmp → node --check → 替换 → systemctl --user restart dsh-console
- ops/logrotate-console.conf：日志轮转（cron 每小时 17 分，50M×4 保留，copytruncate）

## 鉴权（可选启用）
- 启用：`ssh ll@192.168.1.127 'printf {"token":"你的口令"} > /home/ll/deploy/console-auth.json'`（5 秒内生效，无需重启）
- 效果：/v1/internal/ 的 POST（启停模型/重置计费等）需口令；前端 401 自动弹窗输入一次（存 localStorage）
- 关闭：删除 console-auth.json 即回免鉴权现状；GET 只读与 /v1 OpenAI 代理始终不受影响
