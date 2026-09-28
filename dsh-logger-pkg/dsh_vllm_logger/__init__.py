"""DSH per-request measured stats plugin.

vLLM v0.27 exposes per-request data (queue/prefill/decode times, token
counts, measured per-output-token time) ONLY to stat loggers — the
Prometheus endpoint and logs carry aggregates only. This plugin hooks the
official ``vllm.stat_logger_plugins`` entry point and appends one JSON line
per finished request to DSH_REQUEST_TRACE_FILE (default
/home/ll/deploy/request-traces.jsonl). The console server tails that file
and shows real per-request measured speeds.

MTP (speculative decode) per-request hit rate
----------------------------------------------
vLLM only exposes spec-decode stats AGGREGATED PER SCHEDULER STEP (across
all requests in the batch): ``SchedulerStats.spec_decoding_stats`` holds
``num_drafts`` / ``num_draft_tokens`` / ``num_accepted_tokens`` for that
step, and ``FinishedRequestStats`` carries no spec fields at all. A true
per-request accept rate therefore does not exist in the vLLM API.

This plugin reconstructs a per-request value by differencing the
engine-level cumulative draft/accept counters over the request's decode
window (``[t_finish - decode_s, t_finish]``), tracked step by step in a
ring buffer of ``(wall_ts, num_drafters, d_cum, a_cum)`` samples:

* if every step in that window had exactly ONE drafting request (and the
  window is fully covered by the ring), the delta belongs entirely to this
  request → the value is EXACT (``mtp_exact: true``).
* otherwise (concurrent drafting requests, or window older than the ring)
  the delta is a mix → the value is an APPROXIMATION
  (``mtp_exact: false``, rendered as "≈").

"""
from __future__ import annotations

import json
import os
import time
from bisect import bisect_left

try:
    from vllm.v1.metrics.loggers import StatLoggerBase

    _AVAILABLE = True
except Exception:  # pragma: no cover - wrong vLLM version
    _AVAILABLE = False
    StatLoggerBase = object  # type: ignore


