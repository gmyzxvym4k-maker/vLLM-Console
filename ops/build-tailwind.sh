#!/bin/bash
# 重新生成 8889 控制台预编译 CSS（改过 index.html 的 class 后执行）
# 依赖：控制台机上 /tmp/tw 已 npm i tailwindcss@3.4.17
# 目标机 IP 会变（09-26 →110，09-26 晚 →127，10-05 换装后 →192.168.1.126），用 CONSOLE_HOST 覆盖。
set -e
HOST="${CONSOLE_HOST:-ll@192.168.1.126}"
ssh "$HOST" 'cd /tmp/tw && printf "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n" > input.css && npx tailwindcss -i input.css -o tailwind-build.css --content /home/ll/deploy/index.html --minify && cp tailwind-build.css /home/ll/deploy/static/'
echo "已重建并部署 static/tailwind-build.css"
