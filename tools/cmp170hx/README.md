# CMP 170HX 解锁上限只读探测（源自 arca.live aihomelab #186266420）

## 来源

- 帖子：<https://arca.live/b/aihomelab/186266420>（作者 akaJ，2026-10-18 02:13）
- 脚本：`check_cmp170hx_readonly.py`（版本号 `2026-10-18.generic.1`，从帖子正文原样提取）
- 作者自述：其卡为 8GB SKU，fuse 推算上限 **108 SM / 80 GiB**

脚本原理：不跑 fuse READ 命令、不写任何寄存器，只通过 `O_RDONLY|PROT_READ` 的
sysfs BAR0（`/sys/bus/pci/devices/<BDF>/resource0`）映射，读一组列入白名单的
GA100 shadow / status 寄存器（`OPT_*_DISABLE`、`OPT_*_DEFECTIVE`、`STATUS_OPT_*`、
`CTRL_OPT_*`、`EN_SW_OVERRIDE` 等），两次采样比对防漂移，凡出现哨兵值
`0xFFFFFFFF` / `0xBADFxxxx` 即中止，不重试、无回退路径。

## 本机实测（192.168.1.127，4×CMP 170HX，cmpunlocker 64GB 档）

四张卡全部 `COMPLETE`（rc=0，两次采样一致）：

| 卡 | BDF | 有效 GPC | TPC | SM 上限 | FBPA | 显存上限 | 实际 NVML |
|----|-----|---------|-----|--------|------|---------|-----------|
| GPU0 | 0000:07:00.0 | 5/8 (0,1,3,4,5) | 37 | **74** | 16/24 | **64 GiB** | 4736 核 / 65536 MiB |
| GPU1 | 0000:0a:00.0 | 5/8 (1,2,3,5,7) | 37 | **74** | 16/24 | **64 GiB** | 4736 核 / 65536 MiB |
| GPU2 | 0000:0e:00.0 | 5/8 (1,3,4,5,7) | 37 | **74** | 16/24 | **64 GiB** | 4736 核 / 65536 MiB |
| GPU3 | 0000:0f:00.0 | 5/8 (0,3,4,6,7) | 37 | **74** | 16/24 | **64 GiB** | 4736 核 / 65536 MiB |

NVML `nvmlDeviceGetNumGpuCores` 报 4736 = 74 SM × 64 FP32 核（GA100 每 SM 64 核），
与 fuse 推算逐卡吻合 —— 说明 **4 张卡都跑在 fuse 允许的上限上，没有剩余可解锁的
SM 或显存**。

## 口径与结论

1. **SM**：GA100 派生 8 GPC × 8 TPC × 2 SM = 128 SM 满血。本机每卡整块关 3 个 GPC，
   存活 5 个 GPC，其中每 GPC 再关 TPC0（部分 GPC 全开）→ 37 TPC → 74 SM。
   关掉的 GPC/TPC 多数**没有** defect 标记（仅 g2 的 GPC2、g3 的 GPC1 有），
   属于典型的「产品分级配置屏蔽」而非废核。
2. **显存**：24 个 FBPA 位中关 8 个，留 16 个；实测按 4 GiB/位 → 64 GiB，与
   `nvidia-smi` 显示的 65536 MiB 完全一致（作者 80 GiB = 20 位，同一换算成立）。
   12 个 FBP 位中有效 8 个。
3. **四卡 GPC 屏蔽位各不相同**（0/1/3/4/5、1/2/3/5/7、1/3/4/5/7、0/3/4/6/7），
   但 FBPA/FBIO 屏蔽位四卡完全一致 —— 显存是统一锁到 64 GiB 的，SM 是逐卡按良率
   分档的。
4. **被屏蔽但无 defect 的单元不能用软件"救活"**：fuse 是 OTP，写它需要专用命令且
   不可逆，砖卡风险高；cmpunlocker 只解显存几何/PCIe，不动 SM 拓扑
   （`OPT_SECURE_GSP_DEBUG_DIS=1`、`EN_SW_OVERRIDE=0`，软件覆盖通道是关的）。
   想要更高 SM/显存只能换 fuse 更宽松的批次。
5. 本快照是**配置/缺陷标签**，不是健康测试；脚本自身也声明 "classification only,
   not an unlock limit"。

## 复跑

```bash
# 目标机（需 root 读 resource0）
scp check_cmp170hx_readonly.py ll@192.168.1.127:/tmp/
# 口令走仓库统一入口（lib/sudo-pass.sh 的约定），不写进命令行：
#   CONSOLE_SUDO_PASS=… 或落盘 ~/.console-sudo（600），二者皆无则 fail-fast。
ssh ll@192.168.1.127 'PW=$(cat ${CONSOLE_SUDO_FILE:-~/.console-sudo}); echo "$PW" | sudo -S -p "" \
  python3 -I -B /tmp/check_cmp170hx_readonly.py \
  --bdf 0000:07:00.0 --uuid GPU-17828b1c-beeb-d6ef-12ba-f1de437440bc > /tmp/probe.json'
```

BDF/UUID 现查：`nvidia-smi --query-gpu=index,pci.bus_id,uuid --format=csv,noheader`
（注意 sysfs 路径用小写 BDF，脚本内部会自己归一到小写）。

本地复算：

