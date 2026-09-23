#!/bin/bash
echo "      [chroot 内]"
M=/media/ll/data/models/Qwen3.8-Flash-Next-W4A16-AutoRound
[ -d "$M" ] && echo "        模型目录: OK ($(ls $M/*.safetensors | wc -l) 个分片)" || echo "        模型目录: ❌"
f=$M/model-00016-of-00017.safetensors
[ -f "$f" ] && echo "        PLE表 shard16: $(stat -c %s $f) 字节 ($(( $(stat -c %s $f) / 1024 / 1024 / 1024 )) GiB)" || echo "        PLE表: ❌"
[ -f /home/ll/deploy/flash-next-w4a16-inner.sh ] && echo "        inner 脚本: OK" || echo "        inner 脚本: ❌"
grep -h '^FN_' /home/ll/deploy/flash-next-w4a16-launch.env 2>/dev/null | sed 's/^/        env: /'
[ -d /media/ll/data/ple ] && echo "        PLE INT8 产物: OK" || echo "        PLE INT8 产物: 无"
echo "        cuda: $(/usr/bin/python3.12 -c 'import torch;print(torch.cuda.device_count(),"dev")' 2>&1)"
