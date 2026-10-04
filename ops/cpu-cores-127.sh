#!/bin/bash
# CPU 核心在线/下线开关 —— 192.168.1.127（Intel Xeon E5-2696 v4，22 核同构，HT 未启用）
#
# 背景：该机 22 个逻辑 CPU 就是 22 个同构物理核（无大小核、无超线程配对），
#       编号 n 与 Core ID n 一一对应，"关奇数编号"= 精确关掉 11 个物理核。
#
# 用法（在 127 本机执行，或 ssh ll@192.168.1.126 'bash /home/ll/deploy/ops/cpu-cores-127.sh <cmd>'）：
#   cpu-cores-127.sh status          查看当前在线/离线核心与服务健康
#   cpu-cores-127.sh off <目标>       下线核心：<目标> 可为 odd / even / 显式列表
#                                    列表支持逗号与区间，如 off 2,6,10,14,18 或 off 4-9
#                                    （CPU0 会被自动忽略——内核不允许下线它）
#   cpu-cores-127.sh on              恢复全部核心上线
#
# 递进示例（"每轮再关一半"用隔一个关一个，保留物理散布均匀）：
#   off odd            → 22 核变 11 核（留 0,2,4,...,20）
#   off 2,6,10,14,18   → 11 核变 6 核（留 0,4,8,12,16,20，步进 4）
#
# 生效范围：sysfs CPU 热插拔，**重启即失效**（内核重新枚举全部 22 核）。
#   要开机持久少核，走 /etc/default/grub 加 isolcpus= 或 maxcpus=，那是另一回事，
#   本脚本故意不碰 grub —— isolcpus 只把核从调度域摘掉、不等于下线。
#
# 安全性：
#   - CPU0 不可下线（无 /sys/devices/system/cpu/cpu0/online 文件），脚本强制跳过；
#   - 系统无任何绑核配置（无 isolcpus / taskset / numactl / cpuset，09-26 已核），
#     下线时内核自动把该核上的任务迁到在线核，vLLM 与控制台不会被打断；
#   - 中断由内核自动从下线核迁走，无需手动调 irq affinity。
#
# 提权：ll 无免密 sudo，口令走 lib/sudo-pass.sh 的统一约定（仓库内不留明文）：
#       CONSOLE_SUDO_PASS 环境变量 → ~/.console-sudo（chmod 600）→ 交互输入。
#       兼容旧写法 CPW=<口令> 覆盖。
#
# 已知代价（下线一半核后）：
#   - vLLM CPU 侧只剩 11 核：OffloadingConnector 的 CPU KV 拷贝、tokenizer/detokenize、
#     --async-scheduling、PLE n-gram mmap 查找都受影响；冷启动加载阶段尤其明显。
#   - 带载吞吐的瓶颈本来在 GPU（SM 频率受 210W 功耗墙支配），CPU 减半对稳态 decode
#     影响有限；实测请对比 /v1/internal/stats 或 bench.html。

set -u
HOST_SELF=1
DEF_ONLINE_ALL="0-21"
# 提权口令（见文件头说明）：CPW 仅作向后兼容的覆盖入口
CONSOLE_SUDO_PASS="${CPW:-${CONSOLE_SUDO_PASS:-}}"
# helper 查找顺序：DEPLOY_DIR → 脚本所在目录 → 上级目录，兼容仓库开发与单文件 scp 上线两种摆放。
CDIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
for _csudo_lib in "${DEPLOY_DIR:-/home/ll/deploy}/lib/sudo-pass.sh" ${CDIR:+$CDIR/lib/sudo-pass.sh} ${CDIR:+$CDIR/../lib/sudo-pass.sh}; do
  [ -n "$_csudo_lib" ] && [ -f "$_csudo_lib" ] && { . "$_csudo_lib"; break; }
done
if [ -z "${CSUDO_PW+isset}" ]; then CSUDO_PW=""; require_sudo_pass || exit 1; fi
SYS=/sys/devices/system/cpu

say() { printf '%s\n' "$*"; }

run_root() {  # 以 root 执行一段 shell
  sudo_run sh -c "$1"
}

do_status() {
  local on off n
  on=$(cat "$SYS/online" 2>/dev/null || echo "?")
  off=$(cat "$SYS/offline" 2>/dev/null || true)
  n=$(nproc 2>/dev/null)
  say "在线 CPU : $on"
  say "离线 CPU : ${off:-（无）}"
  say "可用核数 : $n / 22"
  say "--- 受管服务健康 ---"
  local c_node c_vllm c_vl
  c_node=$(pgrep -f "node /home/ll/deploy/server.js" | head -1)
  c_vllm=$(pgrep -f "VLLM::EngineCore"   | head -1)
  say "控制台进程 : ${c_node:-未运行}   HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:8889/ 2>/dev/null || echo ERR)"
  say "EngineCore : ${c_vllm:-未运行}   /v1/models HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:18420/v1/models 2>/dev/null || echo ERR)"
  say "--- 负载 ---"; uptime
}

