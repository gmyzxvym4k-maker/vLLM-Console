#!/bin/bash
# NCCL transport 判决探针 —— 192.168.1.127 CMP 170HX 双卡
#
# 回答"P2P 通路可用"之外的那个真问题：**NCCL 在 PP 通信里到底选了哪条 transport**。
# 做法：用与生产完全相同的 NCCL 环境变量，另起一个 2 进程的小集合通信，
#       打开 NCCL_DEBUG=INFO + SUBSYS=TRANSPORT，直接抓判决行。
#       不需要重启在线的 vLLM 服务。
#
# 只读性质：不改任何设置；探针自身占用 <1 GiB/卡 显存，退出即释放。
# 前提：两张卡的空闲显存都要够建 CUDA context（约 400 MiB/卡）。显存不足时
#       探针自己报错退出，不会去挤占在线 worker。
# 全程硬超时（见 09-20 铁律：驱动异常时 GPU 调用会进 D 状态）。
#
# 用法（在 127 上）：bash /home/ll/deploy/ops/gpu-nccl-transport-probe-127.sh
# 判读：
#   via P2P/IPC     → NCCL 在用 GPU 直通（P2P 生效）
#   via SHM/direct  → NCCL 在经主机内存中转（P2P 名义可用但没被使用）

# 提权口令来源（仓库内不留明文）：CONSOLE_SUDO_PASS 环境变量或 ~/.console-sudo
# helper 查找顺序：DEPLOY_DIR → 脚本所在目录 → 上级目录，兼容仓库开发与单文件 scp 上线两种摆放。
CDIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
for _csudo_lib in "${DEPLOY_DIR:-/home/ll/deploy}/lib/sudo-pass.sh" ${CDIR:+$CDIR/lib/sudo-pass.sh} ${CDIR:+$CDIR/../lib/sudo-pass.sh}; do
  [ -n "$_csudo_lib" ] && [ -f "$_csudo_lib" ] && { . "$_csudo_lib"; break; }
done
CSUDO_PW=""; require_sudo_pass || exit 1
set -u
CHROOT=${CHROOT:-/media/ll/data/vllm-image/rootfs}
PY=${PY:-/usr/bin/python3.12}
# 与 flash-next-w4a16-inner.sh 的生产设置保持一致（勿随意增删，否则测的不是线上通路）
ENVV="NCCL_P2P_LEVEL=PHB NCCL_SHM_DISABLE=0 NCCL_CUMEM_ENABLE=0 NCCL_NET_GDR_LEVEL=0"
MASTER_PORT=${MASTER_PORT:-29613}

echo "==================== 空闲显存 ===================="
timeout -k 3 20 nvidia-smi --query-gpu=index,memory.free --format=csv,noheader 2>&1 | sed 's/^/  /'

echo
echo "==================== NCCL transport 判决 ===================="
cat > /tmp/.nccl-transport-probe.py <<'PYEOF'
import os, sys, time
try:
    import torch
    import torch.distributed as dist
except Exception as e:
    print("[probe] import 失败:", e); sys.exit(1)

rank = int(os.environ.get("RANK", "0"))
world = int(os.environ.get("WORLD_SIZE", "2"))
if torch.cuda.device_count() < world:
    print("[probe] GPU 数量不足"); sys.exit(1)

try:
    torch.cuda.set_device(rank)
    dist.init_process_group(backend="nccl", init_method="env://", world_size=world, rank=rank)
except RuntimeError as e:
    print("[probe] 初始化失败（多半显存不足，不影响在线服务）:", str(e).splitlines()[0]); sys.exit(0)

t = torch.full((4096,), float(rank + 1), device="cuda:%d" % rank)
dist.all_reduce(t)                       # 集合通信路径（coll）
torch.cuda.synchronize()
if rank == 0:                            # 点对点路径（PP 的 send/recv 就是这条）
    dist.send(t, dst=1)
else:
    dist.recv(t, src=0)                  # 注意：src 是对端 rank，写成自己会 NCCL internal error
torch.cuda.synchronize()

# 自证：走 P2P 时进程里还会不会有 /dev/shm/nccl-* 映射？
# （用于解释生产 worker 的 SHM 指纹 —— 有映射 ≠ 数据走 SHM）
def nccl_shm():
    tot = cnt = 0
    try:
        for l in open("/proc/self/maps"):
            if "/dev/shm/nccl" in l:
                a, b = l.split()[0].split("-"); tot += int(b, 16) - int(a, 16); cnt += 1
    except Exception:
        pass
    return cnt, tot // (1024 * 1024)
c, mb = nccl_shm()
print("[probe] rank%d: /dev/shm/nccl 映射 %d 段 / %d MiB（P2P 生效时同样可能存在）" % (rank, c, mb), flush=True)

if rank == 0:
    print("[probe] allreduce+sendrecv OK, sum =", int(t[0].item()), flush=True)
time.sleep(2)
dist.destroy_process_group()
PYEOF

sudo_run true                      # 预热 sudo 时间戳
# 注意：本机宿主 /tmp 与 $CHROOT/tmp 是同一 bind 挂载，cp 会报"同一文件"返回 1。
# 别拿 cp 的返回码当判据（比路径字符串也不可靠，bind 挂载下两者路径本就不同）；
# 唯一可信的判据是"chroot 内看得见这个文件"。
INPATH="/tmp/.nccl-transport-probe.py"
sudo_run cp -f "$INPATH" "$CHROOT$INPATH" 2>/dev/null || true
sudo_run test -f "$CHROOT$INPATH" || { echo "  chroot 内看不到 $INPATH，放弃"; exit 1; }

# NCCL_DEBUG_SUBSYS 只开 TRANSPORT+INIT，避免全量 INFO 刷屏
# 提权穿 timeout：同上，口令经 printf %q 烤成字面量，不依赖函数导出/变量继承。
timeout -k 5 240 sh -c "$(sudo_run_quoted "chroot $CHROOT env $ENVV NCCL_DEBUG=INFO NCCL_DEBUG_SUBSYS=TRANSPORT,INIT MASTER_ADDR=127.0.0.1 MASTER_PORT=$MASTER_PORT $PY -m torch.distributed.run --nproc_per_node=2 --master_port=$MASTER_PORT $INPATH")" 2>&1 | tee /tmp/.nccl-transport-raw.txt >/dev/null

echo "-- 判决行（去色后）--"
sed 's/\x1b\[[0-9;]*m//g' /tmp/.nccl-transport-raw.txt \
  | grep -aoE "(via P2P/(IPC|direct|LD)|via SHM/(direct|segment)|via NET/[a-z]+)[^\"]*" \
  | sort | uniq -c | sort -rn | head -12 | sed 's/^/  /'

echo "-- 计数 --"
for pat in "via P2P" "via SHM" "via NET" "P2P is disabled" "via direct"; do
  c=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/.nccl-transport-raw.txt 2>/dev/null | grep -ac "$pat")
  printf "  %-18s %s\n" "$pat" "$c"
done
echo "-- 探针自述 --"
grep -a "\[probe\]" /tmp/.nccl-transport-raw.txt | sed 's/^/  /' | head -5
echo "-- 其它关键行 --"
sed 's/\x1b\[[0-9;]*m//g' /tmp/.nccl-transport-raw.txt | grep -aiE "p2p|nvlink|shared memory|out of memory" | grep -av "via " | head -8 | cut -c1-150 | sed 's/^/  /'

rm -f /tmp/.nccl-transport-probe.py
echo
echo "（原始输出留在 /tmp/.nccl-transport-raw.txt，可自行 grep）"
