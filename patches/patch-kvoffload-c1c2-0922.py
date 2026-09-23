#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kvoffload c1+c2 补丁重建版（2026-09-22），针对 chroot 镜像
vllm v0.1.dev20073 的 OffloadingConnector，使 Qwen3.8-Flash-Next（PP2 +
QSA 环形缓冲 CircularBufferSpec）能启用 CPU KV 二级缓存。

三文件 13 处：
  A) offloading/config.py  1 处：整除断言只对 prefix_cacheable 分组成立
  B) offloading/scheduler.py 11 处：把非前缀可缓存分组从
     对齐检测/分组分类/keys/block_ids/hit/touch/store/load 链路排除，
     但保留其在 kv_group_configs 中的位置（group_idx 是承重下标）
  C) v1/kv_offload/cpu/spec.py 1 处：pp_size>1 时 _uses_shared_region
     返回 False，worker 用每 rank 私有 pinned 缓冲（共享 mmap 的
     "创建者按自己尺寸 ftruncate、joiner 等自己尺寸" 协议在 PP 下死锁）

用法：
  patch-kvoffload-c1c2-0922.py --check      # 报告每 hunk 状态
  patch-kvoffload-c1c2-0922.py --self-test  # 锚点唯一性校验（不落盘）
  patch-kvoffload-c1c2-0922.py --apply      # 备份 *.bak-kvoff-0922 后应用 + py_compile
  patch-kvoffload-c1c2-0922.py --revert     # 从备份还原
