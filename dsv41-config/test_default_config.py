#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression tests for the [default-start-1111] default startup config.

Runs against a throw-away copy of the recipe .env; it never touches the real
recipe.  Run with:  python3 test_default_config.py
"""
import importlib.util
import json
import os
import stat
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
MOD_PATH = HERE / "dsv41-config-server.py"


def load_module():
    spec = importlib.util.spec_from_file_location("dsv41cfg", str(MOD_PATH))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ENV = """\
# test env
PORT=8000
HOST=0.0.0.0
API_KEY=test-secret-1234
SERVED_MODEL_NAME=DeepSeek-V4.1-Flash
MODELS_DIR=/tmp/models
P2P=auto
EXTRA_ARGS='--allowed-origins ["*"] --max-model-len 262144'
MAX_SEQS=8
MAX_BATCHED=2048
"""


def setup_module():
    mod = load_module()
    tmp = Path(tempfile.mkdtemp(prefix="dsv41-default-test-"))
    repo = tmp / "recipe"
    logs = repo / "logs"
    logs.mkdir(parents=True)
    (repo / ".env").write_text(ENV, encoding="utf-8")
    (repo / "logs" / "serve.log").write_text("GPU KV cache size: 1,000 tokens\n", encoding="utf-8")
    mod.REPO = repo
    mod.ENV_FILE = repo / ".env"
    mod.LOG_DIR = logs
    mod.BACKUP_DIR = logs / "env-backups"
    mod.APPLY_LOG = logs / "config-apply.log"
    mod.DEFAULT_ENV = logs / "default-start.env"
    mod.DEFAULT_META = logs / "default-start.json"
    mod.DEFAULT_BACKUP_DIR = logs / "default-backups"
    mod.PAGE_FILE = HERE / "dsv41-config.html"
    return mod, tmp


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def assert_eq(got, want, label):
    if got != want:
        fail("%s: got %r want %r" % (label, got, want))


def main():
    mod, tmp = setup_module()

    # 1. no snapshot yet
    s = mod.default_summary()
    assert_eq(s["exists"], False, "initial exists")
    assert_eq(s["auto_start"], False, "initial auto_start")

    # 2. save current .env as default
    s = mod.save_default("127.0.0.1")
    assert_eq(s["exists"], True, "saved exists")
    assert_eq(s["matches_env"], True, "saved matches env")
    assert_eq(s["auto_start"], False, "saved auto_start")
    assert_eq(s["values"]["MAX_SEQS"], "8", "saved max seqs")
    if s["values"]["API_KEY"] == "test-secret-1234":
        fail("API key leaked in summary")
    if not (mod.DEFAULT_ENV.exists() and mod.DEFAULT_META.exists()):
        fail("snapshot files missing")
    mode = stat.S_IMODE(mod.DEFAULT_ENV.stat().st_mode)
    assert_eq(mode, 0o600, "snapshot mode")
    meta = json.loads(mod.DEFAULT_META.read_text(encoding="utf-8"))
    if "test-secret-1234" in json.dumps(meta):
        fail("API key stored in metadata")

    # 3. change .env -> summary must show a diff, not "matches"
    mod.ENV_FILE.write_text(ENV.replace("MAX_SEQS=8", "MAX_SEQS=4"), encoding="utf-8")
    s = mod.default_summary()
    assert_eq(s["matches_env"], False, "changed matches")
    assert_eq(s["diff_count"], 1, "diff count")
    assert_eq(s["diff"][0]["key"], "MAX_SEQS", "diff key")

    # 4. auto-start parameter persists
    s = mod.set_auto_start(True)
    assert_eq(s["auto_start"], True, "auto_start true")
    s = mod.default_summary()
    assert_eq(s["auto_start"], True, "auto_start persisted")

    # 5. apply before start restores .env and keeps a backup
    res = mod.apply_default_before_start()
    assert_eq(res["applied"], True, "apply before start")
    assert_eq(mod.ENV_FILE.read_text(encoding="utf-8"), ENV, "env restored")
    backups = list(mod.BACKUP_DIR.glob("env-*.env"))
    assert_eq(len(backups), 1, "env backup count")
    res2 = mod.apply_default_before_start()
    assert_eq(res2["applied"], False, "second apply no-op")
    assert_eq(res2["reason"], "already_same", "second apply reason")

    # 6. load default (explicit) writes .env and backs up
    mod.ENV_FILE.write_text(ENV.replace("MAX_SEQS=8", "MAX_SEQS=2"), encoding="utf-8")
    res = mod.load_default("127.0.0.1")
    if not res.get("backup"):
        fail("load_default returned no backup")
    assert_eq(mod.ENV_FILE.read_text(encoding="utf-8"), ENV, "load restored env")

    # 7. save again -> previous default is backed up
    mod.save_default("127.0.0.1")
    defs = list(mod.DEFAULT_BACKUP_DIR.glob("default-*.env"))
    assert_eq(len(defs), 1, "default backup count")

    # 7b. running snapshot: .env may be edited but not applied; the running
    #     command line must win for the saved default.
    pending_env = ENV.replace("MAX_SEQS=8", "MAX_SEQS=4").replace(
        "--max-model-len 262144", "--max-model-len 524288")
    mod.ENV_FILE.write_text(pending_env, encoding="utf-8")

    def fake_running(force=False):
        return {"health": 200, "cmdline": {
                    "max-model-len": "262144", "max-num-seqs": "8",
                    "max-num-batched-tokens": "2048",
                    "served-model-name": "DeepSeek-V4.1-Flash", "port": "8000"},
                "container": "running", "published_port": "8000",
                "checked_at": "11:00:00", "gpus": []}
    mod.runtime_status = fake_running
    text, detail = mod.running_env_text()
    if "MAX_SEQS=8" not in text:
        fail("running snapshot did not use live MAX_SEQS")
    live_vals = mod.current_values_from_text(text)
    assert_eq(live_vals["MAX_MODEL_LEN"], "262144", "running snapshot live ctx")
    if "--max-model-len 524288" in text:
        fail("running snapshot kept the pending 512K flag")
    s = mod.save_default("127.0.0.1", text=text, source="running", source_detail=detail)
    assert_eq(s["source"], "running", "running source")
    assert_eq(s["values"]["MAX_SEQS"], "8", "running max seqs")
    assert_eq(s["values"]["MAX_MODEL_LEN"], "262144", "running ctx")
    assert_eq(s["matches_env"], False, "running snapshot differs from pending .env")
    mod.ENV_FILE.write_text(ENV, encoding="utf-8")

    # 8. HTTP endpoints
    mod.runtime_status = fake_running

    srv = mod.Server(("127.0.0.1", 0), mod.Handler)
    port = srv.server_address[1]
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    base = "http://127.0.0.1:%d" % port

    def get(path):
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return r.status, json.loads(r.read().decode("utf-8"))

    def post(path, body):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json",
                                              "X-Admin-Key": "test-secret-1234"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    code, data = get("/api/config")
    assert_eq(code, 200, "GET /api/config")
    assert_eq(data["defaults"]["exists"], True, "GET defaults exists")
    assert_eq(data["defaults"]["auto_start"], True, "GET defaults auto_start")

    code, data = get("/api/status")
    assert_eq(code, 200, "GET /api/status")
    assert_eq(data["defaults"]["exists"], True, "status defaults exists")

    # save again via API
    code, data = post("/api/defaults", {"action": "save"})
    assert_eq(code, 200, "POST save")
    assert_eq(data["defaults"]["exists"], True, "POST save exists")

    # save the running config via API
    code, data = post("/api/defaults", {"action": "save", "source": "running"})
    assert_eq(code, 200, "POST save running")
    assert_eq(data["defaults"]["source"], "running", "POST save running source")

    # no-op config save + saveAsDefault must still snapshot
    code, data = post("/api/config", {"values": {}, "saveAsDefault": True})
    assert_eq(code, 200, "POST config noop + saveAsDefault")
    assert_eq(data["changed"], [], "noop changed")
    assert_eq(data["default_saved"]["exists"], True, "noop default saved")

    # toggle auto_start via API
    code, data = post("/api/defaults", {"action": "auto_start", "value": False})
    assert_eq(code, 200, "POST auto_start false")
    assert_eq(data["defaults"]["auto_start"], False, "API auto_start false")

    # 9. _service_worker("start") must restore the default before launching when
    #    auto_start is on.  Fake the subprocess so no real start.sh runs.
    mod.ENV_FILE.write_text(pending_env, encoding="utf-8")
    mod.set_auto_start(True)

    class FakePopen(object):
        def __init__(self, args, **kwargs):
            self.args = args
        def wait(self):
            return 0
    import types
    import subprocess as real_subprocess
    mod.subprocess = types.SimpleNamespace(Popen=FakePopen, STDOUT=real_subprocess.STDOUT)
    mod.run = lambda *a, **k: (0, "")
    mod.sync_gateway = lambda: (0, "ok")
    mod._apply_lock.acquire()
    mod._service_worker("start")
    default_text = mod.DEFAULT_ENV.read_text(encoding="utf-8")
    assert_eq(mod.ENV_FILE.read_text(encoding="utf-8"), default_text,
              "start applied default env")
    st = mod.apply_status()
    assert_eq(st["phase"], "done", "start phase")
    if "已套用默认启动配置" not in st["message"]:
        fail("start message missing default note: %r" % st["message"])
    mod.subprocess = real_subprocess

    # restore + clear
    code, data = post("/api/defaults", {"action": "load"})
    assert_eq(code, 200, "POST load")
    assert_eq(data["restored"], "default-start.env", "restored name")
    mod.set_auto_start(False)
    code, data = post("/api/defaults", {"action": "clear"})
    assert_eq(code, 200, "POST clear")
    assert_eq(data["defaults"]["exists"], False, "cleared")

    srv.shutdown()
    print("ALL OK")
    # best-effort cleanup
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
