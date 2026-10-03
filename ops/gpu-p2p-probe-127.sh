#!/bin/bash
# GPU P2P 通路探针 —— 192.168.1.127 CMP 170HX 双卡（03:00.0 / 04:00.0）
#
# 目的：回答"两张卡现在到底有没有在走 P2P"。分三层取证：
#   ① 拓扑层：两卡之间的物理路径（PHB = 跨 PCIe Host Bridge，无 NVLink）
#   ② 能力层：驱动/NVML 是否放行 P2P（cmpunlocker 强开 BAR1 P2P）
#   ③ 通路层：实际跨卡 copy 带宽 —— 只有这层能证明 P2P 真的能用
#
# 只读性质：不修改任何系统/驱动设置；探针分配 <1 GiB 显存，退出即释放。
# 全程硬超时：驱动异常时 nvidia-smi / CUDA 会进 D 状态（SIGKILL 无效），
#            故每个外部调用都必须套 timeout（见 09-20 铁律）。
#
# 用法（在 127 上）：  bash /home/ll/deploy/ops/gpu-p2p-probe-127.sh
# 判读口径（Gen2 x16 = 理论 8 GB/s）：
#   跨卡 copy ≥ 4.5 GB/s  → P2P 直连生效（0919 实测 5.27 GB/s 即此档）
#   跨卡 copy ≤ 3.0 GB/s  → 实际在经主机内存中转，P2P 名义可用但未承载数据
#
# 注意：本脚本测的是"P2P 通路能不能用"。NCCL 在 PP 通信里选没选它，
#       是另一回事，要靠 NCCL_DEBUG=INFO 的 transport 判决行（见文末）。

# 提权口令来源（仓库内不留明文）：CONSOLE_SUDO_PASS 环境变量或 ~/.console-sudo
# helper 查找顺序：DEPLOY_DIR → 脚本所在目录 → 上级目录，兼容仓库开发与单文件 scp 上线两种摆放。
CDIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
for _csudo_lib in "${DEPLOY_DIR:-/home/ll/deploy}/lib/sudo-pass.sh" ${CDIR:+$CDIR/lib/sudo-pass.sh} ${CDIR:+$CDIR/../lib/sudo-pass.sh}; do
  [ -n "$_csudo_lib" ] && [ -f "$_csudo_lib" ] && { . "$_csudo_lib"; break; }
done
CSUDO_PW=""; require_sudo_pass || exit 1
set -u
NVS="timeout -k 3 20 nvidia-smi"
CHROOT=${CHROOT:-/media/ll/data/vllm-image/rootfs}
PY=${PY:-/usr/bin/python3.12}

echo "==================== ① 拓扑层 ===================="
$NVS topo -m 2>&1 | sed -n '1,4p'
echo "-- NVLink --"
$NVS nvlink -s 2>&1 | grep -oiE "support Nvlink|NV[0-9]" | sort -u | head -3
echo "-- 链路速率（Gen2 锁定时 Speed 5GT/s）--"
if command -v sudo >/dev/null 2>&1; then
  sudo -n lspci -vv -s 03:00.0 2>/dev/null | grep -m1 "LnkSta:" | sed 's/^\s*/  /'
fi