class DshRequestLogger(StatLoggerBase):  # type: ignore[misc]
    """Writes per-request measured stats as JSONL."""

    MAX_BYTES = 2 * 1024 * 1024  # keep the trace file small
    # Step-level ring buffer: ~30k-60k steps ≈ 10-60 min of decode at
    # typical step rates (10-60 steps/s). Trim in half when over 2*max.
    RING_MAX = 30000

    def __init__(self, vllm_config, engine_index: int = 0):
        self.path = os.environ.get(
            "DSH_REQUEST_TRACE_FILE", "/home/ll/deploy/request-traces.jsonl")
        # [DSH patch] live per-request prefill progress feed (one JSON line per
        # request per prefill chunk). The console tails this file for exact
        # per-request prefill progress/speed (see server.js readLivePrefill).
        self.live_path = os.environ.get(
            "DSH_LIVE_PREFILL_FILE", "/home/ll/deploy/vllm-live-prefill.jsonl")
        # [v3 2026-09-28] 每步每请求输出真值流：rt-patch #11 把官方前端
        # IterationStats.update_from_output 手里的 (rid, 累计gen, arrival,
        # 首token标记) 搭车到 iteration_stats._dsh_reqs，本插件每步转写
        # 到此文件（一行一 rid 一步）。控制台 readLiveStream tail 后
        # 按 rid 滑窗差分 → 并发卡实时 tok/s = 引擎自报真值。
        # port 用于多实例归属（inner 脚本 export DSH_ENGINE_PORT）。
        self.stream_path = os.environ.get(
            "DSH_LIVE_STREAM_FILE", "/home/ll/deploy/vllm-live-stream.jsonl")
        self._port = os.environ.get("DSH_ENGINE_PORT", "") or ""
        self._pid = os.getpid()
        self._trim_at = {}  # path -> next record() count to re-check size
        # Session id: random per plugin init → console detects vLLM restart by
        # a sid change and re-matches REQ rows to engine requests.
        self._sid = os.urandom(4).hex()
        self._model = ""
        try:
            mcfg = getattr(vllm_config, "model", None)
            self._model = str(getattr(mcfg, "name", "") or mcfg or "")
        except Exception:
            self._model = ""
        # Spec-decode attribution state (engine-level, per step)
        self._d_cum = 0  # cumulative drafted tokens since process start
        self._a_cum = 0  # cumulative accepted tokens since process start
        self._ring: list[tuple[float, int, int, int]] = []
        self._num_spec = 0
        try:
            sc = getattr(vllm_config, "speculative_config", None)
            if sc is not None:
                self._num_spec = int(getattr(sc, "num_speculative_tokens", 0) or 0)
        except Exception:
            self._num_spec = 0

    def _write_live_prefill(self, records):
        """Append prefill progress records to the live JSONL file.

        records: list of dicts with the final shape
        {rid, arrival, prompt_total, computed, cached}.
        """
        if not records:
            return
        try:
            if os.path.getsize(self.live_path) > self.MAX_BYTES:
                with open(self.live_path, "r", encoding="utf-8") as f:
                    keep = f.read().splitlines()[-2000:]
                with open(self.live_path, "w", encoding="utf-8") as f:
                    f.write("\n".join(keep) + "\n")
        except Exception:
            pass
        try:
            with open(self.live_path, "a", encoding="utf-8") as f:
                for rec in records:
                    f.write(json.dumps({
                        "t": round(time.time(), 3),
                        "sid": self._sid,
                        "pid": os.getpid(),
                        "model": self._model,
                        "rid": rec["rid"],
                        "arrival": rec.get("arrival", 0.0),
                        "prompt_total": rec.get("prompt_total", 0),
                        "computed": rec.get("computed", 0),
                        "cached": rec.get("cached", 0),
                    }, ensure_ascii=False) + "\n")
        except Exception:
            pass

    def _trim(self, path: str, keep_lines: int) -> None:
        """Ring trim：文件超限则只保留尾部 keep_lines 行（每 200 次写才 stat 一次）。

        高频流文件每次 record() 都写，逐次 stat 会白白多一倍 syscall；
        限频后超限最多拖后 200 个写周期，行宽 ~120B 时误差 <25KB，可忽略。
        """
        n = self._trim_at.get(path, 0)
        if n:
            self._trim_at[path] = n - 1
            return
        self._trim_at[path] = 200
        try:
            if os.path.getsize(path) > self.MAX_BYTES:
                with open(path, "r", encoding="utf-8") as f:
                    keep = f.read().splitlines()[-keep_lines:]
                with open(path, "w", encoding="utf-8") as f:
                    f.write("\n".join(keep) + "\n")
        except Exception:
            pass

    def _write_stream(self, iteration_stats) -> None:
        """[v3] 每步转写每请求输出真值流（rt-patch #11 搭车的 _dsh_reqs）。

        行格式（控制台 readLiveStream 消费）：
          进度行  {"t","sid","pid","port","rid","g","a","pf","n"}
            g=该 rid 累计输出 token（引擎真值） a=进引擎墙钟 epoch
            pf=1 该行所在步是首 token 步（TTFT 标记） n=本步新 token 数（含 MTP）
          完成行  {"t","sid","pid","port","rid","f":1,"g","a"}（finished_requests）
        t 用 iteration_timestamp（与 a 同域、与产生时刻最接近）；缺则 time.time()。
        """
        d = getattr(iteration_stats, "_dsh_reqs", None)
        finished = getattr(iteration_stats, "finished_requests", None) or []
        if not d and not finished:
            return
        ts = getattr(iteration_stats, "iteration_timestamp", None) or time.time()
        ts = round(ts, 3)
        lines = []
        try:
            for rid, ent in d.items():
                lines.append(json.dumps({
                    "t": ts, "sid": self._sid, "pid": self._pid, "port": self._port,
                    "rid": rid, "g": ent[0], "a": round(ent[1], 3),
                    "pf": ent[2], "n": ent[3],
                }, separators=(",", ":"), ensure_ascii=False))
            for r in finished:
                try:
                    lines.append(json.dumps({
                        "t": ts, "sid": self._sid, "pid": self._pid, "port": self._port,
                        "rid": r.request_id, "f": 1,
                        "g": int(getattr(r, "num_generation_tokens", 0) or 0),
                        "a": round(time.time() - (getattr(r, "e2e_latency", 0.0) or 0.0), 3),
                    }, separators=(",", ":"), ensure_ascii=False))
                except Exception:
                    continue
        except Exception:
            return
        if not lines:
            return
        try:
            with open(self.stream_path, "a", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
            # keep_lines 必须使 保留字节 < MAX_BYTES，否则 trim 永远压不回阈值
            # → 每次 stat 超限都全量重写（旧值 40000 行≈5MB>2MB，实测每 4~5s
            # 同步重写 6MB，卡本进程事件循环 → SSE 周期抖动）。12000×~125B
            # ≈1.5MB<2MB，60s+ 历史仍远超控制台 12s 测速窗。
            self._trim(self.stream_path, 12000)
        except Exception:
            pass

    def log_engine_initialized(self):
        pass

    def _spec_window(self, start_ts: float):
        """Engine-level (drafted, accepted, exact) over [start_ts, now].

        Returns (0, 0, None) when there is no usable spec data.
        """
        ring = self._ring
        if not ring or self._num_spec <= 0:
            return 0, 0, None
        lo = bisect_left(ring, (start_ts,))
        if lo >= len(ring):
            return 0, 0, None
        d0, a0 = ring[lo][2], ring[lo][3]
        d1, a1 = ring[-1][2], ring[-1][3]
        drafted = max(0, d1 - d0)
        accepted = max(0, a1 - a0)
        if drafted <= 0:
            return 0, 0, None
        # EXACT only when: the window is fully covered by the ring (its start
        # is not older than the ring's head) AND every step in it had exactly
        # one drafting request (this request).
        exact = start_ts >= ring[0][0]
        if exact:
            for i in range(lo, len(ring)):
                if ring[i][1] != 1:
                    exact = False
                    break
        return drafted, accepted, bool(exact)

    def record(self, scheduler_stats, iteration_stats,
               mm_cache_stats=None, engine_idx: int = 0):
        # ---- step-level spec-decode accounting (before finishing handling,
        # so the current step's drafts are included for requests finishing
        # in this very step) ----
        try:
            spec = (getattr(scheduler_stats, "spec_decoding_stats", None)
                    if scheduler_stats is not None else None)
            num_drafters = int(spec.num_drafts) if spec is not None else 0
            if spec is not None and spec.num_draft_tokens > 0:
                self._d_cum += int(spec.num_draft_tokens)
                self._a_cum += int(spec.num_accepted_tokens)
            self._ring.append((time.time(), num_drafters, self._d_cum, self._a_cum))
            if len(self._ring) > 2 * self.RING_MAX:
                del self._ring[: self.RING_MAX]
        except Exception:
            pass

        # [DSH patch] live per-request prefill progress.
        # Written FIRST so it also fires on output-less steps (pure prefill
        # chunks), where iteration_stats is None but scheduler_stats carries
        # the per-request progress snapshot.
        # Sources:
        #  a) scheduler_stats.prefill_progress — per-step authoritative counters
        #     (real in-flight progress, preemption-aware), written every step.
        #  b) iteration_stats.prefill_progress — per-request prefill COMPLETION
        #     record with the exact cached-token total (PrefillStats), written
        #     when the final prefill chunk emits output.
        # getattr guards against vLLM builds without the patches.
        try:
            out = []
            ss = scheduler_stats if scheduler_stats is not None else None
            if ss is not None:
                rows = getattr(ss, "prefill_progress", None)
                if rows:
                    for rec in rows:
                        out.append({
                            "rid": rec["request_id"],
                            "arrival": rec.get("arrival", 0.0),
                            "prompt_total": rec.get("prompt_total", 0),
                            "computed": rec.get("computed", 0),
                            # 08-25 修复：透传真实缓存命中数（make_stats 每步快照
                            # 已带 _dsh_cached）。此前写死 0 → 预填充进行中
                            # 总需退回全量 prompt（未减命中）、done 把缓存采纳
                            # 计入，进度跑前；完成记录出现后才恢复准确。
                            "cached": rec.get("cached", 0),
                        })
            if iteration_stats is not None:
                pp = getattr(iteration_stats, "prefill_progress", None) or []
                for rec in pp:
                    out.append({
                        "rid": rec["request_id"],
                        "arrival": rec.get("arrival", 0.0),
                        "prompt_total": rec.get("prompt_total", 0),
                        "computed": rec.get("computed", 0),
                        "cached": rec.get("cached", 0),
                    })
            self._write_live_prefill(out)
        except Exception:
            pass

        # [v3] 每步每请求输出真值流（rt-patch #11 搭车数据，官方栈主通道）
        if iteration_stats is not None:
            try:
                self._write_stream(iteration_stats)
            except Exception:
                pass

        if not iteration_stats:
            return
        finished = iteration_stats.finished_requests
        if not finished:
            return
        ts = time.time()
        lines = []
        for r in finished:
            try:
                decode_tps = 0.0
                if r.decode_time and r.decode_time > 0.05:
                    decode_tps = round(r.num_generation_tokens / r.decode_time, 1)
                # Per-request MTP attribution (see module docstring)
                mtp_drafted = 0
                mtp_accepted = 0
                mtp_rate = None
                mtp_exact = None
                if self._num_spec > 0 and r.decode_time and r.decode_time > 0.01:
                    start_ts = ts - r.decode_time
                    mtp_drafted, mtp_accepted, mtp_exact = self._spec_window(start_ts)
                    if mtp_drafted > 0:
                        mtp_rate = round(mtp_accepted / mtp_drafted * 100, 1)
                lines.append(json.dumps({
                    "t": round(time.time(), 3),
                    "pid": os.getpid(),
                    "request_id": r.request_id,
                    "finish_reason": str(getattr(r, "finish_reason", "")),
                    "prompt_tokens": r.num_prompt_tokens,
                    "gen_tokens": r.num_generation_tokens,
                    "cached_tokens": getattr(r, "num_cached_tokens", 0),
                    "queued_s": round(r.queued_time, 3),
                    "prefill_s": round(r.prefill_time, 3),
                    "decode_s": round(r.decode_time, 3),
                    "e2e_s": round(r.e2e_latency, 3),
                    "tpot_s": round(r.mean_time_per_output_token, 5)
                    if r.mean_time_per_output_token else 0.0,
                    "decode_tps": decode_tps,
                    "mtp_drafted": mtp_drafted,
                    "mtp_accepted": mtp_accepted,
                    "mtp_hit_rate": mtp_rate,
                    "mtp_exact": mtp_exact,
                }, ensure_ascii=False))
            except Exception:
                continue
        if not lines:
            return
        try:
            # Cap file size: keep the last half when over the limit
            try:
                if os.path.getsize(self.path) > self.MAX_BYTES:
                    with open(self.path, "r", encoding="utf-8") as f:
                        keep = f.read().splitlines()[-500:]
                    with open(self.path, "w", encoding="utf-8") as f:
                        f.write("\n".join(keep) + "\n")
            except Exception:
                pass
            with open(self.path, "a", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
        except Exception:
            pass
