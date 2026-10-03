#!/bin/bash
# lib/sudo-pass.sh — 提权口令的统一来源（被 deploy/ 与 tools/ 下的运维脚本 source）
#
# 【为什么不把口令写进脚本】
# 早期版本的 start/stop/watchdog 各脚本硬编码 `echo <明文口令> | sudo -S`，随仓库公开发布后
# 等于把所有受管机器的 root 权限交出去，且明文进了 git 历史、clone 下来就能翻到。
# 因此仓库内的脚本一律不得出现明文口令。
#
# 【口令从哪里来，按优先级】
#   1) 环境变量 CONSOLE_SUDO_PASS          —— 临时/CI 场景：CONSOLE_SUDO_PASS=xxx ./start-....sh
#   2) 配置文件 ${CONSOLE_SUDO_FILE:-~/.console-sudo}  —— 常态：单机部署专用，文件权限必须 600
#   3) 交互式输入                            —— 都没有时现场问一句（TTY 环境下可用）
#   以上皆无 -> 直接 fail-fast 报错退出，绝不静默降级成"猜一个口令"。
#
# 【部署机上怎么建这个文件】
#   umask 077 && printf '%s\n' '<你的sudo口令>' > ~/.console-sudo   # 落盘即 600
#   或由 systemd/控制台侧下发 CONSOLE_SUDO_PASS 环境变量（见 README「提权口令」一节）。
#
# 【对外提供的东西】
#   CSUDO_PW           口令字符串（仅在有口令时有值）
#   sudo_run <cmd...>  以 sudo 执行命令；口令不足 3 个字符 / sudo 不可用时自动回退裸 sudo
#   require_sudo_pass  无口令即报错退出（供必须提权的脚本在入口处先卡一道）
#   warm_sudo          预热 sudo 时间戳（后续调用免重复输口令）
#
# 注意：本文件只做"取口令 + 喂给 sudo -S"，不放任何具体运维命令。

# 防止重复 source 造成函数重复定义
if [ -n "${_CSUDO_LIB_LOADED:-}" ]; then
  return 0 2>/dev/null || true
fi
_CSUDO_LIB_LOADED=1

_csudo_log() { echo "[sudo-pass] $*" >&2; }

require_sudo_pass() {
  local pwfile="${CONSOLE_SUDO_FILE:-$HOME/.console-sudo}"
  CSUDO_PW=""
  # 无条件把口令送进子 shell：`( export CSUDO_PW; … )` 只有在它已被标记 export 的情况下
  # 才会带上值，否则子 shell 拿到空串，sudo_run 会误判成"无口令"而走裸 sudo 分支
  # （现象：timeout 报 sudo_run: not found。2026-10-07 沙盒回归实锤）。
  export CSUDO_PW
  if [ -n "${CONSOLE_SUDO_PASS:-}" ]; then
    CSUDO_PW="$CONSOLE_SUDO_PASS"
    return 0
  fi
  if [ -r "$pwfile" ]; then
    # 只取首行、剥掉行尾 CR（兼容 Windows 记事本存的口令文件），空格一概不动
    CSUDO_PW="$(head -1 "$pwfile" 2>/dev/null | tr -d '\r')"
    if [ -n "$CSUDO_PW" ]; then
      # 权限过松就提醒：别人能读走的口令文件等于没加密
      local perm
      perm=$(stat -c '%a' "$pwfile" 2>/dev/null || stat -f '%Lp' "$pwfile" 2>/dev/null || echo "")
      case "$perm" in
        600|400|700|500) ;;
        "") ;;
        *) _csudo_log "警告：$pwfile 权限为 $perm，建议 chmod 600" ;;
      esac
      return 0
    fi
  fi
  # 交互式兜底：只在真的是终端时才问，避免 cron/看门狗里挂死
  if [ -t 0 ] && [ "${CONSOLE_SUDO_INTERACTIVE:-1}" = "1" ]; then
    printf '[sudo-pass] 未配置提权口令（CONSOLE_SUDO_PASS 或 %s），请输入 sudo 口令: ' "$pwfile" >&2
    IFS= read -rs CSUDO_PW >&2 || CSUDO_PW=""
    printf '\n' >&2
    [ -n "$CSUDO_PW" ] && return 0
  fi
  _csudo_log "错误：取不到提权口令。请二选一："
  _csudo_log "  ① export CONSOLE_SUDO_PASS='<sudo口令>'"
  _csudo_log "  ② umask 077 && printf '%s\\\\n' '<sudo口令>' > ${pwfile}"
  return 1
}

# 把函数本身送进子 shell：`bash -c '...sudo_run...'` 这类上下文里若不 export，
# 会出现 "sudo_run: not found"。（口令的 export 在 require_sudo_pass 开头无条件完成。）
_export_csudo() {
  export -f sudo_run _csudo_log 2>/dev/null || true
}
_export_csudo

# 把任意字符串安全地包成 shell 单引号字面量（内部的单引号按 '"'"' 规矩拆开再拼回）。
# 用途：口令要塞进一条"将由另一个 shell 解析"的命令串时，用它防止空格/引号/$/反引号
# 把命令拆坏或被二次求值。
csudo_quote() {
  # 把任意字符串转成一个可安全嵌入"将被另一个 shell 解析的命令串"的字面量。
  # 直接用 bash 内建的 printf %q（自己按单引号切段极易出错：段没累加、空段覆盖、
  # 模式里多写一个反斜杠就会静默丢掉前半段——2026-10-07 三连踩）。
  # 用途：运维脚本要把口令塞进 timeout/sh 二次求值的命令行时使用。
  printf '%q' "${1-}"
}

# 需要在"另一个 shell 里"以 root 跑命令时用这个（典型：外面套了 GNU timeout，
# 它会 env -i 起子进程，父 shell 的函数和普通变量都过不去，只有把值烤进命令字符串才行）。
# 用法: sudo_run_quoted <命令字符串>
#   例: timeout -k 5 180 sh -c "$(sudo_run_quoted 'chroot /fs python3 p.py')"
# 命令串里的 $ 若想留给内层展开，记得用单引号包住那部分。
sudo_run_quoted() {
  if [ -z "${CSUDO_PW:-}" ]; then
    printf 'sudo %s' "$(csudo_quote "$1")"
  else
    printf 'printf %%s\\n %s | sudo -S %s' "$(csudo_quote "$CSUDO_PW")" "$(csudo_quote "$1")"
  fi
}

# 以 sudo 执行。无口令（例如该机 ll 已配 NOPASSWD 白名单）时回退裸 sudo。
# 两点刻意的取舍：
#   ① 不注入 -p ''：否则调用方自带的 -p '' 会变成重复参数，多出的 -p 把后面的命令名当
#      提示语吃掉（表现为命令静默不执行）。需要静音提示词的调用方自己写 sudo_run -p '' …
#   ② 不对口令做任何裁剪/规整：首尾空格可能就是口令的一部分，改了反而认证失败。
sudo_run() {
  if [ -z "${CSUDO_PW:-}" ]; then
    sudo "$@"
  else
    printf '%s\n' "$CSUDO_PW" | sudo -S "$@"
  fi
}

# 预热 sudo 时间戳：长脚本里第一次提权成功后，后续几次就不用再喂口令
warm_sudo() {
  [ -n "${CSUDO_PW:-}" ] || return 0
  printf '%s\n' "$CSUDO_PW" | sudo -S -k -p '' true 2>/dev/null || true
  printf '%s\n' "$CSUDO_PW" | sudo -S -p '' true 2>/dev/null || true
}
