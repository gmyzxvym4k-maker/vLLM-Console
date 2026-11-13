# arca.live 帖子摘要（#186266420）

标题：자기전에 빨간약 코드 하나 더 투척하고 잠（睡前再扔一个红药丸代码然后睡觉）
作者 akaJ，2026-10-18，AI 로컬 홈랩 채널

## 正文要点

- 动机：很多人想知道自己手上的 CMP 170HX 是「뿔딱（劣质卡）」还是能开到 sm126 的「효자（好卡）」。
- 做法：把已公开的信息组合成一个程序，从 GPU 的 fuse 标签推算**解锁上限**（作者承认是 GPT 写的）。
- 放在正文而不是评论：代码太长会被截断。
- 提醒：作者承认可能有恶意代码，务必让自己的 agent 先审一遍再跑。
- 作者自己的结果：**8GB 型号，108 SM / 80 GiB 上限**。
- 解释：所谓上限不是"绝对不能超过"，而是 NVIDIA 给每个核心打了「正常 / 劣质 / 禁用」标签，程序据此推算。
- 用法：脚本运行需要 CMP 的 BDF 与 UUID，所以最省事的办法是把代码交给 agent，说"帮我检查一下"。

## 脚本概况

- 平台：Linux x86-64 / CPython 3.8+ / 只用标准库 / 需 sudo。
- 访问面：只开被选中那张卡的 `resource0`（`O_RDONLY|O_CLOEXEC|O_NOFOLLOW`），
  `mmap(MAP_SHARED, PROT_READ)`，只读白名单里的寄存器字。
- 无 nvidia-smi 子进程、无 ioctl、无 /dev/mem、无驱动改动、无回退通路、不写 GPU 寄存器。
- 身份校验：PCI ID 必须 `10de:20c2`（8GB SKU）或 `10de:2082`（10GB SKU），
  UUID / Bus Location 必须与驱动缓存一致，`power_state=D0` 且 runtime active，
  BAR0 必须是有效内存资源且 ≥ 8.5 MiB。
- 一致性：两次 pass 比对，值变即中止；`0xFFFFFFFF` / `0xBADF0000` 哨兵即中止；
  子进程 fork + 15 s 超时 + SIGKILL 回收，防止 BAR0 SIGBUS/挂死被误判为成功。