"""
import argparse
import py_compile
import shutil
import sys

import os

ROOT = os.environ.get(
    "KVOFF_ROOT",
    "/media/ll/data/vllm-image/rootfs/usr/local/lib/python3.12/dist-packages/vllm",
)
F_CONFIG = f"{ROOT}/distributed/kv_transfer/kv_connector/v1/offloading/config.py"
F_SCHED = f"{ROOT}/distributed/kv_transfer/kv_connector/v1/offloading/scheduler.py"
F_SPEC = f"{ROOT}/v1/kv_offload/cpu/spec.py"
MARK = "[local-patch kvoff-"
BAK_SUFFIX = ".bak-kvoff-0922"

# ---------------------------------------------------------------- hunks ----
HUNKS = {
    F_CONFIG: [
        # A1
        (
            """    _, tokens_per_hash = resolve_kv_cache_block_sizes(kv_cache_config, vllm_config)
    for group in groups:
        assert group.tokens_per_block % tokens_per_hash == 0, (""",
            """    _, tokens_per_hash = resolve_kv_cache_block_sizes(kv_cache_config, vllm_config)
    # [local-patch kvoff-c1] The divisibility check only makes sense for
    # prefix-cacheable groups: the core kv_cache_coordinator filters by
    # spec.prefix_cacheable before running the same check. Non-cacheable
    # groups (e.g. the QSA key ring, CircularBufferSpec block_size=8)
    # must not trip this assert.
    for _kv_group, group in zip(kv_cache_config.kv_cache_groups, groups):
        if not getattr(_kv_group.kv_cache_spec, "prefix_cacheable", True):
            continue
        assert group.tokens_per_block % tokens_per_hash == 0, (""",
        ),
    ],
    F_SCHED: [
        # B1 GroupOffloadConfig 字段
        (
            "    is_eagle_group: bool = False\n\n\ndef get_sliding_window_size_in_chunks(",
            """    is_eagle_group: bool = False
    # [local-patch kvoff-c1] False for groups whose KV can never be reused
    # via prefix matching (e.g. the QSA key ring, CircularBufferSpec). Such
    # groups are excluded from store/load/lookup entirely while keeping
    # their position in kv_group_configs (group_idx is load-bearing).
    prefix_cacheable: bool = True


def get_sliding_window_size_in_chunks(""",
        ),
        # B2 from_spec 对齐检测循环
        (
            """        for idx, tokens_per_block in enumerate(spec.tokens_per_block):
            kv_spec = kv_cache_config.kv_cache_groups[idx].kv_cache_spec
            sw = get_sliding_window_size_in_chunks(
                kv_spec, tokens_per_block * spec.blocks_per_chunk
            )
            if sw is None:
                full_attn_tokens_per_chunk.add(tokens_per_block * spec.blocks_per_chunk)""",
            """        for idx, tokens_per_block in enumerate(spec.tokens_per_block):
            kv_spec = kv_cache_config.kv_cache_groups[idx].kv_cache_spec
            # [local-patch kvoff-c1] non-prefix-cacheable groups never take
            # part in chunk alignment detection.
            if not getattr(kv_spec, "prefix_cacheable", True):
                continue
            sw = get_sliding_window_size_in_chunks(
                kv_spec, tokens_per_block * spec.blocks_per_chunk
            )
            if sw is None:
                full_attn_tokens_per_chunk.add(tokens_per_block * spec.blocks_per_chunk)""",
        ),
        # B3 from_spec 主循环 sw 计算
        (
            """        for idx, tokens_per_block in enumerate(spec.tokens_per_block):
            kv_cache_group = kv_cache_config.kv_cache_groups[idx]
            kv_spec = kv_cache_group.kv_cache_spec
            sw = get_sliding_window_size_in_chunks(
                kv_spec, tokens_per_block * spec.blocks_per_chunk
            )
            kv_group_configs_list.append(""",
            """        for idx, tokens_per_block in enumerate(spec.tokens_per_block):
            kv_cache_group = kv_cache_config.kv_cache_groups[idx]
            kv_spec = kv_cache_group.kv_cache_spec
            # [local-patch kvoff-c1] ring specs are not among the window
            # helper's four recognized kinds (would hit its FullAttention
            # assert); they are excluded downstream, so skip classification.
            group_prefix_cacheable = bool(getattr(kv_spec, "prefix_cacheable", True))
            sw = (
                get_sliding_window_size_in_chunks(
                    kv_spec, tokens_per_block * spec.blocks_per_chunk
                )
                if group_prefix_cacheable
                else None
            )
            kv_group_configs_list.append(""",
        ),
        # B4 from_spec 构造参数
        (
            """                    requires_cow_source=(
                        isinstance(kv_spec, MambaSpec)
                        and kv_spec.mamba_cache_mode == "align"
                    ),
                )""",
            """                    requires_cow_source=(
                        isinstance(kv_spec, MambaSpec)
                        and kv_spec.mamba_cache_mode == "align"
                    ),
                    prefix_cacheable=group_prefix_cacheable,
                )""",
        ),
        # B5 __init__ 分组分类
        (
            """        for group_config in self.config.kv_group_configs:
            if group_config.sliding_window_size_in_chunks is None:
                full_attention_groups.append(group_config.group_idx)
            else:
                sliding_window_groups.append(group_config.group_idx)""",
            """        for group_config in self.config.kv_group_configs:
            # [local-patch kvoff-c1] keep non-cacheable groups out of the
            # lookup classification (position in kv_group_configs is kept).
            if not group_config.prefix_cacheable:
                continue
            if group_config.sliding_window_size_in_chunks is None:
                full_attention_groups.append(group_config.group_idx)
            else:
                sliding_window_groups.append(group_config.group_idx)""",
        ),
        # B6 update_offload_keys
        (
            """        for group_config, group_state in zip(
            self.config.kv_group_configs, self.group_states
        ):
            for req_block_hash in islice(""",
            """        for group_config, group_state in zip(
            self.config.kv_group_configs, self.group_states
        ):
            # [local-patch kvoff-c1] no offload keys for non-cacheable groups.
            if not group_config.prefix_cacheable:
                continue
            for req_block_hash in islice(""",
        ),
        # B7 update_block_id_groups
        (
            """        assert len(new_block_id_groups) == len(self.group_states)
        for group_state, new_blocks in zip(self.group_states, new_block_id_groups):
            group_state.block_ids.extend(new_blocks)""",
            """        assert len(new_block_id_groups) == len(self.group_states)
        # [local-patch kvoff-c1] skip non-cacheable groups but keep positions.
        for group_config, group_state, new_blocks in zip(
            self.config.kv_group_configs, self.group_states, new_block_id_groups
        ):
            if not group_config.prefix_cacheable:
                continue
            group_state.block_ids.extend(new_blocks)""",
        ),
        # B8 update_num_hit_chunks
        (
            """        for group_config, group_state in zip(
            self.config.kv_group_configs, self.group_states
        ):
            group_state.num_hit_chunks = (
                num_cached_tokens // group_config.tokens_per_chunk
            )""",
            """        for group_config, group_state in zip(
            self.config.kv_group_configs, self.group_states
        ):
            # [local-patch kvoff-c1]
            if not group_config.prefix_cacheable:
                continue
            group_state.num_hit_chunks = (
                num_cached_tokens // group_config.tokens_per_chunk
            )""",
        ),
        # B9 _touch
        (
            """        for group_config, group_state in zip(
            self.config.kv_group_configs, req_status.group_states
        ):
            if group_config.sliding_window_size_in_chunks is None:
                self.manager.touch(group_state.offload_keys, req_status.req_context)""",
            """        for group_config, group_state in zip(
            self.config.kv_group_configs, req_status.group_states
        ):
            # [local-patch kvoff-c1]
            if not group_config.prefix_cacheable:
                continue
            if group_config.sliding_window_size_in_chunks is None:
                self.manager.touch(group_state.offload_keys, req_status.req_context)""",
        ),
        # B10 update_state_after_alloc：跳过 + 0 占位保位置
        (
            """        ):
            self._current_batch_allocated_block_ids.update(
                block.block_id for block in group_blocks if block.block_id != 0
            )

            tokens_per_block = group_config.tokens_per_block""",
            """        ):
            # [local-patch kvoff-c1] non-cacheable groups are never stored or
            # loaded; append 0 placeholders so group_sizes/block_indices stay
            # positionally aligned with kv_cache_groups on the worker side.
            if not group_config.prefix_cacheable:
                group_sizes.append(0)
                block_indices.append(0)
                continue

            self._current_batch_allocated_block_ids.update(
                block.block_id for block in group_blocks if block.block_id != 0
            )

            tokens_per_block = group_config.tokens_per_block""",
        ),
        # B11 _build_store_jobs 收集循环
        (
            """            for group_config, group_state in zip(
                self.config.kv_group_configs, req_status.group_states
            ):
                num_chunks = req_status.storable_chunks(
                    group_config, group_state, num_offloadable_tokens
                )

                start_chunk_idx = group_state.next_stored_chunk_idx""",
            """            for group_config, group_state in zip(
                self.config.kv_group_configs, req_status.group_states
            ):
                # [local-patch kvoff-c1]
                if not group_config.prefix_cacheable:
                    continue
                num_chunks = req_status.storable_chunks(
                    group_config, group_state, num_offloadable_tokens
                )

                start_chunk_idx = group_state.next_stored_chunk_idx""",
        ),
    ],
    F_SPEC: [
        # C1
        (
            '''    def _uses_shared_region(self) -> bool:
        """Whether the worker CPU buffer is the shared mmap region (vs a private
        per-rank tensor); replicated-layout dedup is gated on this being True."""
        return current_platform.is_cuda_alike()''',
            '''    def _uses_shared_region(self) -> bool:
        """Whether the worker CPU buffer is the shared mmap region (vs a private
        per-rank tensor); replicated-layout dedup is gated on this being True."""
        # [local-patch kvoff-c2] Under PP>1 each rank covers a different layer
        # subset, so its row stride differs; the shared-region protocol has the
        # creator ftruncate to *its* size while joiners wait for *their*
        # expected size -> timeout, and block slots would overlap anyway.
        # Fall back to private per-rank pinned tensors (total pinned across
        # ranks stays cpu_bytes_to_use, each rank only stores its own layers).
        if self.config.parallel.pp_size > 1:
            return False
        return current_platform.is_cuda_alike()''',
        ),
    ],
}


def read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def status(path: str) -> list:
    src = read(path)
    out = []
    for i, (old, new) in enumerate(HUNKS[path], 1):
        applied = new in src
        pristin = (old in src) and (old not in new)
        if applied:
            out.append(f"{i:02d} APPLIED")
        elif pristin:
            out.append(f"{i:02d} PRISTINE")
        else:
            out.append(f"{i:02d} ANCHOR-MISSING(!)")
    return out


def self_test() -> int:
    rc = 0
    for path, hunks in HUNKS.items():
        try:
            src = read(path)
        except OSError as e:
            print(f"[self-test] READ-FAIL {path}: {e}")
            return 2
        for i, (old, new) in enumerate(hunks, 1):
            n_old, n_new = src.count(old), src.count(new)
            if n_new == 1 and (n_old == 0 or old in new):
                print(f"[self-test] OK(applied)   {path.rsplit('/',1)[-1]} #{i:02d}")
            elif n_old == 1 and n_new == 0:
                print(f"[self-test] OK(pristine)  {path.rsplit('/',1)[-1]} #{i:02d}")
            else:
                print(
                    f"[self-test] FAIL(anchor)  {path.rsplit('/',1)[-1]} #{i:02d} "
                    f"old={n_old} new={n_new}"
                )
                rc = 1
    return rc


def apply() -> int:
    if self_test() != 0:
        print("[apply] 锚点校验失败，未做任何修改。")
        return 1
    for path, hunks in HUNKS.items():
        src = read(path)
        if MARK in src:
            print(f"[apply] skip (already patched): {path}")
            continue
        bak = path + BAK_SUFFIX
        shutil.copy2(path, bak)
        for old, new in hunks:
            assert src.count(old) == 1, f"anchor drift in {path}"
            src = src.replace(old, new, 1)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(src)
            py_compile.compile(path, doraise=True)
        except Exception as e:  # noqa: BLE001
            shutil.copy2(bak, path)
            print(f"[apply] FAILED {path}: {e} — 已从备份还原")
            return 1
        print(f"[apply] OK {path} (backup: {bak})")
    # 清 pyc，防止旧字节码生效
    import subprocess

    for path in HUNKS:
        subprocess.run(
            ["rm", "-rf", f"{path.rsplit('/',1)[0]}/__pycache__"], check=False
        )
    return 0


def revert() -> int:
    rc = 0
    for path in HUNKS:
        bak = path + BAK_SUFFIX
        try:
            shutil.copy2(bak, path)
            py_compile.compile(path, doraise=True)
            print(f"[revert] OK {path}")
        except OSError as e:
            print(f"[revert] no backup / copy fail {path}: {e}")
            rc = 1
    return rc


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true")
    g.add_argument("--self-test", action="store_true")
    g.add_argument("--apply", action="store_true")
    g.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    if args.check:
        for path in HUNKS:
            for line in status(path):
                print(f"{path.rsplit('/',1)[-1]:14s} {line}")
        return 0
    if args.self_test:
        return self_test()
    if args.apply:
        return apply()
    return revert()


if __name__ == "__main__":
    sys.exit(main())