echo
echo "==================== ② 能力层 ===================="
for cap in r w p a n; do
  name=$([ "$cap" = r ] && echo "read" ; [ "$cap" = w ] && echo "write" ; [ "$cap" = p ] && echo "pcie" ; [ "$cap" = a ] && echo "atomics" ; [ "$cap" = n ] && echo "nvlink")
  verdict=$($NVS topo -p2p "$cap" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' \
            | awk '/GPU[01][[:space:]]/ {print $3}' | grep -v '^$' | head -1)
  printf "  p2p %-8s = %s\n" "$name" "${verdict:-?}"
done
echo "-- 驱动侧强开痕迹（cmpunlocker）--"
dmesg 2>/dev/null | grep -aiE "CMPUNLOCK_BAR1P2P|peer-to-peer DMA memory" | tail -4 | cut -c1-125 \
  || echo "  （需 root 读 dmesg）"

echo
echo "==================== ③ 通路层（实测跨卡带宽）===================="
FREE=$($NVS --query-gpu=index,memory.free --format=csv,noheader,nounits 2>/dev/null | awk -F'[ ,]+' '{printf "GPU%s=%sMiB ", $1, $2}')
echo "  当前空闲显存: $FREE"
if [ ! -d "$CHROOT" ]; then
  echo "  跳过：找不到 $CHROOT（用 CHROOT=... 指定，或在宿主 python 环境跑同段代码）"
else
  # 探针：can_access_peer + 128MB 跨卡 copy + H2D 对照
  # 用 here-doc 经 stdin 喂给 chroot 内 python，避免引号地狱
  cat > /tmp/.gpu-p2p-probe.py <<'PYEOF'
import time, sys
try:
    import torch
except Exception as e:
    print("  import torch 失败:", e); sys.exit(1)
if torch.cuda.device_count() < 2:
    print("  可见 GPU 不足 2 张，跳过"); sys.exit(1)

print("  torch", torch.__version__, "| cuda", torch.version.cuda)
print("  can_device_access_peer(0->1):", torch.cuda.can_device_access_peer(0, 1))
print("  can_device_access_peer(1->0):", torch.cuda.can_device_access_peer(1, 0))

MB = 128
nbytes = MB * 1024 * 1024
try:
    torch.cuda.set_device(0)
    a = torch.empty(nbytes, dtype=torch.uint8, device="cuda:0"); a.fill_(7)
    torch.cuda.set_device(1)
    b = torch.empty(nbytes, dtype=torch.uint8, device="cuda:1"); b.zero_()
except RuntimeError as e:
    # 显存不够时优雅退出，绝不去挤正在服务的 vLLM worker
    print("  显存不足，放弃探针（不影响在线服务）:", str(e).splitlines()[0]); sys.exit(0)

def bench(fn, iters=20, warm=3):
    for _ in range(warm): fn()
    torch.cuda.synchronize()
    t = time.perf_counter()
    for _ in range(iters): fn()
    torch.cuda.synchronize()
    return nbytes * iters / (time.perf_counter() - t) / 1e9

torch.cuda.set_device(0)
peer = bench(lambda: b.copy_(a, non_blocking=True))
cpu_src = torch.empty(nbytes, dtype=torch.uint8, pin_memory=True)
h2d = bench(lambda: a.copy_(cpu_src, non_blocking=True))

print("  跨卡 copy (GPU0->GPU1) = %.2f GB/s" % peer)
print("  H2D copy (pinned)      = %.2f GB/s" % h2d)
print("  数据校验:", int(b[0].item()), int(b[-1].item()), "(应为 7 7)")

if peer >= 4.5:
    print("  => P2P 直连可用（带宽高于 host 中转的典型值）")
elif peer <= 3.0:
    print("  => 疑似经主机内存中转，P2P 未真正承载数据")
else:
    print("  => 中间地带，需结合 NCCL transport 判决行判断")

del a, b, cpu_src
torch.cuda.empty_cache()
PYEOF
  # 用 cp 送进 chroot（勿用 printf 内嵌代码：Python 里的引号会被二次解析）
  sudo_run true                       # 预热 sudo 时间戳
  sudo_run cp /tmp/.gpu-p2p-probe.py "$CHROOT/tmp/.gpu-p2p-probe.py" 2>/dev/null \
    || cp /tmp/.gpu-p2p-probe.py "$CHROOT/tmp/.gpu-p2p-probe.py" 2>/dev/null
  # 硬超时 180s：CUDA context 建立慢，但绝不无限等
  # 提权穿 timeout：GNU timeout 以 env -i 起子进程，父 shell 的函数与普通变量都过不去
  # （bash <4.3 还不支持导出函数），所以把口令用 printf %%q 烤成字面量再交给 sh 解析。
  timeout -k 5 180 sh -c "$(sudo_run_quoted "chroot $CHROOT $PY /tmp/.gpu-p2p-probe.py")" 2>&1 | sed 's/^/  /'
  rc=${PIPESTATUS[0]:-?}
  [ "$rc" != "0" ] && echo "  （探针退出码 $rc；124=超时，多为驱动异常，按 09-20 铁律处理）"
  rm -f /tmp/.gpu-p2p-probe.py
fi

echo
echo "==================== 附：确认 NCCL 选了哪条 transport ===================="
cat <<'NOTE'
  本脚本证明的是"P2P 通路能不能用"。NCCL 在 PP 通信里选没选它，要抓判决行：
    控制台「vLLM 附加环境变量」里临时加一行  NCCL_DEBUG=INFO
    （inner 脚本的 NCCL_DEBUG 写作 ${NCCL_DEBUG:-WARN}，附加环境变量在 source 时胜出，
      无需改脚本；重启模型后）
    日志里看：
      Channel 0 : 0[CMP 170HX] -> 1[CMP 170HX] via P2P/IPC    ← P2P 生效
      Channel 0 : 0[CMP 170HX] -> 1[CMP 170HX] via SHM/direct ← 走主机内存
  抓完记得把那行删掉，INFO 日志量很大。
  旁证：NCCL 若走 SHM transport，worker 进程会持有 32 MiB 级的 /dev/shm/nccl-* 映射
    （每连接 8 steps x 4 MiB）：
      sudo grep -c '/dev/shm/nccl' /proc/<worker_pid>/maps
NOTE