# 把 "2,6,10-13" 展开成 "2 6 10 11 12 13"（逗号分隔 + 可选区间）
expand_list() {
  local spec="${1//,/ }" out="" tok a b i
  for tok in $spec; do
    case "$tok" in
      ''|*[!0-9-]*) say "非法核心编号: $tok"; exit 2 ;;
    esac
    if [ "${tok#*-}" != "$tok" ]; then          # 含 '-' → 区间
      a=${tok%%-*}; b=${tok##*-}
      for ((i=a; i<=b; i++)); do out="$out $i"; done
    else out="$out $tok"; fi
  done
  echo $out
}

# 参数：odd | even | 显式编号列表（如 2,6,10,14,18）。CPU0 永不关。
do_off() {
  local mode="${1:-odd}" cores=""
  case "$mode" in
    odd)  cores=$(seq 1 2 21 | tr '\n' ' ') ;;
    even) cores=$(seq 2 2 21 | tr '\n' ' ') ;;
    *)    cores=$(expand_list "$mode") ;;
  esac
  local drop="" c
  for c in $cores; do                       # 剔除 CPU0：内核不允许下线它
    [ "$c" = 0 ] && { say "注意：已忽略 CPU0（不可下线）"; continue; }
    drop="$drop $c"
  done
  [ -z "${drop// /}" ] && { say "没有可下线的核心"; exit 2; }
  say "即将下线核心 [$drop]（保留 CPU0），当前在线：$(cat $SYS/online)"
  run_root "
    for c in $drop; do
      f=$SYS/cpu\${c}/online
      [ -e \"\$f\" ] || { echo \"cpu\${c} 无 online 节点，跳过\"; continue; }
      if echo 0 > \"\$f\" 2>/dev/null; then echo \"cpu\${c} -> offline\"
      else echo \"cpu\${c} -> FAILED\"; fi
    done"
  say "--- 下线后 ---"
  do_status
}

# do_on [all | 编号列表]：缺省恢复全部 22 核
do_on() {
  local spec="${1:-all}" cores=""
  if [ "$spec" = "all" ]; then cores=$(seq 1 21 | tr '\n' ' ')
  else cores=$(expand_list "$spec"); fi
  say "即将上线核心 [$cores]"
  run_root "
    for c in $cores; do
      f=$SYS/cpu\${c}/online
      [ -e \"\$f\" ] || continue
      [ \"\$(cat \$f)\" = 1 ] && { echo \"cpu\${c} 已在线\"; continue; }
      if echo 1 > \"\$f\" 2>/dev/null; then echo \"cpu\${c} -> online\"
      else echo \"cpu\${c} -> FAILED\"; fi
    done"
  say "--- 上线后 ---"
  do_status
}

in_list() { local x="$1"; shift; local y; for y in $@; do [ "$y" = "$x" ] && return 0; done; return 1; }

# do_set <目标在线列表>：按目标集合自动算差集（先上线缺的、再下线多的），
# 语义与"我要的就是这几个核在线"一致；CPU0 无法下线，会被强制保留。
do_set() {
  if [ -z "${1:-}" ]; then
    say "用法: $0 set 0,2,4,6,8,10,20,21   （目标在线核心集合）"; exit 2
  fi
  local want cur add="" drop="" c
  want=$(expand_list "$1")
  cur=$(expand_list "$(cat "$SYS/online")")
  in_list 0 $want || say "注意：目标集合不含 CPU0，但 CPU0 无法下线，将保留为在线"
  for c in $want; do in_list $c $cur || add="$add $c"; done
  for c in $cur;  do in_list $c $want || { [ "$c" = 0 ] && continue; drop="$drop $c"; }; done
  say "目标在线 : $want"
  say "当前在线 : $cur"
  say "需上线   :${add:- （无）}"
  say "需下线   :${drop:- （无）}"
  if [ -z "${add// /}" ] && [ -z "${drop// /}" ]; then
    say "已经是目标状态。"; do_status; return 0
  fi
  # 顺序固定：先上线再下线，避免出现比目标更少的中间态（瞬时 CPU 饥饿）
  if [ -n "${add// /}" ]; then
    run_root "
      for c in $add; do
        f=$SYS/cpu\${c}/online
        [ -e \"\$f\" ] || { echo \"cpu\${c} 无 online 节点，跳过\"; continue; }
        if echo 1 > \"\$f\" 2>/dev/null; then echo \"cpu\${c} -> online\"
        else echo \"cpu\${c} -> FAILED\"; fi
      done"
  fi
  if [ -n "${drop// /}" ]; then
    run_root "
      for c in $drop; do
        f=$SYS/cpu\${c}/online
        [ -e \"\$f\" ] || continue
        if echo 0 > \"\$f\" 2>/dev/null; then echo \"cpu\${c} -> offline\"
        else echo \"cpu\${c} -> FAILED\"; fi
      done"
  fi
  say "--- 设定后 ---"
  do_status
}

case "${1:-status}" in
  status) do_status ;;
  off)    do_off "${2:-odd}" ;;
  on)     do_on "${2:-all}" ;;
  set)    do_set "${2:-}" ;;
  *) say "用法: $0 [status | off odd|even|<编号列表> | on [<编号列表>|all] | set <在线编号列表>]"; exit 2 ;;
esac
