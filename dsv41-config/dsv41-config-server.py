#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dedicated configuration service for the DeepSeek-V4.1-Flash (CMP 170HX) recipe.

Runs on :8002 and is embedded as an iframe tab in the vLLM admin console (:8889).
It only touches the recipe's .env (whitelisted keys, with timestamped backups) and
exposes read-only runtime status. Applying a config rebuilds the model container
via ./start.sh restart, which takes ~6-9 minutes.

No third-party dependencies: Python standard library only.
"""
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import time
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn

REPO = Path("/home/ll/dsv41-flash-cmp170hx-recipe")
ENV_FILE = REPO / ".env"
LOG_DIR = REPO / "logs"
BACKUP_DIR = LOG_DIR / "env-backups"
PAGE_FILE = Path("/home/ll/dsv41-config.html")
APPLY_LOG = LOG_DIR / "config-apply.log"
LISTEN_PORT = 8002
DEFAULT_CTX = 262144            # serve.sh hardcodes --max-model-len 262144
NATIVE_CTX = 1048576            # model config.json: max_position_embeddings (yarn factor 16)
MAX_BACKUPS = 20
# [default-start-1111] A recoverable snapshot of the whole .env ("default startup
# configuration"). The snapshot is a byte-for-byte copy of .env, so restoring it
# puts every launch parameter (including EXTRA_ARGS and the API key) back exactly
# as it was at save time. The metadata file never stores the API key in clear.
DEFAULT_ENV = LOG_DIR / "default-start.env"
DEFAULT_META = LOG_DIR / "default-start.json"
DEFAULT_BACKUP_DIR = LOG_DIR / "default-backups"
MAX_DEFAULT_BACKUPS = 10
# Quick picks shown as chips on the config page (values must be <= NATIVE_CTX).
CTX_PRESETS = [
    {"label": "128K", "value": 131072},
    {"label": "256K", "value": 262144},
    {"label": "512K", "value": 524288},
    {"label": "1M", "value": 1048576},
]

EDITABLE = {
    "SERVED_MODEL_NAME": {"label": "模型名称", "kind": "str",
                          "tip": "对外 API 显示的模型 ID（/v1/models 与请求里的 model 字段）。只允许字母、数字、点、下划线、连字符。",
                          "default": "dsv41-flash"},
    "MAX_SEQS": {"label": "并发数", "kind": "int", "min": 1, "max": 32, "default": 8,
                 "tip": "--max-num-seqs：服务端同时处理的最大请求数，超出的排队。调大吞吐更高，但 KV 缓存挤占更明显。"},
    "MAX_MODEL_LEN": {"label": "上下文大小", "kind": "int", "min": 8192, "max": NATIVE_CTX,
                      "default": DEFAULT_CTX,
                      "tip": "--max-model-len：单请求最大 token 数（prompt + 输出）。模型原生上限 1048576（1M，YaRN 外推）；256K 为服务默认值。调大后 KV 缓存按比例变少、可并发路数下降；调小则相反。"},
    "MAX_BATCHED": {"label": "批量 Token 上限", "kind": "int", "min": 256, "max": 8192,
                    "default": 2048,
                    "tip": "--max-num-batched-tokens：调度器每步处理的最大 token 总量。改大会提升 prefill 吞吐，但显存峰值更高。"},
    "PORT": {"label": "服务端口", "kind": "int", "min": 1024, "max": 65535,
             "default": 8000, "reserved": [8001, 8002, 8889, 5173],
             "tip": "对外 API 端口（start.sh 的 PORT，映射到容器内 8000）。改完后 CORS 网关(8001)与浏览器跨域重定向会自动跟随，但客户端 Base URL 要同步改成新端口。"},
    "P2P": {"label": "P2P 模式", "kind": "enum", "options": ["auto", "off", "force"],
            "default": "auto",
            "tip": "auto = 内容校验通过后启用跨卡直连（当前推荐，已配合 ACS 修复）；off = 关闭全部跨卡传输；force = 跳过校验强制开启，可能导致 GPU 掉总线。"},
    "API_KEY": {"label": "API Key", "kind": "str",
                "tip": "调用 /v1 接口时 Bearer 后面带的密钥。修改后需重启容器才生效；本管理页的写操作也用它鉴权。"},
}
READONLY_KEYS = ["HOST", "IMAGE", "MODELS_DIR", "HF_ENDPOINT", "EXTRA_ARGS"]
PORT_SYNC = Path("/home/ll/dsv41-port-sync.sh")

KEY_RE = re.compile(r"^([A-Z_][A-Z0-9_]*)=(.*)$")
COMMENT_KEY_RE = re.compile(r"^\s*#\s*([A-Z_][A-Z0-9_]*)=(.*)$")

_state_lock = threading.Lock()
_apply_lock = threading.Lock()
_defaults_lock = threading.Lock()
_apply_state = {"phase": "idle", "action": None, "started_at": None, "finished_at": None,
                "rc": None, "message": "", "log": ""}
_runtime_cache = {"at": 0.0, "data": {}}


# ---------------------------------------------------------------- env helpers
def _unquote(value):
    """Parse a shell-quoted scalar from .env (single / double quotes, no expansion)."""
    v = value.strip()
    if not v:
        return ""
    # Values with spaces are stored as '...' (e.g. EXTRA_ARGS); strip the outer
    # quotes as `source .env` would, without splitting it into words.
    if len(v) >= 2 and v[0] == v[-1] == "'":
        return v[1:-1].replace("'\\''", "'")
    if len(v) >= 2 and v[0] == v[-1] == '"':
        return v[1:-1]
    try:
        parts = shlex.split(v, posix=True)
        return parts[0] if len(parts) == 1 else v
    except ValueError:
        return v


def _quote(value):
    """Quote a scalar so `source .env` reproduces it byte-for-byte."""
    v = str(value)
    if v and re.fullmatch(r"[A-Za-z0-9._:/@=+-]+", v):
        return v
    return "'" + v.replace("'", "'\\''") + "'"


def parse_env(text=None):
    if text is None:
        text = ENV_FILE.read_text(encoding="utf-8")
    out = {}
    for line in text.splitlines():
        m = KEY_RE.match(line.strip())
        if m:
            out[m.group(1)] = _unquote(m.group(2))
    return out


def extra_args_with_ctx(extra, ctx):
    """Rebuild EXTRA_ARGS: keep everything (notably --allowed-origins), replace ctx."""
    s = re.sub(r"\s*--max-model-len(?:\s+|=)\d+", "", str(extra or "")).strip()
    if ctx != DEFAULT_CTX:
        s = (s + " --max-model-len " + str(ctx)).strip()
    return s


def current_values():
    """Effective config as it would be applied on the next restart."""
    e = parse_env()
    extra = e.get("EXTRA_ARGS", "")
    m = re.search(r"--max-model-len(?:\s+|=)(\d+)", extra)
    return {
        "SERVED_MODEL_NAME": e.get("SERVED_MODEL_NAME", "dsv41-flash"),
        "MAX_SEQS": e.get("MAX_SEQS", "8"),
        "MAX_BATCHED": e.get("MAX_BATCHED", "2048"),
        "MAX_MODEL_LEN": m.group(1) if m else str(DEFAULT_CTX),
        "PORT": e.get("PORT", "8000"),
        "P2P": e.get("P2P", "auto"),
        "API_KEY": e.get("API_KEY", ""),
    }


def validate(payload):
    """Return (clean, errors). Strict whitelist: nothing reaches .env unverified."""
    errors, clean = [], {}
    if not isinstance(payload, dict):
        return {}, ["请求体必须是 JSON 对象"]
    for key, meta in EDITABLE.items():
        if key not in payload:
            continue
        raw = payload[key]
        if isinstance(raw, bool):
            errors.append("%s: 类型不合法" % meta["label"])
            continue
        val = str(raw).strip()
        kind = meta["kind"]
        if kind == "int":
            if not re.fullmatch(r"\d+", val):
                errors.append("%s: 必须是整数" % meta["label"])
                continue
            n = int(val)
            if n < meta["min"] or n > meta["max"]:
                errors.append("%s: 必须在 %d ~ %d 之间" % (meta["label"], meta["min"], meta["max"]))
                continue
            if n in meta.get("reserved", []):
                errors.append("%s: %d 已被管理控制台 / 网关占用，请换一个（如 8010）"
                              % (meta["label"], n))
                continue
            clean[key] = str(n)
        elif kind == "enum":
            if val not in meta["options"]:
                errors.append("%s: 只能是 %s" % (meta["label"], " / ".join(meta["options"])))
                continue
            clean[key] = val
        else:
            if key == "SERVED_MODEL_NAME":
                if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", val):
                    errors.append("模型名称: 只允许 1-64 位字母、数字、点、下划线、连字符")
                    continue
            else:  # API_KEY
                if not val or len(val) > 128 or re.search(r"[\s'\"\\$`;&|]", val):
                    errors.append("API Key: 不能为空，不能含空格、引号或 shell 特殊字符（最长 128 位）")
                    continue
            clean[key] = val
    return clean, errors


def build_env_text(clean, base_text=None):
    """Patch the whitelisted keys in place, keeping every other line untouched.

    base_text lets the caller build a snapshot from something other than the
    live .env (the running container's effective values, for example).
    """
    old_text = base_text if base_text is not None else ENV_FILE.read_text(encoding="utf-8")
    old = parse_env(old_text)
    lines = old_text.splitlines()

    wanted = dict(clean)
    if "MAX_MODEL_LEN" in wanted:
        wanted["EXTRA_ARGS"] = extra_args_with_ctx(old.get("EXTRA_ARGS", ""), int(wanted.pop("MAX_MODEL_LEN")))
    targets = set(wanted)
    seen = set()
    for i, line in enumerate(lines):
        ma = KEY_RE.match(line.strip())
        mc = COMMENT_KEY_RE.match(line) if not ma else None
        key = ma.group(1) if ma else (mc.group(1) if mc else None)
        if key not in targets:
            continue
        if key in seen:
            # A later active duplicate would silently override us -> comment it out.
            if ma:
                lines[i] = "# [dsv41-config] duplicate disabled: " + line
            continue
        seen.add(key)
        lines[i] = "%s=%s" % (key, _quote(wanted[key]))

    missing = [k for k in wanted if k not in seen]
    if missing:
        lines.append("")
        lines.append("# --- dsv41-config managed settings ---")
        for k in missing:
            lines.append("%s=%s" % (k, _quote(wanted[k])))
    return "\n".join(lines) + "\n"


def make_backup(reason="manual"):
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    name = "env-%s-%s.env" % (stamp, re.sub(r"[^a-z0-9-]", "", reason.lower()) or "manual")
    dest = BACKUP_DIR / name
    n = 1
    while dest.exists():
        dest = BACKUP_DIR / ("env-%s-%s-%d.env" % (stamp, reason, n))
        n += 1
    shutil.copy2(ENV_FILE, dest)
    files = sorted(BACKUP_DIR.glob("env-*.env"), reverse=True)
    for f in files[MAX_BACKUPS:]:
        try:
            f.unlink()
        except OSError:
            pass
    return dest.name


# ---------------------------------------------------------------- runtime info
def run(cmd, timeout=10):
    try:
        p = subprocess.run(cmd, shell=False, cwd=str(REPO), capture_output=True,
                           text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "timeout"
    except Exception as exc:
        return 1, str(exc)


def http_json(url, key="", timeout=4):
    try:
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key} if key else {})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                data = json.loads(raw) if raw.strip() else {}
            except ValueError:
                data = {}
            return r.status, data
    except Exception as exc:
        code = getattr(exc, "code", 0)
        return code or 0, {}


def container_cmdline():
    rc, out = run(["docker", "exec", "dsv41-flash", "sh", "-c",
                   "ps -eo args | grep 'vllm serve' | grep -v grep"], 8)
    text = out.splitlines()[0] if out.strip() else ""
    d = {}
    for flag in ("--max-model-len", "--max-num-seqs", "--max-num-batched-tokens",
                 "--served-model-name", "--max-num-seqs", "--port"):
        m = re.search(re.escape(flag) + r"(?:\s+|=)([^\s]+)", text)
        if m:
            d[flag.lstrip("-")] = m.group(1)
    return d, text


def published_port():
    """Host port the running container is actually published on (docker port)."""
    rc, out = run(["docker", "port", "dsv41-flash", "8000/tcp"], 6)
    if rc != 0:
        return ""
    m = re.search(r":(\d+)\s*$", out.strip(), re.M)
    return m.group(1) if m else ""


def gateway_port():
    """Backend port the CORS gateway is currently forwarding to."""
    try:
        data = json.loads(Path("/home/ll/dsv41-gateway.conf").read_text(encoding="utf-8"))
        return str(int(data.get("backend_port") or 8000))
    except Exception:
        return ""


def kv_cache_tokens():
    """Total KV cache capacity (tokens) reported by the last engine boot.

    serve.log is append-only across boots, so the last match is the live value.
    Used only to show "how many requests fit at this context length".
    """
    try:
        text = (LOG_DIR / "serve.log").read_text(encoding="utf-8", errors="replace")
    except Exception:
        return 0
    found = re.findall(r"GPU KV cache size:\s*([\d,]+)\s*tokens", text)
    if not found:
        return 0
    try:
        return int(found[-1].replace(",", ""))
    except ValueError:
        return 0


def runtime_status(force=False):
    now = time.time()
    with _state_lock:
        if not force and now - _runtime_cache["at"] < 4:
            return dict(_runtime_cache["data"])

    e = parse_env()
    key = e.get("API_KEY", "")
    cfg_port = e.get("PORT", "8000")
    pub_port = published_port()
    # Prefer the port the container is really published on: after saving a new
    # PORT but before applying, .env no longer describes the live service.
    probe = pub_port or cfg_port
    hcode, _ = http_json("http://127.0.0.1:%s/health" % probe, timeout=3)
    if hcode != 200 and probe != cfg_port:
        alt, _ = http_json("http://127.0.0.1:%s/health" % cfg_port, timeout=2)
        if alt == 200:
            probe, hcode = cfg_port, alt
    mcode, models = http_json("http://127.0.0.1:%s/v1/models" % probe, key, 4)
    live_len = ""
    live_model = ""
    if models.get("data"):
        item = models["data"][0]
        live_model = item.get("id", "")
        live_len = str(item.get("max_model_len", ""))
    cmd, cmdline = container_cmdline()
    rc, cstate = run(["docker", "inspect", "dsv41-flash", "--format",
                      "{{.State.Status}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.StartedAt}}"], 6)
    status, policy, started = (cstate.strip().split("|") + ["", "", ""])[:3] if rc == 0 else ("absent", "", "")
    rc2, gpu = run(["nvidia-smi", "--query-gpu=index,memory.used", "--format=csv,noheader"], 8)
    gpus = [x.strip() for x in gpu.strip().splitlines() if "MiB" in x][:8] if rc2 == 0 else []
    # The [p2p] decision is logged during boot, far outside `docker logs --tail`.
    # serve.log is append-only across boots, so the last match is the live one.
    p2p, ring = "unknown", ""
    try:
        slog = (LOG_DIR / "serve.log").read_text(encoding="utf-8", errors="replace")
        pm = re.findall(r"\[p2p\] enabled=(\d)", slog)
        if pm:
            p2p = "enabled=" + pm[-1]
        if "prefill-sized TP all-reduces run on the copy-engine ring" in slog:
            ring = "copy-engine ring"
    except Exception:
        pass
    stability = ""
    try:
        stability = (LOG_DIR / "p2p-stability.log").read_text(encoding="utf-8").strip().splitlines()[-1]
    except Exception:
        pass
    data = {
        "health": hcode, "models_http": mcode, "live_model": live_model,
        "live_max_model_len": live_len, "cmdline": cmd, "cmdline_full": cmdline[:1200],
        "container": status, "restart_policy": policy, "started_at": started[:19],
        "serving_port": probe, "published_port": pub_port, "configured_port": cfg_port,
        "gateway_port": gateway_port(),
        "gpus": gpus, "gpu_count": len(gpus), "p2p": p2p, "ring": ring,
        "stability": stability, "checked_at": datetime.now().strftime("%H:%M:%S"),
    }
    with _state_lock:
        _runtime_cache["at"] = now
        _runtime_cache["data"] = data
    return dict(data)


def diff_config():
    """Compare .env (next restart) with the running container's command line."""
    vals = current_values()
    rt = runtime_status()
    live = rt["cmdline"]
    diffs = []
    pairs = [
        ("模型名称", vals["SERVED_MODEL_NAME"], live.get("served-model-name", "")),
        ("并发数", vals["MAX_SEQS"], live.get("max-num-seqs", "")),
        ("上下文大小", vals["MAX_MODEL_LEN"], live.get("max-model-len", "")),
        ("批量 Token 上限", vals["MAX_BATCHED"], live.get("max-num-batched-tokens", "")),
        ("服务端口", vals["PORT"], rt.get("published_port", "")),
    ]
    for label, want, got in pairs:
        if got and str(want) != str(got):
            diffs.append({"field": label, "saved": want, "running": got})
    return diffs


# --------------------------------------------------- default startup config
# [default-start-1111] A saved snapshot of the whole .env that can be restored
# later. This is deliberately separate from the normal .env backups: it is the
# "known good" launch configuration the operator chose to keep as the default.
DEFAULT_FIELD_LABELS = {
    "SERVED_MODEL_NAME": "模型名称",
    "MAX_SEQS": "并发数",
    "MAX_MODEL_LEN": "上下文大小",
    "MAX_BATCHED": "批量 Token 上限",
    "PORT": "服务端口",
    "P2P": "P2P 模式",
    "API_KEY": "API Key",
}


def mask_secret(key):
    if not key:
        return "(未设置)"
    if len(key) <= 4:
        return key[0] + "•••"
    return key[:2] + "•" * min(6, len(key) - 4) + key[-2:]


def masked_values():
    vals = current_values()
    out = {k: v for k, v in vals.items() if k != "API_KEY"}
    out["API_KEY"] = mask_secret(vals.get("API_KEY", ""))
    return out


def _iso_now():
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z")


def _write_atomic(path, text, mode=0o600):
    """Write a config file atomically, with tight permissions from the start."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp-%d-%d" % (os.getpid(), threading.get_ident()))
    tmp.write_text(text, encoding="utf-8")
    os.chmod(str(tmp), mode)
    os.replace(str(tmp), str(path))


def default_env_text():
    try:
        return DEFAULT_ENV.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def default_meta():
    try:
        data = json.loads(DEFAULT_META.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _default_diff(default_text, current_text):
    """Compare the saved default's effective values with the current .env."""
    dv = current_values_from_text(default_text)
    cv = current_values_from_text(current_text)
    diffs = []
    for key, label in DEFAULT_FIELD_LABELS.items():
        a, b = dv.get(key, ""), cv.get(key, "")
        if str(a) != str(b):
            if key == "API_KEY":
                a, b = mask_secret(a), mask_secret(b)
            diffs.append({"key": key, "field": label, "default": a, "current": b})
    de = parse_env(default_text).get("EXTRA_ARGS", "")
    ce = parse_env(current_text).get("EXTRA_ARGS", "")
    if de != ce and not any(d["key"] == "MAX_MODEL_LEN" for d in diffs):
        diffs.append({"key": "EXTRA_ARGS", "field": "附加启动参数",
                      "default": de, "current": ce})
    return diffs


def default_summary():
    """JSON-safe summary for the config page (API key is always masked)."""
    text = default_env_text()
    meta = default_meta()
    source = meta.get("source", "env")
    out = {
        "exists": text is not None,
        "auto_start": bool(meta.get("auto_start")),
        "saved_at": meta.get("saved_at", ""),
        "saved_by": meta.get("saved_by", ""),
        "last_loaded_at": meta.get("last_loaded_at", ""),
        "env_path": str(DEFAULT_ENV),
        "source": source,
        "source_label": {"running": "运行中配置", "manual": "页面编辑"}.get(source, ".env"),
        "source_detail": meta.get("source_detail", ""),
        "backups": [],
    }
    try:
        out["backups"] = sorted(
            [f.name for f in DEFAULT_BACKUP_DIR.glob("default-*.env")], reverse=True
        )[:MAX_DEFAULT_BACKUPS]
    except OSError:
        pass
    if text is None:
        out.update({"values": {}, "extra_args": "", "matches_env": False,
                    "diff": [], "diff_count": 0})
        return out
    dv = current_values_from_text(text)
    masked = {k: (mask_secret(v) if k == "API_KEY" else v) for k, v in dv.items()}
    diff = []
    try:
        current_text = ENV_FILE.read_text(encoding="utf-8")
        diff = _default_diff(text, current_text)
    except (OSError, UnicodeDecodeError):
        current_text = ""
    out.update({
        "values": masked,
        "extra_args": parse_env(text).get("EXTRA_ARGS", ""),
        "matches_env": bool(current_text) and not diff,
        "diff": diff,
        "diff_count": len(diff),
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    })
    return out


def running_env_text():
    """Build the .env text that matches what the container is running now.

    The saved .env may contain edits that were never applied ("pending" in the
    page).  Saving the running values as the default is therefore the safer
    known-good snapshot; keys not visible on the command line (P2P, API_KEY)
    are taken from the current .env.
    """
    base = ENV_FILE.read_text(encoding="utf-8")
    cur = current_values_from_text(base)
    try:
        rt = runtime_status()
    except Exception:
        rt = {}
    cmd = rt.get("cmdline") or {}
    if not (cmd.get("max-model-len") and cmd.get("max-num-seqs")):
        raise ValueError("读取不到容器当前生效的启动参数；请稍后重试，或改用「保存 .env 为默认」")

    def pick(cmd_key, cur_key):
        value = str(cmd.get(cmd_key) or "").strip()
        return value or str(cur.get(cur_key) or "").strip()

    clean = {
        "SERVED_MODEL_NAME": pick("served-model-name", "SERVED_MODEL_NAME"),
        "MAX_SEQS": pick("max-num-seqs", "MAX_SEQS"),
        "MAX_MODEL_LEN": pick("max-model-len", "MAX_MODEL_LEN"),
        "MAX_BATCHED": pick("max-num-batched-tokens", "MAX_BATCHED"),
        "PORT": str(rt.get("published_port") or cur.get("PORT") or "").strip(),
        "P2P": cur.get("P2P", "auto"),
        "API_KEY": cur.get("API_KEY", ""),
    }
    # Refuse to write a nonsense value if the live command line is unreadable.
    if not clean["MAX_MODEL_LEN"].isdigit() or not clean["MAX_SEQS"].isdigit():
        raise ValueError("读取不到容器当前生效的启动参数")
    text = build_env_text(clean, base_text=base)
    detail = "容器运行中 · 端口 %s · 采样 %s" % (
        rt.get("published_port") or "—", rt.get("checked_at") or "—")
    return text, detail


def save_default(saved_by="", text=None, source="env", source_detail=""):
    """Snapshot .env (or the running config) as the default startup config."""
    with _defaults_lock:
        if text is None:
            text = ENV_FILE.read_text(encoding="utf-8")
        old_meta = default_meta()
        if DEFAULT_ENV.exists():
            DEFAULT_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            dest = DEFAULT_BACKUP_DIR / ("default-%s.env" % stamp)
            n = 1
            while dest.exists():
                dest = DEFAULT_BACKUP_DIR / ("default-%s-%d.env" % (stamp, n))
                n += 1
            shutil.copy2(DEFAULT_ENV, dest)
            files = sorted(DEFAULT_BACKUP_DIR.glob("default-*.env"), reverse=True)
            for f in files[MAX_DEFAULT_BACKUPS:]:
                try:
                    f.unlink()
                except OSError:
                    pass
        _write_atomic(DEFAULT_ENV, text, 0o600)
        dv = current_values_from_text(text)
        masked = {k: (mask_secret(v) if k == "API_KEY" else v) for k, v in dv.items()}
        meta = {
            "saved_at": _iso_now(), "saved_by": saved_by,
            "auto_start": bool(old_meta.get("auto_start")),
            "source": source, "source_detail": source_detail,
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "values": masked,
            "extra_args": parse_env(text).get("EXTRA_ARGS", ""),
        }
        _write_atomic(DEFAULT_META, json.dumps(meta, ensure_ascii=False, indent=2), 0o600)
    return default_summary()


def load_default(saved_by=""):
    """Restore the saved default into .env (does not restart the container)."""
    with _defaults_lock:
        text = DEFAULT_ENV.read_text(encoding="utf-8")
        if not parse_env(text):
            raise ValueError("默认启动配置文件为空或格式不合法")
        backup = make_backup("before-default-load")
        mode = (ENV_FILE.stat().st_mode & 0o777) if ENV_FILE.exists() else 0o600
        _write_atomic(ENV_FILE, text, mode)
        meta = default_meta()
        meta["last_loaded_at"] = _iso_now()
        meta["last_loaded_by"] = saved_by
        _write_atomic(DEFAULT_META, json.dumps(meta, ensure_ascii=False, indent=2), 0o600)
    return {"backup": backup}


def clear_default():
    with _defaults_lock:
        removed = []
        for path in (DEFAULT_ENV, DEFAULT_META):
            try:
                if path.exists():
                    path.unlink()
                    removed.append(path.name)
            except OSError:
                pass
    return removed


def set_auto_start(enabled):
    with _defaults_lock:
        if not DEFAULT_ENV.exists():
            raise FileNotFoundError("尚未保存默认启动配置")
        meta = default_meta()
        meta["auto_start"] = bool(enabled)
        meta["auto_start_updated_at"] = _iso_now()
        _write_atomic(DEFAULT_META, json.dumps(meta, ensure_ascii=False, indent=2), 0o600)
    return default_summary()


def apply_default_before_start():
    """If enabled, restore the saved default into .env before `start.sh start`.

    This only runs for the "启动模型" action, never for "保存并应用" (rebuild):
    the rebuild must use the parameters the operator just saved in the form.
    """
    meta = default_meta()
    if not meta.get("auto_start"):
        return {"applied": False, "reason": "auto_start_off"}
    if not DEFAULT_ENV.exists():
        return {"applied": False, "reason": "missing_default"}
    text = DEFAULT_ENV.read_text(encoding="utf-8")
    if not parse_env(text):
        raise ValueError("默认启动配置文件为空或格式不合法")
    try:
        current = ENV_FILE.read_text(encoding="utf-8")
    except OSError:
        current = ""
    if text == current:
        return {"applied": False, "reason": "already_same"}
    with _defaults_lock:
        backup = make_backup("before-default-start")
        mode = (ENV_FILE.stat().st_mode & 0o777) if ENV_FILE.exists() else 0o600
        _write_atomic(ENV_FILE, text, mode)
    return {"applied": True, "backup": backup}


# ---------------------------------------------------------------- apply job
def sync_gateway():
    """Push the (possibly new) PORT to the CORS gateway + LAN redirect rule."""
    try:
        p = subprocess.run(["sudo", "-n", str(PORT_SYNC), "reload"],
                           capture_output=True, text=True, timeout=90)
        return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()
    except Exception as exc:
        return 1, str(exc)


def _apply_worker():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(APPLY_LOG, "w", encoding="utf-8") as lf:
        lf.write("[%s] applying .env via ./start.sh restart\n" % datetime.now().strftime("%F %T"))
        lf.flush()
        with _state_lock:
            _apply_state.update(phase="running", action="apply", started_at=time.time(), rc=None,
                                message="正在重建容器（约 6–9 分钟），期间 API 不可用")
        try:
            p = subprocess.Popen(["./start.sh", "restart"], cwd=str(REPO),
                                 stdout=lf, stderr=subprocess.STDOUT, text=True)
            rc = p.wait()
            # start.sh removes the container on stop; the fresh one must keep the
            # host-reboot autostart policy (same as every manual rebuild before).
            run(["docker", "update", "--restart", "unless-stopped", "dsv41-flash"], 10)
            lf.write("[%s] restart rc=%s\n" % (datetime.now().strftime("%F %T"), rc))
            # A changed PORT must also move the gateway backend and the LAN
            # redirect; without this the console would proxy to a dead port.
            src, sout = sync_gateway()
            lf.write("[%s] port sync rc=%s\n%s\n" % (datetime.now().strftime("%F %T"), src, sout))
            lf.flush()
            with _state_lock:
                _apply_state.update(phase="done" if rc == 0 else "failed", rc=rc,
                                    finished_at=time.time(),
                                    message="完成：服务已就绪" if rc == 0 else "启动脚本返回非零，请查看日志")
        except Exception as exc:
            with _state_lock:
                _apply_state.update(phase="failed", rc=1, finished_at=time.time(),
                                    message="异常：%s" % exc)
        finally:
            _apply_lock.release()


def apply_status():
    with _state_lock:
        st = dict(_apply_state)
    try:
        st["log"] = "\n".join(APPLY_LOG.read_text(encoding="utf-8").splitlines()[-35:])
    except Exception:
        st["log"] = ""
    # Reconcile with reality: a healthy service means the job is effectively over.
    st["health"] = runtime_status()["health"]
    return st


# ------------------------------------------------------- start / stop model
def container_status():
    """Docker state of the model container: running / exited / created / absent."""
    rc, out = run(["docker", "inspect", "dsv41-flash", "--format", "{{.State.Status}}"], 6)
    return out.strip() if rc == 0 and out.strip() else "absent"


def _service_worker(action):
    """Start or stop the model container through the recipe's own start.sh.

    Shares _apply_lock with the apply job, so a rebuild and a start/stop can
    never overlap (start.sh has its own lifecycle lock on top of this).
    """
    start = action == "start"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(APPLY_LOG, "w", encoding="utf-8") as lf:
        lf.write("[%s] %s via ./start.sh %s\n"
                 % (datetime.now().strftime("%F %T"), "starting" if start else "stopping", action))
        lf.flush()
        with _state_lock:
            _apply_state.update(
                phase="running", action=action, started_at=time.time(), rc=None,
                message=("正在启动模型：加载权重约 6–9 分钟，期间 API 不可用" if start
                         else "正在停止模型：等待在途请求结束（最长 120 秒）"))
        default_note = ""
        try:
            if start:
                # [default-start-1111] Optional parameter: before starting, put the
                # saved default startup config back into .env. Fail closed: if the
                # restore errors, the start is aborted rather than silently using
                # a half-edited .env.
                res = apply_default_before_start()
                if res.get("applied"):
                    default_note = "（已套用默认启动配置，备份 %s）" % res.get("backup", "—")
                    lf.write("[%s] default-start applied, .env backup=%s\n"
                             % (datetime.now().strftime("%F %T"), res.get("backup", "—")))
                elif res.get("reason") == "missing_default":
                    default_note = "（已启用自动套用，但未找到默认配置，按当前 .env 启动）"
                    lf.write("[%s] default-start enabled but missing, using current .env\n"
                             % datetime.now().strftime("%F %T"))
                lf.flush()
            p = subprocess.Popen(["./start.sh", action], cwd=str(REPO),
                                 stdout=lf, stderr=subprocess.STDOUT, text=True)
            rc = p.wait()
            lf.write("[%s] %s rc=%s\n" % (datetime.now().strftime("%F %T"), action, rc))
            if start and rc == 0:
                # A fresh container loses nothing, but the host-reboot policy and
                # the gateway backend (PORT may have changed while stopped) must
                # be re-applied, exactly like after an apply-job rebuild.
                run(["docker", "update", "--restart", "unless-stopped", "dsv41-flash"], 10)
                src, sout = sync_gateway()
                lf.write("[%s] port sync rc=%s\n%s\n" % (datetime.now().strftime("%F %T"), src, sout))
            lf.flush()
            with _state_lock:
                _apply_state.update(
                    phase="done" if rc == 0 else "failed", rc=rc, finished_at=time.time(),
                    message=("完成：模型已就绪" + default_note if rc == 0 else
                             ("启动脚本返回非零，请查看日志" if start
                              else "停止脚本返回非零，请查看日志")))
        except Exception as exc:
            with _state_lock:
                _apply_state.update(phase="failed", rc=1, finished_at=time.time(),
                                    message="异常：%s" % exc)
        finally:
            _apply_lock.release()


# ---------------------------------------------------------------- HTTP layer
class Handler(BaseHTTPRequestHandler):
    server_version = "dsv41-config/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self._access("OPTIONS", self.path.split("?")[0])
        self._send(200, b"", "text/plain")

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:
            return None

    def _authorized(self):
        want = parse_env().get("API_KEY", "")
        if not want:
            return True
        got = self.headers.get("X-Admin-Key", "")
        # constant-time-ish compare to avoid trivial timing leaks
        return hashlib.sha256(got.encode()).digest() == hashlib.sha256(want.encode()).digest()

    def _mask(self, key):
        return mask_secret(key)

    def _access(self, method, path):
        """One line per /api/* call in journald: enough to see who called what."""
        if not path.startswith("/api/"):
            return
        try:
            print("[req] %s %s from %s origin=%r referer=%r ua=%r" % (
                method, path, self.client_address[0],
                self.headers.get("Origin", ""), self.headers.get("Referer", ""),
                (self.headers.get("User-Agent", "") or "")[:70]), flush=True)
        except Exception:
            pass

    def do_GET(self):
        path = self.path.split("?")[0]
        self._access("GET", path)
        if path in ("/", "/index.html"):
            try:
                return self._send(200, PAGE_FILE.read_bytes(), "text/html; charset=utf-8")
            except Exception as exc:
                return self._send(500, {"ok": False, "error": str(exc)})
        if path == "/api/config":
            vals = current_values()
            masked = masked_values()
            return self._send(200, {
                "ok": True, "values": masked, "has_api_key": bool(vals["API_KEY"]),
                "readonly": {k: parse_env().get(k, "") for k in READONLY_KEYS},
                "meta": EDITABLE, "default_ctx": DEFAULT_CTX, "native_ctx": NATIVE_CTX,
                "ctx_presets": CTX_PRESETS, "kv_cache_tokens": kv_cache_tokens(),
                "runtime": runtime_status(), "pending": diff_config(),
                "backups": sorted([f.name for f in BACKUP_DIR.glob("env-*.env")], reverse=True)[:20]
                if BACKUP_DIR.exists() else [],
                "defaults": default_summary(),
                "apply": apply_status(),
            })
        if path == "/api/status":
            return self._send(200, {"ok": True, "runtime": runtime_status(force=True),
                                   "pending": diff_config(), "apply": apply_status(),
                                   "defaults": default_summary()})
        if path == "/api/defaults":
            return self._send(200, {"ok": True, "defaults": default_summary()})
        if path == "/api/apply":
            return self._send(200, {"ok": True, "apply": apply_status()})
        if path == "/api/dry":
            rc, out = run(["bash", "-c", "DRY=1 ./start.sh"], 90)
            flags = {}
            for flag in ("--max-model-len", "--max-num-seqs", "--max-num-batched-tokens",
                         "--served-model-name", "--allowed-origins"):
                found = re.findall(re.escape(flag) + r"\s+('[^']*'|\"[^\"]*\"|\S+)", out)
                if found:
                    # EXTRA_ARGS is appended last; argparse keeps the final value.
                    flags[flag.lstrip("-")] = found[-1].replace("\\", "")
            # The docker run line sits at the top; the tail only has the env dump.
            pub = re.search(r"-p\s+([0-9.]+):(\d+):8000", out)
            publish_port = pub.group(2) if pub else ""
            head = "\n".join(out.splitlines()[:22])
            tail = "\n".join(out.splitlines()[-30:])
            return self._send(200, {"ok": rc == 0, "rc": rc, "flags": flags,
                                   "publish_port": publish_port,
                                   "excerpt": head + "\n   …\n" + tail})
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        self._access("POST", path)
        if path not in ("/api/config", "/api/defaults", "/api/apply",
                        "/api/service", "/api/rollback"):
            return self._send(404, {"ok": False, "error": "not found"})
        body = self._body()
        if body is None:
            return self._send(400, {"ok": False, "error": "JSON 解析失败"})
        # Preview is read-only (it never touches .env), so it needs no admin key.
        preview_only = path == "/api/config" and bool(body.get("preview"))
        if not preview_only and not self._authorized():
            return self._send(401, {"ok": False, "error": "管理密钥不正确（与当前 API Key 相同）"})

        if path == "/api/config":
            clean, errors = validate(body.get("values", body))
            if errors:
                return self._send(400, {"ok": False, "errors": errors})
            if not clean:
                # No form change but the operator asked to keep the current .env
                # as the default startup config: that is a valid, useful no-op
                # for .env itself, so snapshot it instead of rejecting.
                if body.get("saveAsDefault"):
                    try:
                        saved = save_default(self.client_address[0])
                    except Exception as exc:
                        return self._send(500, {"ok": False, "error": "保存默认配置失败：%s" % exc})
                    return self._send(200, {
                        "ok": True, "changed": [], "default_saved": saved,
                        "defaults": default_summary(),
                        "message": "未修改 .env；已将当前 .env 保存为默认启动配置"})
                return self._send(400, {"ok": False, "error": "没有可保存的字段"})
            old = current_values()
            new_text = build_env_text(clean)
            changed = []
            new_vals = current_values_from_text(new_text)
            for k in clean:
                if k == "MAX_MODEL_LEN":
                    a, b = old.get(k), new_vals.get(k)
                else:
                    a, b = old.get(k), new_vals.get(k)
                if a != b:
                    changed.append({"field": EDITABLE[k]["label"], "key": k,
                                    "from": self._mask(a) if k == "API_KEY" else a,
                                    "to": self._mask(b) if k == "API_KEY" else b})
            if preview_only:
                return self._send(200, {"ok": True, "preview": True, "changed": changed,
                                       "extra_args": parse_env(new_text).get("EXTRA_ARGS", "")})
            backup = make_backup("before-save")
            tmp = ENV_FILE.with_suffix(".env.tmp-dsv41cfg")
            tmp.write_text(new_text, encoding="utf-8")
            os.replace(tmp, ENV_FILE)
            # [default-start-1111] Optional checkbox in the save row: keep the
            # just-saved values as the recoverable default startup config too.
            saved_default = None
            default_error = ""
            if body.get("saveAsDefault"):
                try:
                    saved_default = save_default(self.client_address[0])
                except Exception as exc:
                    default_error = str(exc)
            resp = {"ok": True, "changed": changed, "backup": backup,
                    "values": masked_values(), "pending": diff_config(),
                    "defaults": default_summary()}
            if saved_default is not None:
                resp["default_saved"] = saved_default
                resp["message"] = "当前配置已同时保存为默认启动配置"
            if default_error:
                resp["default_error"] = default_error
            return self._send(200, resp)

        if path == "/api/defaults":
            # [default-start-1111] save / load / clear the default snapshot and
            # toggle the "apply it automatically when starting the model" parameter.
            if _apply_lock.locked():
                return self._send(409, {"ok": False,
                    "error": "已有一次重建 / 启停任务正在进行，请等它结束后再操作默认配置"})
            action = str(body.get("action", "")).strip()
            by = self.client_address[0]
            if action == "save":
                source = str(body.get("source", "env")).strip()
                if source not in ("env", "running"):
                    return self._send(400, {"ok": False,
                        "error": "source 只能是 env（当前 .env）或 running（容器运行中配置）"})
                label = "运行中配置" if source == "running" else ".env"
                try:
                    if source == "running":
                        text, detail = running_env_text()
                        summary = save_default(by, text=text, source="running",
                                               source_detail=detail)
                    else:
                        summary = save_default(by, source="env")
                except Exception as exc:
                    return self._send(500, {"ok": False,
                        "error": "保存%s为默认配置失败：%s" % (label, exc)})
                return self._send(200, {
                    "ok": True, "defaults": summary,
                    "message": "已保存当前%s为默认启动配置（%s）"
                               % (label, summary.get("saved_at", "—"))})
            if action == "load":
                try:
                    res = load_default(by)
                except FileNotFoundError:
                    return self._send(404, {"ok": False, "error": "尚未保存默认启动配置"})
                except Exception as exc:
                    return self._send(500, {"ok": False, "error": "恢复默认配置失败：%s" % exc})
                return self._send(200, {
                    "ok": True, "restored": "default-start.env",
                    "backup": res.get("backup", ""), "values": masked_values(),
                    "pending": diff_config(), "defaults": default_summary(),
                    "message": "已用默认启动配置覆盖 .env（原 .env 备份 %s），需点「保存并应用」才会生效"
                               % res.get("backup", "—")})
            if action == "clear":
                removed = clear_default()
                return self._send(200, {
                    "ok": True, "removed": removed, "defaults": default_summary(),
                    "message": "已清除默认启动配置"})
            if action == "auto_start":
                enabled = bool(body.get("value"))
                try:
                    summary = set_auto_start(enabled)
                except FileNotFoundError:
                    return self._send(404, {"ok": False, "error": "尚未保存默认启动配置"})
                except Exception as exc:
                    return self._send(500, {"ok": False, "error": "保存参数失败：%s" % exc})
                return self._send(200, {
                    "ok": True, "defaults": summary,
                    "message": "已%s「启动模型时自动套用默认配置」" % ("启用" if enabled else "关闭")})
            return self._send(400, {"ok": False,
                "error": "action 只能是 save / load / clear / auto_start"})

        if path == "/api/apply":
            if not _apply_lock.acquire(blocking=False):
                return self._send(409, {"ok": False, "error": "已有一次应用任务正在进行"})
            with _state_lock:
                _apply_state.update(phase="starting", started_at=time.time(),
                                    finished_at=None, rc=None, message="准备重建容器", log="")
            threading.Thread(target=_apply_worker, daemon=True).start()
            return self._send(200, {"ok": True, "apply": apply_status()})

        if path == "/api/service":
            action = str(body.get("action", "")).strip()
            if action not in ("start", "stop"):
                return self._send(400, {"ok": False, "error": "action 只能是 start 或 stop"})
            now = container_status()
            if action == "start" and now == "running":
                return self._send(409, {"ok": False, "error": "模型已在运行，无需启动"})
            if action == "stop" and now != "running":
                return self._send(409, {"ok": False, "error": "模型当前未运行（容器 %s）" % now})
            if not _apply_lock.acquire(blocking=False):
                return self._send(409, {"ok": False, "error": "已有一次重建 / 启停任务正在进行"})
            with _state_lock:
                _apply_state.update(phase="starting", action=action, started_at=time.time(),
                                    finished_at=None, rc=None,
                                    message=("准备启动模型" if action == "start" else "准备停止模型"),
                                    log="")
            threading.Thread(target=_service_worker, args=(action,), daemon=True).start()
            return self._send(200, {"ok": True, "action": action, "apply": apply_status()})

        if path == "/api/rollback":
            name = str(body.get("backup", ""))
            if not re.fullmatch(r"env-[0-9]{8}-[0-9]{6}-[A-Za-z0-9-]+\.env", name):
                return self._send(400, {"ok": False, "error": "备份文件名不合法"})
            src = BACKUP_DIR / name
            if not src.is_file():
                return self._send(404, {"ok": False, "error": "备份不存在"})
            make_backup("before-rollback")
            shutil.copy2(src, ENV_FILE)
            return self._send(200, {"ok": True, "restored": name,
                                   "values": current_values(), "pending": diff_config()})
        return self._send(404, {"ok": False, "error": "not found"})


def current_values_from_text(text):
    e = parse_env(text)
    m = re.search(r"--max-model-len(?:\s+|=)(\d+)", e.get("EXTRA_ARGS", ""))
    return {
        "SERVED_MODEL_NAME": e.get("SERVED_MODEL_NAME", "dsv41-flash"),
        "MAX_SEQS": e.get("MAX_SEQS", "8"),
        "MAX_BATCHED": e.get("MAX_BATCHED", "2048"),
        "MAX_MODEL_LEN": m.group(1) if m else str(DEFAULT_CTX),
        "PORT": e.get("PORT", "8000"),
        "P2P": e.get("P2P", "auto"),
        "API_KEY": e.get("API_KEY", ""),
    }


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


if __name__ == "__main__":
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    srv = Server(("0.0.0.0", LISTEN_PORT), Handler)
    print("dsv41-config listening on %d" % LISTEN_PORT, flush=True)
    srv.serve_forever()
