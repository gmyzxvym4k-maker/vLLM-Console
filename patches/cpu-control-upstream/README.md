# cpu-control — i5-14600K 运行时 CPU 控制台

运行时控制 msi 服务器（Ubuntu, i5-14600K）的 CPU：逐核上/下线、任意上/下限频率、超线程开关、小核一键切换、逐核性能测试。属于 [vLLM 管理监控台（dsh-console）](..)「硬件控制」页的后端 + 集成代码，**全部为运行时软控制，重启回 BIOS 默认**。

## 文件

| 文件 | 说明 |
|---|---|
| `cpu-ctl-14k` | 单文件 bash 控制脚本（装到 `/usr/local/bin/`，poly 用户免密 sudo 自动提权） |
| `dsh-console-server.snippet.js` | 控制台 server.js 集成片段（两个 HTTP 接口） |
| `dsh-console-ui.snippet.js` | 控制台前端 CPU 控制卡的全部 JS |

## 拓扑事实（全部实测，换平台前别套用）

i5-14600K，20 个逻辑槽位内核全部 present：

| 槽位 | 身份 | 运行时可控性 |
|---|---|---|
| cpu 0,2,4,6,8,10 | P 核主线程（单核 5.3GHz，恒在线的是 cpu0） | 可下线（cpu0 无 `online` 文件除外） |
| cpu 1,3,5,7,9,11 | P 核的 SMT 兄弟线程 | 由 `smt/control` 整体开关（见下） |
| cpu 12–19 | E 小核簇（单核 4.0GHz，core_id 24+） | 可随意上/下线（本机被 `offline-ecores.service` 开机下线，**不是 BIOS 禁用**） |

**超线程的关键认知**：内核 cmdline 带 `nosmt` 时，SMT 兄弟槽位 present 但离线。此时直接写单个 `cpuN/online` 会被内核拒绝（写 1 读回 0）——**但这不代表超线程运行时不可切**。正确开关是：

```bash
cat /sys/devices/system/cpu/smt/control        # off（nosmt 只是开机初值，文件仍可写）
echo on  | sudo tee /sys/devices/system/cpu/smt/control   # 立即 12 线程（online 0-11）
echo off | sudo tee /sys/devices/system/cpu/smt/control   # 秒回 6 核
```

无需重启、无需动 GRUB（`forceoff` 才是 BIOS 级真不可切）。本项目第一版走过「改 GRUB + 重启」的弯路，已删除。

## 锁频认知（实测定案）

锁频**是精确生效的**，以负载下的实际频率为准：

- 锁上限 3G → 满载恒 3000MHz
- 上下限同钉 4.6G → 满载恒 4600MHz

**空闲核的 `scaling_cur_freq` 读数会低于锁定下限（甚至 0.8G）**——APERF/MPERF 把 C-state 空闲周期计入，是读数特性不是失效。想验证锁频就看满载频率。

## cpu-ctl-14k 命令

```
cpu-ctl-14k status --json        总览 JSON（逐核 type/online/cur/min/max/governor/epp/siblings + smtControl）
cpu-ctl-14k freq max 4.5G [spec] 限最高频率     spec: all|p|e|0-7,16（频率支持 4.5G/3800M/kHz）
cpu-ctl-14k freq min 800M [spec] 锁最低频率（任意下限，下限>上限会被拒）
cpu-ctl-14k freq reset           恢复改动前的原始上/下限（首次改动时自动记忆）
cpu-ctl-14k gov performance      调速器（performance/powersave）
cpu-ctl-14k epp balance_performance  能效偏好（HWP EPP）
cpu-ctl-14k ecore on|off|list    一键上/下线全部小核（cpu12-19）
cpu-ctl-14k core on|off <n>      单个逻辑核上/下线（在线核将 <2 时拒绝，防失联）
cpu-ctl-14k ht on|off|status     超线程（smt/control 运行时直切，立即生效）
cpu-ctl-14k bench [秒]           性能测试：逐核单线程满载×3 轮取中位（体质分+峰值频率）+ 多核并行总分
```

## 设计思路

1. **单文件 bash + sysfs，零依赖**：所有控制本质上就是写 `/sys/devices/system/cpu/...`，bash + `sudo tee` 足够，不需要额外服务。脚本自动提权，既能 SSH 手跑也能被服务端 spawn。
2. **P/E 分类是学习式的**：E 核离线时读不到 `cpuinfo_max_freq`，脚本把在线核中 max_freq 比最高档低 ≥500MHz 的记为 E 并缓存到 `/var/lib/cpu-ctl-14k/ecores`。缓存**与旧值并集合并（只增不减）**——只统计在线核会把缓存覆盖残缺（实测踩坑：只有 cpu13 在线时缓存被覆盖成只剩 13）。
3. **状态 JSON 用 python3 产出**：bash 拼 JSON 不可靠，`status --json` 内嵌 python3 组装，服务端直接 `JSON.parse`。
4. **dsh-console 集成走 action 白名单**：`POST /v1/internal/cpuctl/cmd` 的 body 里只传 `{action, freq, spec, cpu, secs}`，服务端映射到脚本参数并校验正则（频率 `/^\d+(\.\d+)?[GgMm]?$/`、规格 `all|p|e|编号串`），杜绝任意命令注入。bench 动态放宽超时（`secs×20s+180s`）。
5. **前端防抖规矩**：核瓦片 DOM 只在「核集合签名」变化时重建，每拍只刷新数值（否则 5s 轮询会打掉用户正点着的按钮）；瓦片点击上/下线，hover 用纯 CSS（JS 改 inline style 会污染 Playwright 断言）。

## 实测数据（14600K，6 P 核，2026-09-26）

- 逐核体质分（1s×3 轮中位）：35.8M–38.9M 迭代/s，全部冲上 5.30GHz 峰值
- 多核并行总分（6 核同时满载 1s 求和）：约 195–222M
- E 核上线后：`cpuinfo_max_freq` = 4.0GHz，与 P 核同页管理
- 超线程 round-trip：`smt/control` on → online 0-11（12 线程）；off → 0,2,4,6,8,10

## 已知坑（别再踩）

- `freq reset` 无事可做时函数末尾的 `[[ ]] && echo` 会短路返回 1，必须显式 `return 0`
- `nosmt` ≠ 运行时不可切超线程（见上）；单核 online 写入被拒只说明该路径被禁
- E 核分类缓存必须并集合并（见设计思路 2）
- cpu0 没有 `online` 文件 = 恒在线，判定逻辑要写 `onv is None → online`
- intel_pstate active + 无 HWP 下 `scaling_min_freq` 语义见「锁频认知」，UI 必须把空闲读数置灰标注，否则用户会以为锁频失效
