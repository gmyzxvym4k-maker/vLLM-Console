#!/bin/bash
# 重新生成 8889 控制台预编译 CSS（改过 index.html 的 class 后执行）
# 依赖：127 上 /tmp/tw 已 npm i tailwindcss@3.4.17
set -e
ssh ll@192.168.1.127 'cd /tmp/tw && printf "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n" > input.css && npx tailwindcss -i input.css -o tailwind-build.css --content /home/ll/deploy/index.html --minify && cp tailwind-build.css /home/ll/deploy/static/'
echo "已重建并部署 static/tailwind-build.css"
