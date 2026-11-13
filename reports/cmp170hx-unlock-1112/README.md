# CMP 170HX ×4 显存解锁上限核查（2026-11-12）

数据来源：Arca Live 帖《자기전에 빨간약 코드 하나 더 투척하고 잠》（<https://arca.live/b/aihomelab/186266420>）
里附带的只读探针 `check_cmp170hx_readonly.py`，在 192.168.1.127（ll-desktop，4×CMP 170HX，驱动 610.43.03 + cmpunlocker）上逐卡实跑。

## 一、结论

| 项目 | 数值 |
| --- | --- |
| 单卡解锁显存 | **64 GiB**（65536 MiB，已生效） |
| 4 卡合计 | **256 GiB**（262 144 MiB） |
| 单卡物理硬顶 | 64 GiB（板上 HBM 颗粒总容量，câmpunlocker 也只提供 64GB geometry：CFG1=0x02779000 / LMR=0x0000020B） |
| 控制器级“条件上限” | 80 GiB（存在 2 个干净但被熔丝关闭的 FBP），但**没有对应物理颗粒、也没有对应 geometry → 不可达** |
| 缺陷 FBP（永久不可恢复） | 2 个（bit 6、11）= 16 GiB |

四张卡实测都已吃到 64 GiB，`nvidia-smi` 每卡 `Total 65536 MiB / Reserved 625 MiB / Used 64102 MiB / Free 810 MiB`。
现场跑的是 dsv41-flash 容器（`DSV4.1-Flash`），四卡合计占用约 250.4 GiB，功耗 61~73 W，温度 42~44 ℃。

## 二、逐卡明细（探针原始掩码推算）

| 卡 | BDF | 当前 SM | SM 条件上限 | 缺陷 TPC 数 | 显存现值 | 显存物理上限 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| GPU0 | 0000:07:00.0 | 74 | **124** | 2（GPC6-T7、GPC7-T4） | 64 GiB | 64 GiB |
| GPU1 | 0000:0a:00.0 | 74 | **124** | 2（GPC4-T6、GPC6-T2） | 64 GiB | 64 GiB |
| GPU2 | 0000:0e:00.0 | 74 | **112** | 8（GPC2 整块 8 个 TPC） | 64 GiB | 64 GiB |
| GPU3 | 0000:0f:00.0 | 74 | **108** | 10（GPC1 整块 8 + GPC2-T2 + GPC5-T5） | 64 GiB | 64 GiB |

SM 口径：GA100 全 die = 8 GPC × 8 TPC × 2 SM = 128 SM；条件上限 = (64 − 带缺陷标记的 TPC 数) × 2（帖子的算法，只排除“缺陷标记”，不排除“熔丝关闭”）。
四卡 SM 条件上限合计 **468 SM**，现状合计 **296 SM**（4 × 74）。

## 三、显存掩码（四卡完全一致）

- `OPT_FBP_DISABLE` = bits 1、4、6、11；`OPT_FBP_DEFECTIVE` = bits 6、11
- `OPT_FBPA_DISABLE` = 2、3、8、9、12、13、22、23；`OPT_FBPA_DEFECTIVE` = 12、13、22、23
- 结论：24 个 FBPA（每个 4 GiB）里 16 个在用 = 64 GiB；4 个“干净但关闭”（2、3、8、9）= 条件上的 +16 GiB；4 个带物理缺陷 = 永久损失 16 GiB。
- 帖子里作者的 8GB 卡是同型结论（108 SM / 80 GiB 条件上限）；评论区多人确认：板上 HBM 只装了 4 颗，软件再多也到不了 80 GiB。

## 四、探针安全性

- 只用 `O_RDONLY | O_CLOEXEC | O_NOFOLLOW` 打开 `sysfs resource0`，`MAP_SHARED + PROT_READ` 映射，只读白名单寄存器（GA100 fuse shadow / status 区 0x0082xxxx）。
- 无寄存器写、无 fuse 命令、无 ioctl、无 `/dev/mem`、无 subprocess、不做设备枚举；两次快照比对一致才出结果。
- 四卡均 `status=COMPLETE`、`second_read_matches=true`，未被运行中的推理引擎干扰（读时 GPU0/1/3 利用率 90~98%，GPU2 26%）。

## 五、复跑方法

```bash
scp tools/cmp170hx/check_cmp170hx_readonly.py ll@192.168.1.127:/tmp/
ssh ll@192.168.1.127 'PW=$(cat ~/.console-sudo); echo "$PW" | sudo -S -p "" \
  python3 -I -B /tmp/check_cmp170hx_readonly.py \
  --bdf 0000:07:00.0 --uuid GPU-17828b1c-beeb-d6ef-12ba-f1de437440bc'
```

参数必须显式给 BDF 与 UUID（脚本不做自动发现）；输出 JSON 到 stdout，退出码 0=完整、2=中止。
原始四份 JSON 见本目录 `gpu0-07.00.0.json` … `gpu3-0f.00.0.json`。