```bash
python3 analyze.py probe-g0.json probe-g1.json probe-g2.json probe-g3.json
```

## 文件

- `check_cmp170hx_readonly.py` —— 只读探测脚本（网页提取，缩进压成 2 空格，语义等价，`py_compile` 通过）
- `probe-g0..g3.json` —— 四张卡原始 JSON 报告
- `analyze.py` —— 从 JSON 复算 SM / 显存上限
- `notes.md` —— 帖子内容中文摘要

---

# 第二轮复测（2026-11-12 08:0x，按微信文档《社区工具-解锁上限自查-20261111.md》口径）

## 复现性

用 `tools/check_cmp170hx_readonly.py`（规范缩进原件，md5 `c8f1304b…`）逐卡重跑一遍，
`probe2-g0..g3.json`：

- 四卡仍全部 `COMPLETE`，`rc=0`；
- **53 个寄存器值两轮逐值一致**（差异 0），`second_read_matches` 全 True；
- `interpretation` 两轮 `==` 全等。

→ 读数是稳定的，不是偶发；两次之间引擎一直在跑（容器 dsv41-flash 未重启），
说明忙态下 BAR0 只读采样同样稳定。

## 关键修正：现状上限 ≠ 可救上限

第一轮只报了「现状上限」。按微信文档的口径（`disabled_without_defect_flag` = 关着但没
标坏 = FF 烧写/VFI 的目标），我把 **「现状」与「按 fuse 标签折算的可救上限」拆开算**
（`recoverable.py`）：

| 卡 | 现状 SM | 可救 SM | 增量 | 现状显存 | 可救显存 |
|----|--------|--------|------|---------|---------|
| GPU0 07:00.0 | 74 | **124** | +50 (+67%) | 64 GiB | **80 GiB** |
| GPU1 0a:00.0 | 74 | **124** | +50 (+67%) | 64 GiB | **80 GiB** |
| GPU2 0e:00.0 | 74 | **112** | +38 (+51%) | 64 GiB | **80 GiB** |
| GPU3 0f:00.0 | 74 | **108** | +34 (+46%) | 64 GiB | **80 GiB** |

逐卡明细（只救「disable 且无 defect 标记」的单元；GPC 本身带缺陷标记则整块不救）：

- GPU0：GPC2 整块可救 8 TPC（+16 SM）、GPC6 可救 7（+14）、GPC7 可救 7（+14）、
  GPC0/1/3 的 TPC0（+6）
- GPU1：GPC0 可救 8（+16）、GPC4 可救 7（+14）、GPC6 可救 7（+14）、GPC1/2/7 的 TPC0（+6）
- GPU2：GPC0 可救 8（+16）、GPC6 可救 8（+16）、GPC1/3/7 的 TPC0（+6）；
  **GPC2 带缺陷标记（8 个 TPC 全标坏）→ 整块不救**
- GPU3：GPC2 可救 7（+14）、GPC5 可救 7（+14）、GPC0/3/6 的 TPC0（+6）；
  **GPC1 带缺陷标记 → 整块不救**
- 显存四卡一致：FBPA 禁用 8 位中 `[2,3,8,9]` **无缺陷标记** → 可救 4 位 × 4 GiB = +16 GiB
  → **80 GiB**。FBP 侧可救位 `[1,4]`。

## 与社区样本对上了

微信文档列的社区样本：「SM 上限从 108 到 124 都有、个别报 126（63 TPC）；有人 110」。
我们的四张按同一口径落在 **124 / 124 / 112 / 108**，显存全部 **80 GiB** ——
**作者那张报「108 SM / 80 GiB」的卡，与我们的 GPU3 属于同一档 fuse 配置**。
也就是说这个折算口径是自洽的：80 GiB 正是 64 + 4×4 的算式结果。

## 微信文档的两处与实际脚本不符（复核记录）

1. **「1032 行」**：实际脚本 `wc -l` = **492 行**（版本号 `2026-10-18.generic.1`）。
   帖子正文每行源码单独一个 `<p>`，网页行数看上去约翻倍，应是按网页显示数记的。
2. **「比 gpcprobe 多了 … `STATUS_OPT_TRP` 生效值」**：脚本 `REGISTERS` 表里 **没有
   `STATUS_OPT_TRP`**，只有 `STATUS_OPT_{GPC,FBP,FBPA,FBIO}` 与 `STATUS_OPT_TPC_GPC0..7`。
   该描述与本地这份脚本不符（可能是别的工具或别的版本）。

其余复核项成立：语法通过、无写路径、`--bdf`/`--uuid` 双绑定、偏移与 `gpcprobe` 家族一致。

## 口径边界（必须连同结论一起看）

- 这是 **fuse 标签折算**，不是实测：`classification_only_not_an_unlock_limit: true`。
- 「无缺陷标记」只说明产线没标坏，不等于该单元物理可用；救活后仍需实测稳定性。
- 救活 = 改写 OTP fuse，**不可逆**，且需要 VFI 类电压毛刺时序；四张卡逐卡不同配置，
  没有通用脚本，失败即砖卡。
- 收益结构：SM 增加主要利好 **prefill（算力受限段）**，decode 受 HBM 带宽支配基本不变；
  显存 +16 GiB 对 KV 池是 +25% 容量。
