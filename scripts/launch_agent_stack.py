#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


HOST = str(os.environ.get("HOST") or "127.0.0.1").strip() or "127.0.0.1"
PORT = int(str(os.environ.get("PORT") or os.environ.get("SHOTGRID_PROXY_PORT") or "7331").strip() or "7331")
GATEWAY_PORT = int(str(os.environ.get("UTS_AGENT_GATEWAY_PORT") or "7340").strip() or "7340")
STACK_URL = f"http://{HOST}:{PORT}/"
REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_CMD = [sys.executable, "server/shotgrid_server.py"]
GATEWAY_CMD = ["node", "src/agent-gateway.mjs"]
WAIT_TIMEOUT_S = 60.0
POLL_INTERVAL_S = 0.5


def _request_json(url: str) -> tuple[int | None, dict[str, object] | None]:
    try:
        with urllib.request.urlopen(url, timeout=2.0) as response:
            payload = response.read().decode("utf-8", errors="replace")
            data = json.loads(payload) if payload else None
            return int(response.status), data if isinstance(data, dict) else None
    except urllib.error.HTTPError as exc:
        try:
            payload = exc.read().decode("utf-8", errors="replace")
            data = json.loads(payload) if payload else None
        except Exception:
            data = None
        return int(exc.code), data if isinstance(data, dict) else None
    except Exception:
        return None, None


def _wait_for(label: str, url: str, validator) -> None:
    deadline = time.time() + WAIT_TIMEOUT_S
    last_status: int | None = None
    last_payload: dict[str, object] | None = None
    while time.time() < deadline:
        status, payload = _request_json(url)
        if validator(status, payload):
            print(f"[launch-agent-stack] {label} ready at {url}")
            return
        last_status = status
        last_payload = payload
        time.sleep(POLL_INTERVAL_S)
    raise RuntimeError(
        f"{label} did not become healthy within {WAIT_TIMEOUT_S:.0f}s "
        f"(status={last_status}, payload={last_payload})"
    )


def _terminate_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> int:
    backend: subprocess.Popen[bytes] | None = None
    gateway: subprocess.Popen[bytes] | None = None

    def shutdown(*_args) -> None:
        print("\n[launch-agent-stack] Shutting down agent stack...")
        _terminate_process(gateway)
        _terminate_process(backend)
        raise SystemExit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        print(f"[launch-agent-stack] Starting UP TO SPEED backend at {STACK_URL}")
        backend = subprocess.Popen(BACKEND_CMD, cwd=REPO_ROOT)
        _wait_for(
            "Local broker health",
            f"{STACK_URL}api/local/health",
            lambda status, payload: status == 200 and isinstance(payload, dict) and payload.get("ok") is True,
        )
        _wait_for(
            "ShotGrid health",
            f"{STACK_URL}api/shotgrid/health",
            lambda status, payload: status == 200 and isinstance(payload, dict),
        )

        print(f"[launch-agent-stack] Starting agent gateway on http://{HOST}:{GATEWAY_PORT}/")
        gateway_env = dict(os.environ)
        gateway_env["UTS_MCP_BASE_URL"] = STACK_URL
        gateway = subprocess.Popen(GATEWAY_CMD, cwd=REPO_ROOT / "mcp", env=gateway_env)
        _wait_for(
            "Agent runtime health",
            f"{STACK_URL}api/agents/health",
            lambda status, payload: (
                status == 200
                and isinstance(payload, dict)
                and payload.get("ok") is True
                and isinstance(payload.get("gateway"), dict)
                and payload["gateway"].get("ok") is True
                and isinstance(payload["gateway"].get("session"), dict)
                and payload["gateway"]["session"].get("usesStaticFallback") is not True
            ),
        )

        print(f"[launch-agent-stack] Opening {STACK_URL}")
        webbrowser.open(STACK_URL)

        while True:
            if backend.poll() is not None:
                return int(backend.returncode or 1)
            if gateway.poll() is not None:
                return int(gateway.returncode or 1)
            time.sleep(1.0)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[launch-agent-stack] Failed: {exc}", file=sys.stderr)
        return 1
    finally:
        _terminate_process(gateway)
        _terminate_process(backend)


if __name__ == "__main__":
    raise SystemExit(main())
