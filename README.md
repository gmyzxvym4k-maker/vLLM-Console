# VLL 管理台（8889 控制台）

- src/server.js + src/index.html：线上 ll@192.168.1.127:/home/ll/deploy/ 的工作镜像
- 部署：scp 到 /tmp → node --check → 替换 → systemctl --user restart dsh-console
- ops/logrotate-console.conf：日志轮转（cron 每小时 17 分，50M×4 保留，copytruncate）
