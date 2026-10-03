#!/bin/bash
# 停止 W4A16 Flash-Next 实例（进程属 root，需 sudo）。
# 铁律（2026-09-15/19 实锤）：绝不先手 SIGKILL 持 CUDA 上下文进程——触发 Xid31→GPU 降级→唯一修复整机重启。
# 正解：SIGTERM 等满 90s；僵尸(Z)不计入存活；超时不退才 SIGKILL 兜底。
# 进程识别：vLLM setproctitle 改名 VLLM::EngineCore / VLLM::Worker_PP0/1（comm 截断 15 字符）；
# 主 APIServer 的 comm 恒为 python3，只能按 cmdline 的 entrypoints.cli.main 匹配（括号防自匹配）。
# 人工停止闩锁（09-26）：置位后看门狗不再拉起，直到任一 start 脚本清除（与新栈同机制）
: > /home/ll/deploy/fnx-manual-stop
# 提权口令来源（仓库内不留明文）：CONSOLE_SUDO_PASS 环境变量 → ~/.console-sudo（600）→ 交互输入。
# helper 查找顺序：DEPLOY_DIR → 脚本所在目录 → 上级目录，兼容仓库开发与单文件 scp 上线两种摆放。
CDIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
for _csudo_lib in "${DEPLOY_DIR:-/home/ll/deploy}/lib/sudo-pass.sh" ${CDIR:+$CDIR/lib/sudo-pass.sh} ${CDIR:+$CDIR/../lib/sudo-pass.sh}; do
  [ -n "$_csudo_lib" ] && [ -f "$_csudo_lib" ] && { . "$_csudo_lib"; break; }
done
require_sudo_pass || exit 1
require_sudo_pass || exit 1
sudo_run sh -c '
find_pids() {
  { ps -eo pid=,comm= | awk "\$2 ~ /^VLLM::/ {print \$1}"
    ps -eo pid=,args= | grep "[e]ntrypoints[./]cli[./]main" | awk "{print \$1}"; } | sort -u
}
alive_count() {
  n=0
  for pid in $(find_pids); do
    st=$(sed "s/.*) //" /proc/$pid/stat 2>/dev/null | cut -d" " -f1)
    [ "$st" != "Z" ] && [ -n "$st" ] && n=$((n+1))
  done
  echo $n
}
PIDS=$(find_pids)
if [ -z "$PIDS" ]; then echo "[stop] 无存活进程"; exit 0; fi
echo "[stop] SIGTERM -> $PIDS"
kill -TERM $PIDS 2>/dev/null
for i in $(seq 1 90); do
  [ "$(alive_count)" = "0" ] && break
  sleep 1
done
LEFT=$(alive_count)
if [ "$LEFT" != "0" ]; then
  echo "[stop] 90s 后仍存活 $LEFT 个，SIGKILL 兜底（注意查 dmesg Xid）"
  kill -9 $(find_pids) 2>/dev/null
  sleep 3
fi
exit 0
'
sleep 3
echo "[stop] GPU 显存（期望两卡接近 0）："
nvidia-smi --query-gpu=index,memory.used --format=csv,noheader

# 停止后立刻预热 PLE 表页缓存：刚释放的 96.8 GiB 匿名内存正好装下这张 95.4 GiB 的表，
# 下次启动的表读取从 97s 降到 ~20s。后台跑，不阻塞 stop 返回。
if [ -x /home/ll/deploy/flash-next-prewarm.sh ]; then
  echo "[stop] 已触发 PLE 表页缓存预热（后台，日志 flash-next-prewarm.log）"
  setsid bash /home/ll/deploy/flash-next-prewarm.sh >/dev/null 2>&1 < /dev/null &
fi
