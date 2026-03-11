#!/usr/bin/env python3

from __future__ import annotations

import json
import importlib
import os
import queue
import re
import select
import secrets
import shutil
import sqlite3
import sys
import threading
import time
import traceback
import base64
import tempfile
import uuid
import subprocess
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


def _env(*names: str, default: str | None = None) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value is not None and str(value).strip() != "":
            return value
    return default


def _env_int(*names: str) -> int | None:
    value = _env(*names)
    if value is None:
        return None
    try:
        return int(value)
    except Exception:
        raise ValueError(f"Expected int for env var {names[0]}, got: {value!r}")


def _parse_bool(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in ("1", "true", "yes", "y", "on")

def _debug_enabled() -> bool:
    return _parse_bool(_env("SHOTGRID_DEBUG", "DEBUG"))


def _log(msg: str):
    print(msg, file=sys.stderr)


def _log_debug(msg: str):
    if _debug_enabled():
        _log(msg)


class ShotGridApiError(RuntimeError):
    def __init__(self, status: int, message: str, *, url: str = "", payload: Any = None):
        super().__init__(message)
        self.status = int(status)
        self.url = url
        self.payload = payload


class ShotGridAuthError(ShotGridApiError):
    pass


def _iso_date(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _iso_datetime(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        try:
            return value.isoformat()
        except Exception:
            return str(value)
    return str(value)


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None
    try:
        normalized = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt
    except Exception:
        return None


def _calc_business_days(start_date: str, end_date: str) -> int:
    if not start_date or not end_date:
        return 0
    try:
        start = datetime.strptime(start_date, "%Y-%m-%d").date()
        end = datetime.strptime(end_date, "%Y-%m-%d").date()
    except Exception:
        return 0
    if end < start:
        return 0
    total_days = (end - start).days + 1
    full_weeks, extra_days = divmod(total_days, 7)
    count = full_weeks * 5
    start_weekday = start.weekday()  # Monday=0 .. Sunday=6
    for i in range(extra_days):
        if ((start_weekday + i) % 7) < 5:
            count += 1
    return count


def _coerce_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        raw = str(value).strip()
        if not raw:
            return None
        return int(raw)
    except Exception:
        return None


def _is_int_like(value: Any) -> bool:
    return _coerce_int(value) is not None


_SESSION_COOKIE_NAME = "uptospeed_session"
_SESSIONS: dict[str, dict[str, Any]] = {}
_SCRIPT_AUTH: dict[str, Any] = {}
_AUTH_POLICY_VALUES = {"user_only", "hybrid_explicit", "script_only"}

_AGENT_PROVIDER_VALUES = {"codex", "openai", "anthropic", "gemini"}
_AGENT_PROVIDER_ALIASES = {
    "claude": "anthropic",
}
_AGENT_DESTRUCTIVE_TOOLS = {"uts_delete_task", "uts_clear_endeavor", "uts_delete_endeavor"}
_AGENT_DEFAULT_CONFIG = {
    "enableStreaming": True,
    "strictSafetyLimits": True,
    "autoRunMentions": True,
    "backgroundSupervisorEnabled": True,
    "backgroundSupervisorIntervalMinutes": 15,
    "backgroundSupervisorProfileId": "",
    "defaultModel": "codex/default",
    "defaultModelByProject": {},
    "fallbacks": [],
    "models": {},
    "maxActionsPerRun": 8,
    "maxToolCallsPerRun": 24,
    "maxRetriesPerRun": 1,
    "toolTimeoutMs": 20000,
}
_AGENT_DEFAULT_PROFILE_ROLE = "operator"
_AGENT_RUN_LEASE_TTL_SECONDS = 180.0
_AGENT_RUN_HEARTBEAT_THROTTLE_SECONDS = 5.0
_AGENT_RUNTIME_LAUNCHER_COMMAND = str(_env("UTS_AGENT_RUNTIME_LAUNCHER_COMMAND", default="python3 scripts/launch_agent_stack.py") or "python3 scripts/launch_agent_stack.py").strip() or "python3 scripts/launch_agent_stack.py"
_AGENT_CONFIG_META_KEY = "agent_config_json"
_AGENT_RUN_STREAM_LOCK = threading.Lock()
_AGENT_RUN_STREAMS: dict[str, list[queue.Queue[tuple[str, Any, str | None]]]] = {}
_AGENT_RUN_TRANSIENT_EVENT_NAMES = {"message.assistant.delta", "run.progress"}
_AGENT_RUN_TRANSIENT_EVENTS: dict[str, list[tuple[str, Any, str | None]]] = {}
_AGENT_RUN_CANCEL_EVENTS: dict[str, threading.Event] = {}
_AGENT_CODEX_LOGIN_LOCK = threading.Lock()
_AGENT_CODEX_LOGIN_STATE: dict[str, Any] = {
    "running": False,
    "url": "",
    "code": "",
    "started_at": "",
    "updated_at": "",
    "finished_at": "",
    "exit_code": None,
    "error": "",
}


class _AgentRunCanceled(RuntimeError):
    """Raised when a user explicitly stops an in-flight agent run."""


def _now_s() -> float:
    return time.time()


def _shotgrid_user_auth_v2_enabled() -> bool:
    return _parse_bool(_env("SHOTGRID_USER_AUTH_V2", default="1"))


def _normalize_base_url(value: str) -> str:
    return value.strip().rstrip("/")

def _validate_base_url(value: str | None) -> str:
    if value is None:
        raise ValueError("Missing ShotGrid site URL")
    normalized = _normalize_base_url(str(value))
    parsed = urlparse(normalized)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Invalid ShotGrid site URL. Expected e.g. https://your-studio.shotgrid.autodesk.com")
    return normalized


def _coerce_http_error_status(value: int, *, fallback: int = HTTPStatus.INTERNAL_SERVER_ERROR) -> int:
    try:
        status = int(value)
    except Exception:
        return int(fallback)
    if status < 400 or status > 599:
        return int(fallback)
    return status


def _shotgrid_hint(status: int, message: str) -> str:
    msg = (message or "").lower()
    if status == 401:
        return "Authentication failed/expired. Reconnect (or verify script name/key)."
    if status == 403:
        return "Permission denied. Ensure this user/script has access to Tasks in that project."
    if status == 404:
        return "Not found. Double-check your ShotGrid site URL (SHOTGRID_URL)."
    if status == 406:
        return "Server rejected the request format/headers (Not Acceptable). Enable SHOTGRID_DEBUG=1 to see upstream details."
    if status == 422 or "unknown field" in msg or "invalid field" in msg:
        return "Schema/field mismatch. Try removing SHOTGRID_FIELD_* overrides or update them to match your site."
    if status == 415:
        return "Unsupported request format. Enable SHOTGRID_DEBUG=1 for full upstream details."
    if status == 429:
        return "Rate limited. Wait a moment and try again."
    return ""


def _parse_cookie_header(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    result: dict[str, str] = {}
    for part in raw.split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key:
            result[key] = value
    return result


def _session_cookie_header(session_id: str) -> str:
    # Note: no Secure flag because this server typically runs over http://127.0.0.1
    return f"{_SESSION_COOKIE_NAME}={session_id}; Path=/; HttpOnly; SameSite=Lax"


def _get_or_create_session(handler: SimpleHTTPRequestHandler) -> tuple[dict[str, Any], str | None]:
    cookies = _parse_cookie_header(handler.headers.get("Cookie"))
    session_id = cookies.get(_SESSION_COOKIE_NAME)
    if session_id and session_id in _SESSIONS:
        return _SESSIONS[session_id], None

    session_id = secrets.token_hex(24)
    session: dict[str, Any] = {
        "id": session_id,
        "created_at": _now_s(),
    }
    _SESSIONS[session_id] = session
    return session, _session_cookie_header(session_id)


def _get_session(handler: SimpleHTTPRequestHandler) -> dict[str, Any] | None:
    cookies = _parse_cookie_header(handler.headers.get("Cookie"))
    session_id = cookies.get(_SESSION_COOKIE_NAME)
    if not session_id:
        return None
    return _SESSIONS.get(session_id)


def _clear_session(handler: SimpleHTTPRequestHandler) -> str:
    cookies = _parse_cookie_header(handler.headers.get("Cookie"))
    session_id = cookies.get(_SESSION_COOKIE_NAME)
    if session_id:
        _SESSIONS.pop(session_id, None)
    return f"{_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"


def _http_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout_s: int = 30,
) -> tuple[int, Any, dict[str, str]]:
    req = Request(url, data=body, method=method.upper())
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read() or b""
            status = int(getattr(resp, "status", 200))
            resp_headers = {k: v for k, v in resp.headers.items()}
    except HTTPError as e:
        raw = e.read() or b""
        status = int(getattr(e, "code", 500))
        resp_headers = {k: v for k, v in getattr(e, "headers", {}).items()}
    except URLError as e:
        raise RuntimeError(f"Request failed: {e.reason}") from e
    except Exception as e:
        raise RuntimeError(f"Request failed: {e}") from e

    if not raw:
        return status, None, resp_headers

    try:
        return status, json.loads(raw.decode("utf-8")), resp_headers
    except Exception:
        try:
            return status, raw.decode("utf-8", errors="replace"), resp_headers
        except Exception:
            return status, raw, resp_headers


def _sg_token_url(base_url: str) -> str:
    return f"{_normalize_base_url(base_url)}/api/v1.1/auth/access_token"


def _sg_request_token(base_url: str, form: dict[str, str]) -> dict[str, Any]:
    url = _sg_token_url(base_url)
    body = urlencode(form).encode("utf-8")
    status, payload, _ = _http_json(
        "POST",
        url,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body=body,
        timeout_s=30,
    )
    if status < 200 or status >= 300 or not isinstance(payload, dict):
        msg = ""
        if isinstance(payload, dict):
            msg = str(payload.get("error_description") or payload.get("error") or "")
        elif payload is not None:
            msg = str(payload)
        if not msg:
            msg = f"HTTP {status}"
        raise ShotGridAuthError(int(status), f"ShotGrid auth failed: {msg}", url=url, payload=payload)
    return payload


def _store_oauth_tokens(target: dict[str, Any], token_payload: dict[str, Any]):
    access_token = token_payload.get("access_token")
    if not access_token:
        raise RuntimeError("ShotGrid auth response missing access_token")
    target["access_token"] = str(access_token)

    refresh_token = token_payload.get("refresh_token")
    if refresh_token:
        target["refresh_token"] = str(refresh_token)

    expires_in = token_payload.get("expires_in")
    try:
        expires_s = int(expires_in) if expires_in is not None else 0
    except Exception:
        expires_s = 0
    now = _now_s()
    if expires_s > 0:
        target["access_expires_at"] = now + max(0, expires_s - 30)
    else:
        # Default to 5 minutes if expires_in is not provided
        target["access_expires_at"] = now + 300

    # ShotGrid refresh tokens are single-use and are valid for 24 hours.
    if target.get("refresh_token"):
        target["refresh_expires_at"] = now + (24 * 60 * 60)

    _persist_auth_account_if_needed(target)


def _persist_auth_account_if_needed(auth: dict[str, Any]):
    if not isinstance(auth, dict):
        return
    if str(auth.get("mode") or "").strip().lower() != "user":
        return
    account_id = str(auth.get("account_id") or "").strip()
    if not account_id:
        return
    if auth.get("remembered") is not True:
        return
    repo_root_raw = auth.get("repo_root")
    if not repo_root_raw:
        return
    try:
        repo_root = Path(str(repo_root_raw)).resolve()
    except Exception:
        return
    _auth_accounts_upsert(
        repo_root,
        {
            "account_id": account_id,
            "base_url": str(auth.get("base_url") or "").strip(),
            "grant_type": str(auth.get("grant_type") or "").strip(),
            "login": str(auth.get("login") or "").strip(),
            "display_name": str(auth.get("name") or auth.get("display_name") or "").strip(),
            "sg_user_id": _coerce_int(auth.get("sg_user_id")),
            "access_token": str(auth.get("access_token") or "").strip(),
            "refresh_token": str(auth.get("refresh_token") or "").strip(),
            "access_expires_at": float(auth.get("access_expires_at") or 0),
            "refresh_expires_at": float(auth.get("refresh_expires_at") or 0),
            "remembered": True,
        },
    )


def _ensure_access_token(auth: dict[str, Any]) -> str:
    base_url = auth.get("base_url")
    if not base_url:
        raise RuntimeError("Missing ShotGrid base URL")

    token = auth.get("access_token")
    expires_at = float(auth.get("access_expires_at") or 0)
    now = _now_s()
    if token and expires_at and now < expires_at:
        return str(token)

    # Refresh if possible
    refresh_token = auth.get("refresh_token")
    refresh_expires_at = float(auth.get("refresh_expires_at") or 0)
    if refresh_token and refresh_expires_at and now < refresh_expires_at:
        payload = _sg_request_token(str(base_url), {"grant_type": "refresh_token", "refresh_token": str(refresh_token)})
        _store_oauth_tokens(auth, payload)
        return str(auth["access_token"])

    # Otherwise re-authenticate if this is a script auth context
    if auth.get("mode") == "script":
        client_id = auth.get("client_id")
        client_secret = auth.get("client_secret")
        if not client_id or not client_secret:
            raise RuntimeError("Missing ShotGrid script credentials")
        payload = _sg_request_token(
            str(base_url),
            {
                "grant_type": "client_credentials",
                "client_id": str(client_id),
                "client_secret": str(client_secret),
            },
        )
        _store_oauth_tokens(auth, payload)
        return str(auth["access_token"])

    if str(auth.get("mode") or "").strip().lower() == "user":
        auth["reauth_required"] = True
        _persist_auth_account_if_needed(auth)
        raise RuntimeError("reauth_required: Not authenticated. Sign in first.")
    raise RuntimeError("Not authenticated. Sign in first.")


def _sg_api(
    auth: dict[str, Any],
    method: str,
    path_or_url: str,
    *,
    query: dict[str, str] | None = None,
    json_body: Any | None = None,
    content_type: str | None = None,
    accept: str | None = None,
    timeout_s: int = 60,
    allow_retry: bool = True,
) -> Any:
    base_url = str(auth.get("base_url") or "")
    if not base_url:
        raise RuntimeError("Missing ShotGrid base URL")

    url = path_or_url if path_or_url.startswith("http") else f"{_normalize_base_url(base_url)}{path_or_url}"
    if query:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{urlencode(query)}"

    token = _ensure_access_token(auth)
    headers: dict[str, str] = {
        "Accept": accept or "application/json",
        "Authorization": f"Bearer {token}",
    }

    body_bytes: bytes | None = None
    if json_body is not None:
        body_bytes = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = content_type or "application/json; charset=utf-8"
    elif content_type:
        headers["Content-Type"] = content_type

    status, payload, _ = _http_json(method, url, headers=headers, body=body_bytes, timeout_s=timeout_s)
    if status == 401 and allow_retry and auth.get("refresh_token"):
        # Force refresh token on next call and retry once.
        auth["access_expires_at"] = 0
        token = _ensure_access_token(auth)
        headers["Authorization"] = f"Bearer {token}"
        status, payload, _ = _http_json(method, url, headers=headers, body=body_bytes, timeout_s=timeout_s)

    if status < 200 or status >= 300:
        msg = ""
        if isinstance(payload, dict):
            msg = str(payload.get("message") or payload.get("error") or payload.get("error_description") or "")
        elif payload is not None:
            msg = str(payload)
        if not msg or not str(msg).strip():
            msg = f"HTTP {status}"
        raise ShotGridApiError(int(status), msg, url=url, payload=payload)
    return payload


def _script_auth_from_env() -> dict[str, Any] | None:
    base_url = _env("SHOTGRID_URL", "SG_URL")
    script_name = _env("SHOTGRID_SCRIPT_NAME", "SG_SCRIPT_NAME")
    api_key = _env("SHOTGRID_API_KEY", "SG_API_KEY")
    if not base_url or not script_name or not api_key:
        return None

    global _SCRIPT_AUTH
    normalized_base = _normalize_base_url(base_url)
    if (
        not _SCRIPT_AUTH
        or _SCRIPT_AUTH.get("base_url") != normalized_base
        or _SCRIPT_AUTH.get("client_id") != script_name
        or _SCRIPT_AUTH.get("client_secret") != api_key
    ):
        _SCRIPT_AUTH = {
            "mode": "script",
            "base_url": normalized_base,
            "client_id": script_name,
            "client_secret": api_key,
        }
    return _SCRIPT_AUTH


def _session_auth(session: dict[str, Any] | None) -> dict[str, Any] | None:
    if not session:
        return None
    if session.get("mode") != "user":
        return None
    if not session.get("base_url") or not session.get("access_token"):
        return None
    return session


def _select_auth(handler: SimpleHTTPRequestHandler) -> dict[str, Any] | None:
    session = _session_auth(_get_session(handler))
    if session:
        return session
    return _script_auth_from_env()


def _normalize_auth_policy(value: Any, *, default: str = "script_only") -> str:
    raw = str(value or "").strip().lower()
    if raw in _AUTH_POLICY_VALUES:
        return raw
    return default


def _parse_auth_envelope(body: Any) -> dict[str, Any] | None:
    if not isinstance(body, dict):
        return None

    raw_auth = body.get("auth")
    source: dict[str, Any]
    if isinstance(raw_auth, dict):
        source = raw_auth
    else:
        source = body

    has_auth = isinstance(raw_auth, dict) or any(
        key in source
        for key in ("policy", "auth_policy", "account_id", "accountId", "allow_script_fallback", "allowScriptFallback")
    )
    if not has_auth:
        return None

    policy = _normalize_auth_policy(source.get("policy") or source.get("auth_policy"), default="script_only")
    account_id = str(source.get("account_id") or source.get("accountId") or "").strip() or None
    allow_script_fallback = _parse_bool(str(source.get("allow_script_fallback") or source.get("allowScriptFallback") or "0"))
    return {
        "policy": policy,
        "account_id": account_id,
        "allow_script_fallback": allow_script_fallback,
    }


def _is_reauth_required_error(error: Any) -> bool:
    text = str(error or "").lower()
    return "reauth_required" in text or "not authenticated" in text or "sign in first" in text


def _account_public_dict(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    account_id = str(value.get("account_id") or value.get("id") or "").strip()
    if not account_id:
        return None
    return {
        "id": account_id,
        "base_url": str(value.get("base_url") or "").strip(),
        "login": str(value.get("login") or "").strip(),
        "name": str(value.get("name") or value.get("display_name") or "").strip(),
        "sg_user_id": _coerce_int(value.get("sg_user_id")),
    }


def _session_account_public(session: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(session, dict):
        return None
    return _account_public_dict(session)


def _new_account_id() -> str:
    return f"acct-{secrets.token_hex(12)}"


def _build_effective_actor(auth: dict[str, Any] | None) -> str:
    if not isinstance(auth, dict):
        return "none"
    mode = str(auth.get("mode") or "").strip().lower()
    if mode == "script":
        return "script"
    if mode == "user":
        return "user"
    return "none"


def _build_legacy_auth_context(handler: SimpleHTTPRequestHandler) -> dict[str, Any]:
    auth = _select_auth(handler)
    return {
        "auth": auth,
        "policy": "legacy",
        "account_id": str(auth.get("account_id") or "").strip() or None if isinstance(auth, dict) else None,
        "allow_script_fallback": False,
        "effective_actor": _build_effective_actor(auth),
        "fallback_used": False,
        "requested_actor": _build_effective_actor(auth),
        "reauth_required": False,
        "error": "",
        "legacy": True,
    }


def _auth_from_account_record(repo_root: Path, record: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(record, dict):
        return None
    account_id = str(record.get("account_id") or "").strip()
    base_url = str(record.get("base_url") or "").strip()
    access_token = str(record.get("access_token") or "").strip()
    if not account_id or not base_url or not access_token:
        return None
    return {
        "mode": "user",
        "repo_root": str(repo_root),
        "account_id": account_id,
        "base_url": base_url,
        "grant_type": str(record.get("grant_type") or "").strip(),
        "login": str(record.get("login") or "").strip(),
        "name": str(record.get("display_name") or "").strip(),
        "sg_user_id": _coerce_int(record.get("sg_user_id")),
        "access_token": access_token,
        "refresh_token": str(record.get("refresh_token") or "").strip(),
        "access_expires_at": float(record.get("access_expires_at") or 0),
        "refresh_expires_at": float(record.get("refresh_expires_at") or 0),
        "remembered": bool(record.get("remembered")),
    }


def _resolve_user_auth_candidate(
    handler: SimpleHTTPRequestHandler,
    repo_root: Path,
    *,
    account_id: str | None = None,
) -> dict[str, Any] | None:
    session = _session_auth(_get_session(handler))
    requested_account_id = str(account_id or "").strip() or None
    if session:
        session_account_id = str(session.get("account_id") or "").strip() or None
        if not requested_account_id or requested_account_id == session_account_id:
            return session

    if requested_account_id:
        record = _auth_accounts_get(repo_root, requested_account_id)
        loaded = _auth_from_account_record(repo_root, record or {})
        if loaded:
            return loaded
    return None


def _resolve_request_auth(
    handler: SimpleHTTPRequestHandler,
    repo_root: Path,
    *,
    body: Any = None,
) -> dict[str, Any]:
    if not _shotgrid_user_auth_v2_enabled():
        return _build_legacy_auth_context(handler)

    envelope = _parse_auth_envelope(body)
    if envelope is None:
        return _build_legacy_auth_context(handler)

    policy = _normalize_auth_policy(envelope.get("policy"), default="script_only")
    account_id = str(envelope.get("account_id") or "").strip() or None
    allow_script_fallback = bool(envelope.get("allow_script_fallback"))
    requested_actor = "script" if policy == "script_only" else "user"

    script_auth = _script_auth_from_env()
    if policy == "script_only":
        if not script_auth:
            return {
                "auth": None,
                "policy": policy,
                "account_id": account_id,
                "allow_script_fallback": allow_script_fallback,
                "effective_actor": "none",
                "fallback_used": False,
                "requested_actor": requested_actor,
                "reauth_required": False,
                "error": "Script authentication is not configured.",
                "legacy": False,
            }
        try:
            _ensure_access_token(script_auth)
            return {
                "auth": script_auth,
                "policy": policy,
                "account_id": account_id,
                "allow_script_fallback": allow_script_fallback,
                "effective_actor": "script",
                "fallback_used": False,
                "requested_actor": requested_actor,
                "reauth_required": False,
                "error": "",
                "legacy": False,
            }
        except Exception as exc:
            return {
                "auth": None,
                "policy": policy,
                "account_id": account_id,
                "allow_script_fallback": allow_script_fallback,
                "effective_actor": "none",
                "fallback_used": False,
                "requested_actor": requested_actor,
                "reauth_required": False,
                "error": str(exc),
                "legacy": False,
            }

    user_error = "No authenticated user session."
    user_auth = _resolve_user_auth_candidate(handler, repo_root, account_id=account_id)
    if user_auth:
        try:
            _ensure_access_token(user_auth)
            return {
                "auth": user_auth,
                "policy": policy,
                "account_id": str(user_auth.get("account_id") or "").strip() or account_id,
                "allow_script_fallback": allow_script_fallback,
                "effective_actor": "user",
                "fallback_used": False,
                "requested_actor": requested_actor,
                "reauth_required": False,
                "error": "",
                "legacy": False,
            }
        except Exception as exc:
            user_error = str(exc)

    if policy == "hybrid_explicit" and allow_script_fallback and script_auth:
        try:
            _ensure_access_token(script_auth)
            return {
                "auth": script_auth,
                "policy": policy,
                "account_id": account_id,
                "allow_script_fallback": True,
                "effective_actor": "script",
                "fallback_used": True,
                "requested_actor": requested_actor,
                "reauth_required": _is_reauth_required_error(user_error),
                "error": "",
                "legacy": False,
            }
        except Exception as exc:
            return {
                "auth": None,
                "policy": policy,
                "account_id": account_id,
                "allow_script_fallback": True,
                "effective_actor": "none",
                "fallback_used": False,
                "requested_actor": requested_actor,
                "reauth_required": _is_reauth_required_error(user_error),
                "error": str(exc),
                "legacy": False,
            }

    return {
        "auth": None,
        "policy": policy,
        "account_id": account_id,
        "allow_script_fallback": allow_script_fallback,
        "effective_actor": "none",
        "fallback_used": False,
        "requested_actor": requested_actor,
        "reauth_required": _is_reauth_required_error(user_error),
        "error": user_error,
        "legacy": False,
    }


def _inject_auth_metadata(payload: dict[str, Any], auth_ctx: dict[str, Any] | None):
    if not isinstance(payload, dict):
        return
    ctx = auth_ctx or {}
    payload["effective_actor"] = str(ctx.get("effective_actor") or "none")
    payload["fallback_used"] = bool(ctx.get("fallback_used"))
    payload["auth_policy"] = str(ctx.get("policy") or "legacy")
    payload["fallback_allowed"] = bool(ctx.get("allow_script_fallback"))


_RUNTIME_APP_ROOT: Path | None = None
_RUNTIME_DATA_ROOT: Path | None = None
_RUNTIME_CONFIG_ROOT: Path | None = None


def _resolve_runtime_root(raw: str | None, fallback: Path) -> Path:
    path = Path(str(raw or "").strip()).expanduser() if raw else fallback
    if not path.is_absolute():
        path = (fallback / path).resolve()
    return path.resolve()


def _runtime_app_root(default_root: Path | None = None) -> Path:
    global _RUNTIME_APP_ROOT
    if _RUNTIME_APP_ROOT is None:
        fallback = Path(default_root or Path(__file__).resolve().parents[1]).resolve()
        _RUNTIME_APP_ROOT = _resolve_runtime_root(_env("UTS_APP_ROOT"), fallback)
    return _RUNTIME_APP_ROOT


def _runtime_data_root(app_root: Path | None = None) -> Path:
    global _RUNTIME_DATA_ROOT
    if _RUNTIME_DATA_ROOT is None:
        base_root = _runtime_app_root(app_root)
        _RUNTIME_DATA_ROOT = _resolve_runtime_root(_env("UTS_DATA_DIR"), base_root)
    _RUNTIME_DATA_ROOT.mkdir(parents=True, exist_ok=True)
    return _RUNTIME_DATA_ROOT


def _runtime_config_root(app_root: Path | None = None) -> Path:
    global _RUNTIME_CONFIG_ROOT
    if _RUNTIME_CONFIG_ROOT is None:
        data_root = _runtime_data_root(app_root)
        _RUNTIME_CONFIG_ROOT = _resolve_runtime_root(_env("UTS_CONFIG_DIR"), data_root)
    _RUNTIME_CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
    return _RUNTIME_CONFIG_ROOT


def _load_dotenv(repo_root: Path):
    search_roots: list[Path] = []
    for candidate in (_runtime_config_root(repo_root), _runtime_app_root(repo_root)):
        if candidate not in search_roots:
            search_roots.append(candidate)

    for root in search_roots:
        for filename in (".env.local", ".env"):
            dotenv_path = root / filename
            if not dotenv_path.exists():
                continue
            try:
                for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
                    line = raw_line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    key = key.strip()
                    value = value.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = value
            except Exception:
                # Ignore dotenv parsing errors; env vars can still be supplied via shell.
                pass

def _shotgrid_fields() -> dict[str, str]:
    # These are standard Task fields.
    return {
        "task_name": _env("SHOTGRID_FIELD_TASK_NAME", default="content") or "content",
        "entity": _env("SHOTGRID_FIELD_ENTITY", default="entity") or "entity",
        "project": _env("SHOTGRID_FIELD_PROJECT", default="project") or "project",
        "status": _env("SHOTGRID_FIELD_STATUS", default="sg_status_list") or "sg_status_list",
        "start": _env("SHOTGRID_FIELD_START", default="start_date") or "start_date",
        "end": _env("SHOTGRID_FIELD_END", default="due_date") or "due_date",
        "assignees": _env("SHOTGRID_FIELD_ASSIGNEES", default="task_assignees") or "task_assignees",
        "step": _env("SHOTGRID_FIELD_STEP", default="step") or "step",
        # Optional/custom fields (only used if set; avoids "unknown field" API errors)
        "dept_prod_note": _env("SHOTGRID_FIELD_DEPT_PROD_NOTE"),
        "target_status_summary": _env("SHOTGRID_FIELD_TARGET_STATUS_SUMMARY"),
        "task_comments": _env("SHOTGRID_FIELD_TASK_COMMENTS"),
    }


def _sg_rel_data(value: Any) -> Any:
    # ShotGrid uses a JSON:API-like shape in many endpoints; relationships may be
    # returned either directly or under a "data" key.
    if isinstance(value, dict) and "data" in value:
        return value.get("data")
    return value


def _sg_rel_name(value: Any) -> str:
    rel = _sg_rel_data(value)
    if rel is None:
        return ""
    if isinstance(rel, dict):
        return str(rel.get("name") or "")
    return ""


def _sg_rel_names(value: Any) -> str:
    rel = _sg_rel_data(value)
    if not rel:
        return ""
    if isinstance(rel, list):
        return ", ".join([str(r.get("name") or "") for r in rel if isinstance(r, dict) and r.get("name")])
    if isinstance(rel, dict):
        name = rel.get("name")
        return str(name) if name else ""
    return ""


def _task_record_to_uptospeed(record: dict[str, Any], fields: dict[str, str]) -> dict[str, Any]:
    attrs = record.get("attributes") if isinstance(record.get("attributes"), dict) else {}
    rels = record.get("relationships") if isinstance(record.get("relationships"), dict) else {}

    start = _iso_date(attrs.get(fields["start"]))
    end = _iso_date(attrs.get(fields["end"]))

    mapped: dict[str, Any] = {
        "Id": str(record.get("id") or ""),
        "Task Name": str(attrs.get(fields["task_name"]) or ""),
        "Link": _sg_rel_name(rels.get(fields["entity"])),
        "Status": str(attrs.get(fields["status"]) or ""),
        "Assigned To": _sg_rel_names(rels.get(fields["assignees"])),
        "Start": start,
        "End": end,
        "Duration": str(_calc_business_days(start, end)),
        "Pipeline Step": _sg_rel_name(rels.get(fields["step"])),
        "Project": _sg_rel_name(rels.get(fields["project"])),
        "__source": "shotgrid",
    }

    if fields.get("dept_prod_note"):
        value = attrs.get(fields["dept_prod_note"]) or ""
        if value:
            mapped["Dept Prod Note"] = value
    if fields.get("target_status_summary"):
        value = attrs.get(fields["target_status_summary"]) or ""
        if value:
            mapped["Target Status Summary"] = value
    if fields.get("task_comments"):
        value = attrs.get(fields["task_comments"]) or ""
        if value:
            mapped["Task Comments"] = value

    return mapped


def _sg_list_all_records(auth: dict[str, Any], entity: str, fields: list[str], *, page_size: int = 500, max_pages: int = 50) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for page in range(1, max_pages + 1):
        payload = _sg_api(
            auth,
            "GET",
            f"/api/v1.1/entity/{entity}",
            query={
                "fields": ",".join(fields),
                "page[size]": str(page_size),
                "page[number]": str(page),
            },
            timeout_s=60,
        )
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            break
        results.extend([d for d in data if isinstance(d, dict)])
        if len(data) < page_size:
            break
    return results


def _sg_search_records(
    auth: dict[str, Any],
    entity: str,
    filters: list[list[Any]],
    fields: list[str],
    *,
    page_size: int = 500,
    max_pages: int = 50,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for page in range(1, max_pages + 1):
        query = {
            "fields": ",".join(fields),
            "page[size]": str(page_size),
            "page[number]": str(page),
        }
        body = {"filters": filters}
        try:
            payload = _sg_api(
                auth,
                "POST",
                f"/api/v1.1/entity/{entity}/_search",
                query=query,
                json_body=body,
                content_type="application/vnd+shotgun.api3_array+json",
                timeout_s=60,
            )
        except ShotGridApiError as exc:
            # Compatibility: some environments reject the vendor content-type.
            msg = str(exc).lower()
            if exc.status in (400, 415) and (exc.status == 415 or "content-type" in msg or "unsupported" in msg):
                payload = _sg_api(
                    auth,
                    "POST",
                    f"/api/v1.1/entity/{entity}/_search",
                    query=query,
                    json_body=body,
                    content_type="application/json; charset=utf-8",
                    timeout_s=60,
                )
            else:
                raise
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            break
        results.extend([d for d in data if isinstance(d, dict)])
        if len(data) < page_size:
            break
    return results


def _sg_rel_id(value: Any) -> int | None:
    rel = _sg_rel_data(value)
    if isinstance(rel, dict):
        return _coerce_int(rel.get("id"))
    return None


def _sg_rel_type(value: Any) -> str:
    rel = _sg_rel_data(value)
    if isinstance(rel, dict):
        return str(rel.get("type") or "")
    return ""


def _sg_rel_items(value: Any) -> list[dict[str, Any]]:
    rel = _sg_rel_data(value)
    if isinstance(rel, list):
        return [item for item in rel if isinstance(item, dict)]
    if isinstance(rel, dict):
        return [rel]
    return []


def _sg_rel_has_task(value: Any, task_id: int) -> bool:
    target = int(task_id)
    for rel in _sg_rel_items(value):
        rel_id = _coerce_int(rel.get("id"))
        rel_type = str(rel.get("type") or "").strip().lower()
        if rel_id == target and rel_type in ("task", "tasks"):
            return True
    return False


def _sg_note_record_linked_to_task(note_record: dict[str, Any], task_id: int) -> bool:
    rels = note_record.get("relationships") if isinstance(note_record.get("relationships"), dict) else {}
    return _sg_rel_has_task(rels.get("note_links"), int(task_id)) or _sg_rel_has_task(rels.get("tasks"), int(task_id))


def _sg_fetch_note_linkage_record(auth: dict[str, Any], note_id: int) -> dict[str, Any] | None:
    prefixes = ("/api/v1.1", "/api/v1")
    last_404: ShotGridApiError | None = None
    for prefix in prefixes:
        try:
            payload = _sg_api(
                auth,
                "GET",
                f"{prefix}/entity/notes/{int(note_id)}",
                query={"fields": "note_links,tasks"},
                timeout_s=60,
            )
            data = payload.get("data") if isinstance(payload, dict) else None
            if isinstance(data, dict):
                return data
        except ShotGridApiError as exc:
            if exc.status == 404:
                last_404 = exc
                continue
            raise
    if last_404 is not None:
        raise last_404
    return None


def _sg_note_belongs_to_task(auth: dict[str, Any], note_record: dict[str, Any], task_id: int) -> bool:
    if _sg_note_record_linked_to_task(note_record, int(task_id)):
        return True

    rels = note_record.get("relationships") if isinstance(note_record.get("relationships"), dict) else {}
    has_linkage_fields = "note_links" in rels or "tasks" in rels
    if has_linkage_fields:
        return False

    note_id = _coerce_int(note_record.get("id"))
    if not note_id:
        return False
    fetched = _sg_fetch_note_linkage_record(auth, int(note_id))
    if not fetched:
        return False
    return _sg_note_record_linked_to_task(fetched, int(task_id))


def _sg_note_message_payload(record: dict[str, Any], *, entity_type: str, default_author: str = "Flow Production Tracking") -> dict[str, Any]:
    attrs = record.get("attributes") if isinstance(record.get("attributes"), dict) else {}
    rels = record.get("relationships") if isinstance(record.get("relationships"), dict) else {}
    created = _iso_datetime(attrs.get("created_at") or attrs.get("createdAt") or attrs.get("updated_at"))
    author = (
        _sg_rel_name(rels.get("user"))
        or _sg_rel_name(rels.get("created_by"))
        or str(attrs.get("user") or "")
        or default_author
    )
    content = str(
        attrs.get("content")
        or attrs.get("text")
        or attrs.get("body")
        or ""
    )
    sg_entity_id = _coerce_int(record.get("id"))
    message_id = f"sg-reply-{sg_entity_id}" if entity_type == "Reply" else f"sg-note-{sg_entity_id}"
    return {
        "message_id": message_id,
        "entity_type": entity_type,
        "sg_entity_id": sg_entity_id,
        "author": author,
        "content": content,
        "created_at": created or datetime.utcnow().isoformat() + "Z",
        "source": "shotgrid",
        "sync_status": "synced",
        "error": None,
        "op_id": None,
    }


def _sg_fetch_note_thread_contents(auth: dict[str, Any], note_id: int) -> list[dict[str, Any]]:
    prefixes = ("/api/v1.1", "/api/v1")
    last_404: ShotGridApiError | None = None
    for prefix in prefixes:
        try:
            payload = _sg_api(auth, "GET", f"{prefix}/entity/notes/{int(note_id)}/thread_contents", timeout_s=60)
            data = payload.get("data") if isinstance(payload, dict) else None
            if isinstance(data, list):
                return [item for item in data if isinstance(item, dict)]
            return []
        except ShotGridApiError as exc:
            if exc.status == 404:
                last_404 = exc
                continue
            raise
    if last_404 is not None:
        raise last_404
    return []


def _sg_fetch_task_note_records(auth: dict[str, Any], task_id: int) -> list[dict[str, Any]]:
    fields = [
        "content",
        "subject",
        "created_at",
        "updated_at",
        "user",
        "created_by",
        "project",
        "note_links",
        "tasks",
    ]
    task_filters = (
        {"type": "Task", "id": int(task_id)},
        {"type": "tasks", "id": str(int(task_id))},
        {"type": "tasks", "id": int(task_id)},
    )
    filter_attempts: list[list[list[Any]]] = []
    for rel_filter in task_filters:
        # "tasks" is a multi-entity field; "in" is the canonical operator.
        filter_attempts.append([["tasks", "in", rel_filter]])
        # Compatibility fallback for sites/proxies that expect "is".
        filter_attempts.append([["tasks", "is", rel_filter]])
        # Legacy fallback: some pipelines also link Task into note_links.
        filter_attempts.append([["note_links", "in", rel_filter]])
    for filters in filter_attempts:
        try:
            return _sg_search_records(auth, "notes", filters, fields, page_size=200, max_pages=10)
        except ShotGridApiError as exc:
            msg = str(exc).lower()
            payload_text = ""
            try:
                if exc.payload is not None:
                    payload_text = json.dumps(exc.payload).lower()
            except Exception:
                payload_text = str(exc.payload).lower() if exc.payload is not None else ""
            combined = f"{msg} {payload_text}"
            if exc.status in (400, 422) and (
                "unknown field" in combined or "invalid field" in combined or "doesn't exist" in combined or "does not exist" in combined
            ):
                continue
            raise
    return []


def _sg_task_has_note(auth: dict[str, Any], task_id: int, note_id: int) -> bool:
    note_record = _sg_fetch_note_linkage_record(auth, int(note_id))
    if not note_record:
        return False
    return _sg_note_belongs_to_task(auth, note_record, int(task_id))


def _sg_task_notes_threads(auth: dict[str, Any], task_id: int, *, include_replies: bool = True) -> list[dict[str, Any]]:
    note_records = _sg_fetch_task_note_records(auth, task_id)
    threads: list[dict[str, Any]] = []
    for note_record in note_records:
        if not _sg_note_belongs_to_task(auth, note_record, int(task_id)):
            continue
        note_id = _coerce_int(note_record.get("id"))
        if not note_id:
            continue
        attrs = note_record.get("attributes") if isinstance(note_record.get("attributes"), dict) else {}
        subject = str(attrs.get("subject") or attrs.get("content") or f"Note {note_id}")

        messages = [_sg_note_message_payload(note_record, entity_type="Note")]
        if include_replies:
            try:
                for entry in _sg_fetch_note_thread_contents(auth, int(note_id)):
                    entry_type = str(entry.get("type") or "").lower()
                    if "repl" not in entry_type:
                        continue
                    messages.append(_sg_note_message_payload(entry, entity_type="Reply"))
            except ShotGridApiError:
                # Thread content endpoint is not available on some sites; return note-only thread.
                pass

        messages.sort(key=lambda msg: _parse_iso_datetime(str(msg.get("created_at") or "")) or datetime.min)

        threads.append(
            {
                "thread_id": f"sg-note-{note_id}",
                "sg_note_id": int(note_id),
                "subject": subject,
                "source": "shotgrid",
                "messages": messages,
            }
        )

    threads.sort(key=lambda thread: _parse_iso_datetime(str((thread.get("messages") or [{}])[0].get("created_at") if thread.get("messages") else "")) or datetime.min)
    return threads


def _sg_fetch_task_note_context(auth: dict[str, Any], task_id: int) -> dict[str, Any]:
    prefixes = ("/api/v1.1", "/api/v1")
    last_404: ShotGridApiError | None = None
    for prefix in prefixes:
        try:
            payload = _sg_api(
                auth,
                "GET",
                f"{prefix}/entity/tasks/{int(task_id)}",
                query={"fields": "project,entity"},
                timeout_s=60,
            )
            data = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(data, dict):
                continue
            rels = data.get("relationships") if isinstance(data.get("relationships"), dict) else {}
            project_id = _sg_rel_id(rels.get("project"))
            note_link_rel = None
            entity_rel = _sg_rel_data(rels.get("entity"))
            if isinstance(entity_rel, dict):
                entity_id = _coerce_int(entity_rel.get("id"))
                entity_type = str(entity_rel.get("type") or "").strip()
                if entity_id and entity_type:
                    note_link_rel = {"type": entity_type, "id": str(int(entity_id))}
            return {
                "project_id": int(project_id) if project_id else None,
                "note_link_rel": note_link_rel,
            }
        except ShotGridApiError as exc:
            if exc.status == 404:
                last_404 = exc
                continue
            raise
    if last_404 is not None:
        raise last_404
    return {"project_id": None, "note_link_rel": None}


def _sg_create_note_for_task(
    auth: dict[str, Any],
    *,
    task_id: int,
    content: str,
    subject: str | None = None,
) -> dict[str, Any]:
    content_text = str(content or "").strip()
    if not content_text:
        raise ValueError("content is required")

    task_context = _sg_fetch_task_note_context(auth, int(task_id))
    project_id = task_context.get("project_id") or _env_int("SHOTGRID_PROJECT_ID", "SG_PROJECT_ID")
    if not project_id:
        raise ValueError("Unable to resolve project for task note create")

    attributes: dict[str, Any] = {"content": content_text}
    if subject and str(subject).strip():
        attributes["subject"] = str(subject).strip()

    def _normalize_rel_for_create(raw_rel: Any) -> dict[str, Any] | None:
        if not isinstance(raw_rel, dict):
            return None
        rel_type = str(raw_rel.get("type") or "").strip()
        rel_id = _coerce_int(raw_rel.get("id"))
        if not rel_type or not rel_id:
            return None
        return {"type": rel_type, "id": str(int(rel_id))}

    task_rel_candidates = [
        _normalize_rel_for_create({"type": "tasks", "id": int(task_id)}),
        _normalize_rel_for_create({"type": "Task", "id": int(task_id)}),
    ]
    task_rels = [rel for rel in task_rel_candidates if rel]

    note_link_rels: list[dict[str, Any]] = []
    note_link_primary = _normalize_rel_for_create(task_context.get("note_link_rel"))
    if note_link_primary:
        note_link_rels.append(note_link_primary)
        entity_type = str(note_link_primary.get("type") or "").strip()
        entity_id = _coerce_int(note_link_primary.get("id"))
        if entity_type and entity_id:
            singular_type = entity_type[:-1] if entity_type.endswith("s") else entity_type
            title_type = singular_type[:1].upper() + singular_type[1:] if singular_type else ""
            if title_type:
                normalized_alt = _normalize_rel_for_create({"type": title_type, "id": int(entity_id)})
                if normalized_alt:
                    note_link_rels.append(normalized_alt)
    else:
        # Fallback for sites where task-linked notes are stored directly in note_links.
        note_link_rels.extend(task_rels)

    def _dedupe_rels(rels: list[dict[str, Any]]) -> list[dict[str, Any]]:
        deduped: list[dict[str, Any]] = []
        seen: set[str] = set()
        for rel in rels:
            rel_type = str(rel.get("type") or "").strip()
            rel_id = str(rel.get("id") or "").strip()
            if not rel_type or not rel_id:
                continue
            key = f"{rel_type.lower()}:{rel_id}"
            if key in seen:
                continue
            seen.add(key)
            deduped.append({"type": rel_type, "id": rel_id})
        return deduped

    task_rels = _dedupe_rels(task_rels)
    note_link_rels = _dedupe_rels(note_link_rels)

    base_relationships: dict[str, Any] = {
        "project": {"data": {"type": "projects", "id": str(int(project_id))}},
    }

    relationship_attempts: list[dict[str, Any]] = []
    seen_attempts: set[str] = set()

    def _queue_relationship_attempt(note_rel: dict[str, Any] | None, task_rel: dict[str, Any] | None):
        relationships = {**base_relationships}
        if note_rel is not None:
            relationships["note_links"] = {"data": [note_rel]}
        if task_rel is not None:
            relationships["tasks"] = {"data": [task_rel]}
        key = json.dumps(relationships, sort_keys=True)
        if key in seen_attempts:
            return
        seen_attempts.add(key)
        relationship_attempts.append(relationships)

    for task_rel in task_rels:
        for note_rel in note_link_rels:
            _queue_relationship_attempt(note_rel, task_rel)
    for task_rel in task_rels:
        _queue_relationship_attempt(None, task_rel)
    for note_rel in note_link_rels:
        _queue_relationship_attempt(note_rel, None)

    last_exc: ShotGridApiError | None = None
    for relationships in relationship_attempts:
        try:
            return _sg_create_entity(auth, entity_type="notes", attributes=attributes, relationships=relationships)
        except ShotGridApiError as exc:
            last_exc = exc
            msg = str(exc).lower()
            payload_text = ""
            try:
                if exc.payload is not None:
                    payload_text = json.dumps(exc.payload).lower()
            except Exception:
                payload_text = str(exc.payload).lower() if exc.payload is not None else ""
            combined = f"{msg} {payload_text}"
            if exc.status in (400, 422) and (
                "unknown field" in combined or "invalid field" in combined or "doesn't exist" in combined or "does not exist" in combined
            ):
                continue
            raise
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Task note create failed")


def _sg_create_reply_for_note(auth: dict[str, Any], *, note_id: int, content: str) -> dict[str, Any]:
    content_text = str(content or "").strip()
    if not content_text:
        raise ValueError("content is required")
    if int(note_id) <= 0:
        raise ValueError("reply_to_note_id is required")

    attributes = {"content": content_text}
    relationship_attempts = (
        {"entity": {"data": {"type": "notes", "id": str(int(note_id))}}},
        {"note": {"data": {"type": "notes", "id": str(int(note_id))}}},
    )
    last_exc: ShotGridApiError | None = None
    for relationships in relationship_attempts:
        try:
            return _sg_create_entity(auth, entity_type="replies", attributes=attributes, relationships=relationships)
        except ShotGridApiError as exc:
            last_exc = exc
            msg = str(exc).lower()
            payload_text = ""
            try:
                if exc.payload is not None:
                    payload_text = json.dumps(exc.payload).lower()
            except Exception:
                payload_text = str(exc.payload).lower() if exc.payload is not None else ""
            combined = f"{msg} {payload_text}"
            if exc.status in (400, 422) and (
                "unknown field" in combined or "invalid field" in combined or "doesn't exist" in combined or "does not exist" in combined
            ):
                continue
            raise
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Task reply create failed")


def _sg_delete_entity(auth: dict[str, Any], *, entity_type: str, entity_id: int):
    normalized_type = str(entity_type or "").strip().lower()
    if normalized_type not in ("notes", "replies"):
        raise ValueError(f"Unsupported entity_type: {entity_type}")
    if int(entity_id) <= 0:
        raise ValueError("entity_id must be a positive integer")

    prefixes = ("/api/v1.1", "/api/v1")
    last_404: ShotGridApiError | None = None
    for prefix in prefixes:
        try:
            _sg_api(auth, "DELETE", f"{prefix}/entity/{normalized_type}/{int(entity_id)}", timeout_s=60)
            return
        except ShotGridApiError as exc:
            if exc.status == 404:
                last_404 = exc
                continue
            raise
    if last_404 is not None:
        raise last_404


def _sg_list_projects(auth: dict[str, Any]) -> list[dict[str, Any]]:
    records = _sg_list_all_records(auth, "projects", ["name"], page_size=500, max_pages=20)
    projects: list[dict[str, Any]] = []
    for rec in records:
        try:
            pid = int(rec.get("id") or 0)
        except Exception:
            continue
        attrs = rec.get("attributes") if isinstance(rec.get("attributes"), dict) else {}
        name = str(attrs.get("name") or "").strip()
        if not name:
            continue
        projects.append({"id": pid, "name": name})
    projects.sort(key=lambda p: p["name"].lower())
    return projects


_HUMAN_USER_CACHE: dict[str, dict[str, Any]] = {}


def _sg_find_human_user_by_name(auth: dict[str, Any], name: str) -> dict[str, Any] | None:
    key = name.strip().lower()
    if not key:
        return None
    cached = _HUMAN_USER_CACHE.get(key)
    if cached:
        return cached

    records = _sg_search_records(auth, "human_users", [["name", "is", name]], ["name"], page_size=5, max_pages=1)
    for rec in records:
        try:
            uid = int(rec.get("id") or 0)
        except Exception:
            continue
        attrs = rec.get("attributes") if isinstance(rec.get("attributes"), dict) else {}
        uname = str(attrs.get("name") or "").strip()
        if not uname:
            continue
        user_obj = {"type": "HumanUser", "id": uid, "name": uname}
        _HUMAN_USER_CACHE[key] = user_obj
        return user_obj
    return None


_STEP_CACHE: dict[str, dict[str, Any]] = {}


def _sg_find_step_by_name(auth: dict[str, Any], name: str) -> dict[str, Any] | None:
    key = name.strip().lower()
    if not key:
        return None
    cached = _STEP_CACHE.get(key)
    if cached:
        return cached

    # ShotGrid Step schema varies; try common fields.
    candidates = ("name", "code", "short_name")
    last_error: ShotGridApiError | None = None
    for field in candidates:
        try:
            records = _sg_search_records(auth, "steps", [[field, "is", name]], [field], page_size=5, max_pages=1)
        except ShotGridApiError as exc:
            last_error = exc
            msg = str(exc).lower()
            payload_text = ""
            try:
                if exc.payload is not None:
                    payload_text = json.dumps(exc.payload).lower()
            except Exception:
                payload_text = str(exc.payload).lower() if exc.payload is not None else ""
            combined = f"{msg} {payload_text}"
            if exc.status in (400, 422) and ("unknown field" in combined or "invalid field" in combined or "doesn't exist" in combined or "does not exist" in combined):
                continue
            raise
        for rec in records:
            try:
                sid = int(rec.get("id") or 0)
            except Exception:
                continue
            attrs = rec.get("attributes") if isinstance(rec.get("attributes"), dict) else {}
            sname = str(attrs.get(field) or "").strip() or name.strip()
            if sid <= 0:
                continue
            step_obj = {"type": "Step", "id": sid, "name": sname}
            _STEP_CACHE[key] = step_obj
            return step_obj

    if last_error and _debug_enabled():
        _log_debug(f"[uptospeed] Step lookup failed for {name!r}: {last_error}")
    return None


def _sg_lookup_field_unsupported(exc: ShotGridApiError) -> bool:
    msg = str(exc).lower()
    payload_text = ""
    try:
        if exc.payload is not None:
            payload_text = json.dumps(exc.payload).lower()
    except Exception:
        payload_text = str(exc.payload).lower() if exc.payload is not None else ""
    combined = f"{msg} {payload_text}"
    return exc.status in (400, 422) and (
        "unknown field" in combined
        or "invalid field" in combined
        or "doesn't exist" in combined
        or "does not exist" in combined
    )


def _sg_find_human_user_by_identity(
    auth: dict[str, Any],
    *,
    login: str | None = None,
    email: str | None = None,
) -> dict[str, Any] | None:
    candidates = [("login", login), ("email", email)]
    for field, raw in candidates:
        value = str(raw or "").strip()
        if not value:
            continue
        try:
            records = _sg_search_records(
                auth,
                "human_users",
                [[field, "is", value]],
                ["name", "login", "email"],
                page_size=5,
                max_pages=1,
            )
        except ShotGridApiError as exc:
            if _sg_lookup_field_unsupported(exc):
                continue
            raise
        for rec in records:
            uid = _coerce_int(rec.get("id"))
            if not uid or uid <= 0:
                continue
            attrs = rec.get("attributes") if isinstance(rec.get("attributes"), dict) else {}
            name_value = str(attrs.get("name") or "").strip()
            login_value = str(attrs.get("login") or "").strip()
            email_value = str(attrs.get("email") or "").strip()
            return {
                "type": "HumanUser",
                "id": int(uid),
                "name": name_value,
                "login": login_value,
                "email": email_value,
            }
    return None


def _sg_lookup_identity_for_login(auth: dict[str, Any], login_value: str | None) -> dict[str, Any] | None:
    candidate = str(login_value or "").strip()
    if not candidate:
        return None
    try:
        return _sg_find_human_user_by_identity(auth, login=candidate, email=candidate)
    except Exception:
        return None


def _sg_find_step_by_identity(
    auth: dict[str, Any],
    *,
    name: str | None = None,
    code: str | None = None,
    short_name: str | None = None,
) -> dict[str, Any] | None:
    candidates = [("name", name), ("code", code), ("short_name", short_name)]
    for field, raw in candidates:
        value = str(raw or "").strip()
        if not value:
            continue
        if field == "name":
            found = _sg_find_step_by_name(auth, value)
            if found:
                return found
        try:
            records = _sg_search_records(
                auth,
                "steps",
                [[field, "is", value]],
                ["name", "code", "short_name"],
                page_size=5,
                max_pages=1,
            )
        except ShotGridApiError as exc:
            if _sg_lookup_field_unsupported(exc):
                continue
            raise
        for rec in records:
            sid = _coerce_int(rec.get("id"))
            if not sid or sid <= 0:
                continue
            attrs = rec.get("attributes") if isinstance(rec.get("attributes"), dict) else {}
            return {
                "type": "Step",
                "id": int(sid),
                "name": str(attrs.get("name") or attrs.get("code") or attrs.get("short_name") or value).strip(),
                "code": str(attrs.get("code") or "").strip(),
                "short_name": str(attrs.get("short_name") or "").strip(),
            }
    return None


def _sg_find_project_entity_by_identity(
    auth: dict[str, Any],
    *,
    entity_type: str,
    project_id: int,
    name: str | None = None,
    code: str | None = None,
) -> dict[str, Any] | None:
    normalized_entity_type = str(entity_type or "").strip().lower()
    if normalized_entity_type not in ("assets", "shots", "sequences"):
        raise ValueError(f"Unsupported project entity type: {entity_type}")
    type_map = {
        "assets": "Asset",
        "shots": "Shot",
        "sequences": "Sequence",
    }
    lookup_values = [("code", code), ("name", name)]
    for preferred_field, raw in lookup_values:
        value = str(raw or "").strip()
        if not value:
            continue
        search_fields = [preferred_field]
        for extra_field in ("code", "name"):
            if extra_field not in search_fields:
                search_fields.append(extra_field)
        for field in search_fields:
            try:
                records = _sg_search_records(
                    auth,
                    normalized_entity_type,
                    [
                        [field, "is", value],
                        ["project", "is", {"type": "Project", "id": int(project_id)}],
                    ],
                    ["code", "name"],
                    page_size=5,
                    max_pages=1,
                )
            except ShotGridApiError as exc:
                if _sg_lookup_field_unsupported(exc):
                    continue
                raise
            for rec in records:
                entity_id = _coerce_int(rec.get("id"))
                if not entity_id or entity_id <= 0:
                    continue
                attrs = rec.get("attributes") if isinstance(rec.get("attributes"), dict) else {}
                return {
                    "type": type_map[normalized_entity_type],
                    "id": int(entity_id),
                    "name": str(attrs.get("name") or attrs.get("code") or value).strip(),
                    "code": str(attrs.get("code") or "").strip(),
                    "entityType": normalized_entity_type,
                }
    return None


def _sg_find_sequence_by_identity(
    auth: dict[str, Any],
    *,
    project_id: int,
    sequence_id: int | None = None,
    sequence_name: str | None = None,
) -> dict[str, Any] | None:
    resolved_id = _coerce_int(sequence_id)
    if resolved_id and resolved_id > 0:
        records = _sg_search_records(
            auth,
            "sequences",
            [
                ["id", "is", int(resolved_id)],
                ["project", "is", {"type": "Project", "id": int(project_id)}],
            ],
            ["code", "name"],
            page_size=2,
            max_pages=1,
        )
        for rec in records:
            entity_id = _coerce_int(rec.get("id"))
            if not entity_id or entity_id <= 0:
                continue
            attrs = rec.get("attributes") if isinstance(rec.get("attributes"), dict) else {}
            return {
                "type": "Sequence",
                "id": int(entity_id),
                "name": str(attrs.get("name") or attrs.get("code") or "").strip(),
                "code": str(attrs.get("code") or "").strip(),
                "entityType": "sequences",
            }

    sequence_key = str(sequence_name or "").strip()
    if not sequence_key:
        return None
    return _sg_find_project_entity_by_identity(
        auth,
        entity_type="sequences",
        project_id=int(project_id),
        name=sequence_key,
        code=sequence_key,
    )


def _sg_fetch_tasks(auth: dict[str, Any], fields: dict[str, str], project_id: int, status_values: list[str]) -> list[dict[str, Any]]:
    sg_fields = [
        fields["task_name"],
        fields["entity"],
        fields["project"],
        fields["status"],
        fields["start"],
        fields["end"],
        fields["assignees"],
        fields["step"],
    ]
    if fields.get("dept_prod_note"):
        sg_fields.append(fields["dept_prod_note"])
    if fields.get("target_status_summary"):
        sg_fields.append(fields["target_status_summary"])
    if fields.get("task_comments"):
        sg_fields.append(fields["task_comments"])

    filters: list[list[Any]] = [["project", "is", {"type": "Project", "id": project_id}]]
    if status_values:
        filters.append([fields["status"], "in", status_values])

    records = _sg_search_records(auth, "tasks", filters, sg_fields, page_size=500, max_pages=20)
    return [_task_record_to_uptospeed(r, fields) for r in records]


def _sg_update_task(
    auth: dict[str, Any],
    task_id: int,
    *,
    attributes: dict[str, Any],
    relationships: dict[str, Any] | None = None,
):
    # /api/v1.1/entity/... endpoints are JSON:API-like. Updates are typically PATCH with
    # Content-Type: application/vnd.api+json and a {data:{type,id,attributes,relationships}} body.
    body: dict[str, Any] = {"data": {"type": "tasks", "id": str(task_id), "attributes": attributes or {}}}
    if relationships:
        body["data"]["relationships"] = relationships

    # ShotGrid environments vary in accepted API versions and media types.
    # Prefer /api/v1.1 but fall back to /api/v1 if the entity update route returns 404.
    api_prefixes = ["/api/v1.1", "/api/v1"]

    def _try_json_api(content_type: str):
        last_404: ShotGridApiError | None = None
        for prefix in api_prefixes:
            try:
                _sg_api(
                    auth,
                    "PATCH",
                    f"{prefix}/entity/tasks/{task_id}",
                    json_body=body,
                    content_type=content_type,
                    timeout_s=60,
                )
                return
            except ShotGridApiError as exc:
                msg = str(exc).lower()
                if exc.status == 404:
                    last_404 = exc
                    continue
                if exc.status in (400, 415) or "content-type" in msg or "unsupported" in msg:
                    raise
                raise
        if last_404 is not None:
            raise last_404

    def _try_legacy_put():
        last_404: ShotGridApiError | None = None
        for prefix in api_prefixes:
            try:
                _sg_api(
                    auth,
                    "PUT",
                    f"{prefix}/entity/tasks/{task_id}",
                    json_body=attributes,
                    content_type="application/vnd+shotgun.api3_entity+json",
                    timeout_s=60,
                )
                return
            except ShotGridApiError as exc:
                if exc.status == 404:
                    last_404 = exc
                    continue
                raise
        if last_404 is not None:
            raise last_404

    def _try_put_attributes(content_type: str):
        last_404: ShotGridApiError | None = None
        for prefix in api_prefixes:
            try:
                _sg_api(
                    auth,
                    "PUT",
                    f"{prefix}/entity/tasks/{task_id}",
                    json_body=attributes,
                    content_type=content_type,
                    timeout_s=60,
                )
                return
            except ShotGridApiError as exc:
                msg = str(exc).lower()
                if exc.status == 404:
                    last_404 = exc
                    continue
                if exc.status in (400, 415) or "content-type" in msg or "unsupported" in msg:
                    raise
                raise
        if last_404 is not None:
            raise last_404

    def _try_patch_attributes(content_type: str):
        last_404: ShotGridApiError | None = None
        for prefix in api_prefixes:
            try:
                _sg_api(
                    auth,
                    "PATCH",
                    f"{prefix}/entity/tasks/{task_id}",
                    json_body=attributes,
                    content_type=content_type,
                    timeout_s=60,
                )
                return
            except ShotGridApiError as exc:
                msg = str(exc).lower()
                if exc.status == 404:
                    last_404 = exc
                    continue
                if exc.status in (400, 415) or "content-type" in msg or "unsupported" in msg:
                    raise
                raise
        if last_404 is not None:
            raise last_404

    # Try JSON:API first, then plain JSON, then attribute-only updates, then legacy api3.
    try:
        _try_json_api("application/vnd.api+json")
        return
    except ShotGridApiError as exc:
        msg = str(exc).lower()
        if exc.status not in (400, 415, 404) and "content-type" not in msg and "unsupported" not in msg:
            raise

    try:
        _try_json_api("application/json; charset=utf-8")
        return
    except ShotGridApiError as exc:
        msg = str(exc).lower()
        if exc.status not in (400, 415, 404) and "content-type" not in msg and "unsupported" not in msg:
            raise

    try:
        _try_put_attributes("application/json")
        return
    except ShotGridApiError as exc:
        msg = str(exc).lower()
        if exc.status not in (400, 415, 404) and "content-type" not in msg and "unsupported" not in msg:
            raise

    try:
        _try_patch_attributes("application/json")
        return
    except ShotGridApiError as exc:
        msg = str(exc).lower()
        if exc.status not in (400, 415, 404) and "content-type" not in msg and "unsupported" not in msg:
            raise

    _try_legacy_put()


def _sg_flatten_relationships_for_create(relationships: dict[str, Any] | None = None) -> dict[str, Any]:
    flat_rels: dict[str, Any] = {}
    if not isinstance(relationships, dict):
        return flat_rels
    for rel_field, rel_value in relationships.items():
        rel_data = rel_value.get("data") if isinstance(rel_value, dict) else rel_value
        if rel_data is None:
            flat_rels[rel_field] = None
            continue
        if isinstance(rel_data, list):
            flat_rels[rel_field] = [
                {"type": _sg_type_from_jsonapi(r.get("type", "")), "id": int(r["id"])}
                for r in rel_data
                if isinstance(r, dict) and r.get("id")
            ]
            continue
        if isinstance(rel_data, dict) and rel_data.get("id"):
            flat_rels[rel_field] = {
                "type": _sg_type_from_jsonapi(rel_data.get("type", "")),
                "id": int(rel_data["id"]),
            }
    return flat_rels


def _sg_create_entity(
    auth: dict[str, Any],
    *,
    entity_type: str,
    attributes: dict[str, Any],
    relationships: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_type = str(entity_type or "").strip()
    if not normalized_type:
        raise ValueError("entity_type is required")

    jsonapi_body: dict[str, Any] = {"data": {"type": normalized_type, "attributes": attributes or {}}}
    if relationships:
        jsonapi_body["data"]["relationships"] = relationships

    flat_body: dict[str, Any] = dict(attributes or {})
    flat_body.update(_sg_flatten_relationships_for_create(relationships))

    api_prefixes = ["/api/v1.1", "/api/v1"]

    def _try_post(json_body: dict[str, Any], content_type: str) -> dict[str, Any]:
        last_err: ShotGridApiError | None = None
        for prefix in api_prefixes:
            try:
                return _sg_api(
                    auth,
                    "POST",
                    f"{prefix}/entity/{normalized_type}",
                    json_body=json_body,
                    content_type=content_type,
                    timeout_s=60,
                )
            except ShotGridApiError as exc:
                if exc.status == 404:
                    last_err = exc
                    continue
                raise
        if last_err is not None:
            raise last_err
        raise RuntimeError("No API prefix succeeded")

    attempts = [
        (jsonapi_body, "application/vnd.api+json"),
        (jsonapi_body, "application/json; charset=utf-8"),
        (jsonapi_body, "application/json"),
        (flat_body, "application/json"),
    ]
    last_exc: ShotGridApiError | None = None
    for body, ct in attempts:
        try:
            return _try_post(body, ct)
        except ShotGridApiError as exc:
            last_exc = exc
            msg = str(exc).lower()
            if (
                exc.status in (400, 415)
                or "content-type" in msg
                or "unsupported" in msg
                or "doesn't exist" in msg
                or "does not exist" in msg
            ):
                continue
            raise
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("All create attempts failed")


def _sg_create_task(
    auth: dict[str, Any],
    *,
    attributes: dict[str, Any],
    relationships: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _sg_create_entity(
        auth,
        entity_type="tasks",
        attributes=attributes,
        relationships=relationships,
    )


def _sg_type_from_jsonapi(jsonapi_type: str) -> str:
    """Convert JSON:API plural type (e.g. 'projects') to ShotGrid singular type (e.g. 'Project')."""
    mapping = {
        "projects": "Project",
        "steps": "Step",
        "assets": "Asset",
        "sequences": "Sequence",
        "shots": "Shot",
        "human_users": "HumanUser",
        "tasks": "Task",
    }
    return mapping.get(jsonapi_type, jsonapi_type.rstrip("s").capitalize())


def _sg_find_entity_by_name(auth: dict[str, Any], name: str, project_id: int | None = None) -> dict[str, Any] | None:
    """Search for an Asset or Shot by name and return {type, id, name}.

    ShotGrid relationship data exposes a ``name`` attribute which typically
    corresponds to the ``code`` field for Assets/Shots, but some studios
    customise this.  We therefore try ``code`` first (the standard display
    field) and fall back to ``name`` — mirroring the approach used by
    ``_sg_find_step_by_name``.

    When the tasks were originally pulled from ShotGrid the Link value was
    extracted via ``_sg_rel_name`` which reads the relationship ``name``.
    Searching by both ``code`` and ``name`` ensures we can resolve the entity
    back regardless of which field the studio uses as the display name.
    """
    key = name.strip()
    if not key:
        return None
    # Try Assets first, then Shots.  For each entity type try the ``code``
    # field (standard) then ``name`` as a fallback.
    for entity_type in ("assets", "shots"):
        sg_type = "Asset" if entity_type == "assets" else "Shot"
        for field in ("code", "name"):
            try:
                filters: list[list[Any]] = [[field, "is", key]]
                if project_id:
                    filters.append(["project", "is", {"type": "Project", "id": int(project_id)}])
                records = _sg_search_records(auth, entity_type, filters, [field], page_size=5, max_pages=1)
            except ShotGridApiError as exc:
                msg = str(exc).lower()
                payload_text = ""
                try:
                    if exc.payload is not None:
                        payload_text = json.dumps(exc.payload).lower()
                except Exception:
                    payload_text = str(exc.payload).lower() if exc.payload is not None else ""
                combined = f"{msg} {payload_text}"
                if exc.status in (400, 422) and ("unknown field" in combined or "invalid field" in combined or "doesn't exist" in combined or "does not exist" in combined):
                    continue
                # Don't let a transient error on one entity type block the other.
                break
            for rec in records:
                try:
                    eid = int(rec.get("id") or 0)
                except Exception:
                    continue
                if eid <= 0:
                    continue
                return {"type": sg_type, "id": eid, "name": key}
    return None


def _parse_json_body(handler: BaseHTTPRequestHandler) -> Any:
    raw_len = handler.headers.get("Content-Length")
    if not raw_len:
        return None
    try:
        length = int(raw_len)
    except Exception:
        raise ValueError("Invalid Content-Length")
    data = handler.rfile.read(length)
    if not data:
        return None
    try:
        return json.loads(data.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"Invalid JSON body: {exc}")


def _respond_json(handler: SimpleHTTPRequestHandler, status: int, payload: Any, extra_headers: dict[str, str] | None = None):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    if extra_headers:
        for key, value in extra_headers.items():
            handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(body)


def _respond_redirect(handler: SimpleHTTPRequestHandler, location: str, *, status: int = HTTPStatus.FOUND, extra_headers: dict[str, str] | None = None):
    handler.send_response(status)
    handler.send_header("Location", location)
    handler.send_header("Cache-Control", "no-store")
    if extra_headers:
        for key, value in extra_headers.items():
            handler.send_header(key, value)
    handler.end_headers()


def _respond_html(handler: SimpleHTTPRequestHandler, status: int, html: str, *, extra_headers: dict[str, str] | None = None):
    body = html.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    if extra_headers:
        for key, value in extra_headers.items():
            handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(body)


def _respond_sse_headers(handler: SimpleHTTPRequestHandler):
    handler.send_response(HTTPStatus.OK)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "keep-alive")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()


def _sse_send(handler: SimpleHTTPRequestHandler, event: str, payload: Any, event_id: str | None = None):
    data = json.dumps(payload, ensure_ascii=False)
    lines: list[str] = []
    if event_id:
        lines.append(f"id: {event_id}\n")
    if event:
        lines.append(f"event: {event}\n")
    for line in data.splitlines() or [""]:
        lines.append(f"data: {line}\n")
    lines.append("\n")
    handler.wfile.write("".join(lines).encode("utf-8"))
    handler.wfile.flush()


def _sse_comment(handler: SimpleHTTPRequestHandler, comment: str):
    handler.wfile.write(f": {comment}\n\n".encode("utf-8"))
    handler.wfile.flush()


class _ShotGridStreamSubscriber:
    def __init__(self):
        self.queue: queue.Queue[tuple[str, Any, str | None]] = queue.Queue(maxsize=200)


class _ShotGridTaskStream:
    def __init__(
        self,
        *,
        key: str,
        auth: dict[str, Any],
        fields: dict[str, str],
        project_id: int,
        interval: float,
        max_updates: int,
    ):
        self.key = key
        self.auth = auth
        self.fields = fields
        self.project_id = int(project_id)
        self.interval = float(interval)
        self.max_updates = int(max_updates)

        self._lock = threading.Lock()
        self._subscribers: set[_ShotGridStreamSubscriber] = set()
        self._stop_event = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"sg-stream:{key}", daemon=True)

        self._last_seen = datetime.utcnow()
        self._last_sent_by_id: dict[int, datetime] = {}

        self._thread.start()

    def update_config(self, *, interval: float, max_updates: int):
        # Prefer the fastest interval requested (bounded), and the largest max_updates requested.
        with self._lock:
            self.interval = min(self.interval, float(interval))
            self.max_updates = max(self.max_updates, int(max_updates))

    def subscribe(self, subscriber: _ShotGridStreamSubscriber):
        with self._lock:
            self._subscribers.add(subscriber)

    def unsubscribe(self, subscriber: _ShotGridStreamSubscriber):
        with self._lock:
            self._subscribers.discard(subscriber)

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def stop(self):
        self._stop_event.set()

    def is_stopped(self) -> bool:
        return self._stop_event.is_set()

    def broadcast_task_updates(self, updates: list[dict[str, Any]]):
        if not updates:
            return
        payload = {"ok": True, "count": len(updates), "updates": updates, "ts": datetime.utcnow().isoformat() + "Z"}
        self._broadcast("task_updates", payload, event_id=str(int(time.time() * 1000)))

    def _broadcast(self, event: str, payload: Any, event_id: str | None = None):
        with self._lock:
            subscribers = list(self._subscribers)
        if not subscribers:
            return

        item = (event, payload, event_id)
        for sub in subscribers:
            try:
                sub.queue.put_nowait(item)
            except queue.Full:
                # Best effort: drop oldest item and retry once.
                try:
                    sub.queue.get_nowait()
                    sub.queue.put_nowait(item)
                except Exception:
                    continue

    def _run(self):
        fields = self.fields
        sg_fields = [
            fields["task_name"],
            fields["entity"],
            fields["project"],
            fields["status"],
            fields["start"],
            fields["end"],
            fields["assignees"],
            fields["step"],
            "updated_at",
        ]
        if fields.get("dept_prod_note"):
            sg_fields.append(fields["dept_prod_note"])
        if fields.get("target_status_summary"):
            sg_fields.append(fields["target_status_summary"])
        if fields.get("task_comments"):
            sg_fields.append(fields["task_comments"])

        while not self._stop_event.is_set():
            last_seen = self._last_seen
            poll_since = last_seen - timedelta(seconds=1)
            poll_since_utc = poll_since.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
            filters = [
                ["project", "is", {"type": "Project", "id": self.project_id}],
                ["updated_at", "greater_than", poll_since_utc],
            ]

            changed: list[dict[str, Any]] = []
            max_updated_at = last_seen
            try:
                tasks = _sg_search_records(self.auth, "tasks", filters, sg_fields, page_size=500, max_pages=2) or []
            except Exception as exc:
                self._broadcast(
                    "sg_error",
                    {"ok": False, "error": str(exc), "ts": datetime.utcnow().isoformat() + "Z"},
                    event_id=str(int(time.time() * 1000)),
                )
                self._stop_event.wait(self.interval)
                continue

            for task in tasks:
                if not isinstance(task, dict):
                    continue
                raw_id = task.get("id")
                if raw_id is None:
                    continue
                try:
                    task_id = int(raw_id)
                except Exception:
                    continue

                attrs = task.get("attributes") if isinstance(task.get("attributes"), dict) else {}
                updated_at_raw = attrs.get("updated_at")
                updated_at = _parse_iso_datetime(str(updated_at_raw) if updated_at_raw is not None else None)
                if updated_at is None:
                    continue
                prev = self._last_sent_by_id.get(task_id)
                if prev is not None and updated_at <= prev:
                    continue
                self._last_sent_by_id[task_id] = updated_at
                if updated_at > max_updated_at:
                    max_updated_at = updated_at

                mapped = _task_record_to_uptospeed(task, fields)
                mapped["__updated_at"] = _iso_datetime(updated_at_raw)
                changed.append(mapped)

            self._last_seen = max_updated_at

            if len(changed) > self.max_updates:
                self._broadcast(
                    "refresh",
                    {
                        "ok": True,
                        "reason": "too_many_updates",
                        "count": len(changed),
                        "ts": datetime.utcnow().isoformat() + "Z",
                    },
                    event_id=str(int(time.time() * 1000)),
                )
            elif changed:
                self.broadcast_task_updates(changed)

            self._stop_event.wait(self.interval)


_TASK_STREAMS_LOCK = threading.Lock()
_TASK_STREAMS: dict[str, _ShotGridTaskStream] = {}


def _task_stream_key(auth: dict[str, Any], project_id: int) -> str:
    base_url = str(auth.get("base_url") or "")
    mode = str(auth.get("mode") or "")
    ident = ""
    if mode == "script":
        ident = str(auth.get("client_id") or "script")
    elif auth.get("account_id"):
        ident = f"account:{auth.get('account_id')}"
    elif auth.get("sg_user_id"):
        ident = f"sg-user:{auth.get('sg_user_id')}"
    elif auth.get("id"):
        ident = f"id:{auth.get('id')}"
    else:
        ident = "user"
    return f"{mode}:{ident}@{base_url}|project:{int(project_id)}"


def _subscribe_task_stream(
    *,
    auth: dict[str, Any],
    fields: dict[str, str],
    project_id: int,
    interval: float,
    max_updates: int,
) -> tuple[_ShotGridTaskStream, _ShotGridStreamSubscriber]:
    key = _task_stream_key(auth, project_id)
    subscriber = _ShotGridStreamSubscriber()
    with _TASK_STREAMS_LOCK:
        stream = _TASK_STREAMS.get(key)
        if stream is None or stream.is_stopped():
            stream = _ShotGridTaskStream(
                key=key,
                auth=auth,
                fields=fields,
                project_id=project_id,
                interval=interval,
                max_updates=max_updates,
            )
            _TASK_STREAMS[key] = stream
        else:
            stream.update_config(interval=interval, max_updates=max_updates)
        stream.subscribe(subscriber)
    return stream, subscriber


def _unsubscribe_task_stream(stream: _ShotGridTaskStream, subscriber: _ShotGridStreamSubscriber):
    with _TASK_STREAMS_LOCK:
        stream.unsubscribe(subscriber)
        if stream.subscriber_count() == 0:
            stream.stop()
            _TASK_STREAMS.pop(stream.key, None)


def _broadcast_task_updates(auth: dict[str, Any], project_id: int, updates: list[dict[str, Any]]):
    if not updates:
        return
    key = _task_stream_key(auth, project_id)
    with _TASK_STREAMS_LOCK:
        stream = _TASK_STREAMS.get(key)
    if not stream:
        return
    stream.broadcast_task_updates(updates)


_TASKS_CACHE: dict[str, dict[str, Any]] = {}
_DISK_CACHE: dict[str, dict[str, Any]] = {}
_DISK_CACHE_PATH: Path | None = None
_DISK_CACHE_LOCK = threading.Lock()


def _cache_ttl_seconds() -> int:
    value = _env_int("SHOTGRID_CACHE_TTL_SECONDS")
    if value is None:
        return 300
    return max(0, value)


def _disk_cache_path(repo_root: Path) -> Path:
    global _DISK_CACHE_PATH
    if _DISK_CACHE_PATH is None:
        _DISK_CACHE_PATH = _runtime_data_root(repo_root) / ".shotgrid_cache.json"
    return _DISK_CACHE_PATH


def _load_disk_cache(repo_root: Path):
    path = _disk_cache_path(repo_root)
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        entries = data.get("entries")
        if isinstance(entries, dict):
            with _DISK_CACHE_LOCK:
                _DISK_CACHE.clear()
                for k, v in entries.items():
                    if isinstance(v, dict) and isinstance(v.get("payload"), dict):
                        _DISK_CACHE[str(k)] = {"payload": v["payload"], "fetched_at": v.get("fetched_at")}
    except Exception:
        # Cache is a best-effort speed-up; ignore parse errors.
        return


def _save_disk_cache():
    if _DISK_CACHE_PATH is None:
        return
    try:
        with _DISK_CACHE_LOCK:
            data = {
                "version": 1,
                "entries": _DISK_CACHE,
            }
        tmp = _DISK_CACHE_PATH.with_suffix(_DISK_CACHE_PATH.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_DISK_CACHE_PATH)
    except Exception:
        return


def _apply_updates_to_cached_payload(payload: dict[str, Any], updates: list[dict[str, Any]]):
    tasks = payload.get("tasks")
    if not isinstance(tasks, list) or not updates:
        return

    update_by_id: dict[str, dict[str, Any]] = {}
    for u in updates:
        if not isinstance(u, dict):
            continue
        task_id = u.get("Id")
        if task_id is None:
            continue
        update_by_id[str(task_id)] = u

    if not update_by_id:
        return

    for task in tasks:
        if not isinstance(task, dict):
            continue
        task_id = task.get("Id")
        if task_id is None:
            continue
        update = update_by_id.get(str(task_id))
        if not update:
            continue
        for k, v in update.items():
            if k == "Id":
                continue
            task[k] = v
        task["Duration"] = str(_calc_business_days(task.get("Start") or "", task.get("End") or ""))


_LOCAL_BROKER_DB_PATH: Path | None = None
_LOCAL_BROKER_INIT_LOCK = threading.Lock()
_LOCAL_BROKER_INITIALIZED = False
_LOCAL_BROKER_WORKER_THREAD: threading.Thread | None = None
_LOCAL_BROKER_STOP_EVENT = threading.Event()
_LOCAL_BROKER_WAKE_EVENT = threading.Event()
_LOCAL_BROKER_RETRY_BASE_SECONDS = 3.0
_LOCAL_BROKER_RETRY_MAX_SECONDS = 120.0
_LOCAL_BROKER_CONFIG_LOCK = threading.Lock()
_LOCAL_BROKER_ENCRYPTION_CONFIGURED = False
_LOCAL_BROKER_SQLITE_MODULE: Any = sqlite3
_LOCAL_BROKER_ENCRYPTION_KEY: str | None = None
_LOCAL_BROKER_ENCRYPTION_MODE = "plaintext"
_LOCAL_BROKER_ENCRYPTION_KEY_SOURCE = "none"
_LOCAL_BROKER_MANAGED_KEY_FILENAME = "local_broker.key"

_LOCAL_TASK_FIELD_ALIASES = {
    "id": "Id",
    "Id": "Id",
    "name": "Task Name",
    "Task Name": "Task Name",
    "asset": "Link",
    "Link": "Link",
    "artist": "Assigned To",
    "Assigned To": "Assigned To",
    "department": "Pipeline Step",
    "Pipeline Step": "Pipeline Step",
    "status": "Status",
    "Status": "Status",
    "start": "Start",
    "Start": "Start",
    "end": "End",
    "End": "End",
    "notes": "Dept Prod Note",
    "Dept Prod Note": "Dept Prod Note",
    "description": "Task Comments",
    "Task Comments": "Task Comments",
    "targetStatus": "Target Status Summary",
    "Target Status Summary": "Target Status Summary",
    "allocation": "% Allocation",
    "% Allocation": "% Allocation",
    "project": "Project",
    "Project": "Project",
    "duration": "Duration",
    "Duration": "Duration",
    "projectStage": "Project Stage",
    "Project Stage": "Project Stage",
    "location": "Location",
    "Location": "Location",
    "deadline": "Deadline",
    "Deadline": "Deadline",
    "deptEstimate": "Dept Est",
    "Dept Est": "Dept Est",
    "totalWork": "Total Work",
    "Total Work": "Total Work",
}


_LOCAL_BROKER_ENTITY_TYPE_ALIASES = {
    "asset": "asset",
    "assets": "asset",
    "shot": "shot",
    "shots": "shot",
    "sequence": "sequence",
    "sequences": "sequence",
    "artist": "artist",
    "artists": "artist",
    "human_user": "artist",
    "human_users": "artist",
    "department": "department",
    "departments": "department",
    "step": "department",
    "steps": "department",
}

_LOCAL_BROKER_ENTITY_TO_JSONAPI = {
    "asset": "assets",
    "shot": "shots",
    "sequence": "sequences",
    "artist": "human_users",
    "department": "steps",
}

_LOCAL_TO_SHOTGRID_STATUS_MAP = {
    "sch": "wtg",
    "review": "rev",
    "done": "fin",
    "cmp": "fin",
    "apr": "fin",
}

_PIPELINE_STEP_NONE_ALIASES = {
    "client",
    "milestone",
    "delivery",
    "review",
}


def _local_broker_clean_text(value: Any) -> str:
    return str(value or "").strip()


def _local_broker_normalize_entity_type(value: Any) -> str | None:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    return _LOCAL_BROKER_ENTITY_TYPE_ALIASES.get(raw)


def _local_broker_normalize_entity_payload(entity_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    normalized_type = _local_broker_normalize_entity_type(entity_type)
    if not normalized_type:
        raise ValueError(f"Unsupported entity type: {entity_type}")
    if not isinstance(payload, dict):
        raise ValueError("Entity payload must be an object")

    if normalized_type in ("asset", "sequence"):
        name = _local_broker_clean_text(payload.get("name") or payload.get("code"))
        code = _local_broker_clean_text(payload.get("code") or name)
        description = _local_broker_clean_text(payload.get("description"))
        if not name:
            raise ValueError(f"{normalized_type} name is required")
        return {
            "name": name,
            "code": code or name,
            "description": description,
        }

    if normalized_type == "shot":
        name = _local_broker_clean_text(payload.get("name") or payload.get("code"))
        code = _local_broker_clean_text(payload.get("code") or name)
        description = _local_broker_clean_text(payload.get("description"))
        sequence_name = _local_broker_clean_text(payload.get("sequenceName") or payload.get("sequence"))
        sequence_id = _coerce_int(payload.get("sequenceId") or payload.get("sequence_id"))
        if not name:
            raise ValueError("shot name is required")
        if not (sequence_id and sequence_id > 0) and not sequence_name:
            raise ValueError("shot requires sequenceName or sequenceId")
        return {
            "name": name,
            "code": code or name,
            "description": description,
            "sequenceName": sequence_name,
            "sequenceId": int(sequence_id) if sequence_id and sequence_id > 0 else None,
        }

    if normalized_type == "artist":
        first_name = _local_broker_clean_text(payload.get("firstName") or payload.get("first_name"))
        last_name = _local_broker_clean_text(payload.get("lastName") or payload.get("last_name"))
        login = _local_broker_clean_text(payload.get("login"))
        email = _local_broker_clean_text(payload.get("email"))
        if not first_name:
            raise ValueError("artist firstName is required")
        if not last_name:
            raise ValueError("artist lastName is required")
        if not login:
            raise ValueError("artist login is required")
        if not email:
            raise ValueError("artist email is required")
        return {
            "firstName": first_name,
            "lastName": last_name,
            "login": login,
            "email": email,
            "name": _local_broker_clean_text(payload.get("name")) or f"{first_name} {last_name}".strip(),
        }

    if normalized_type == "department":
        name = _local_broker_clean_text(payload.get("name") or payload.get("code") or payload.get("shortName"))
        short_name = _local_broker_clean_text(payload.get("shortName") or payload.get("short_name"))
        code = _local_broker_clean_text(payload.get("code"))
        if not name:
            raise ValueError("department name is required")
        return {
            "name": name,
            "shortName": short_name,
            "code": code,
        }

    raise ValueError(f"Unsupported entity type: {entity_type}")


def _local_broker_entity_identity_value(entity_type: str, entity: dict[str, Any]) -> str:
    normalized_type = _local_broker_normalize_entity_type(entity_type)
    if not normalized_type:
        return "unknown"
    if normalized_type in ("asset", "shot", "sequence"):
        value = _local_broker_clean_text(entity.get("code") or entity.get("name"))
    elif normalized_type == "artist":
        value = _local_broker_clean_text(entity.get("login") or entity.get("email"))
    else:
        value = _local_broker_clean_text(entity.get("code") or entity.get("shortName") or entity.get("name"))
    token = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return token or "unknown"


def _local_broker_entity_task_id(project_id: int, entity_type: str, entity: dict[str, Any]) -> str:
    normalized_type = _local_broker_normalize_entity_type(entity_type) or "unknown"
    identity = _local_broker_entity_identity_value(normalized_type, entity)
    return f"entity:{normalized_type}:{int(project_id)}:{identity}"


def _local_broker_find_existing_entity(
    auth: dict[str, Any],
    *,
    project_id: int,
    entity_type: str,
    entity: dict[str, Any],
) -> dict[str, Any] | None:
    normalized_type = _local_broker_normalize_entity_type(entity_type)
    if not normalized_type:
        return None
    if normalized_type in ("asset", "shot", "sequence"):
        jsonapi_type = _LOCAL_BROKER_ENTITY_TO_JSONAPI[normalized_type]
        return _sg_find_project_entity_by_identity(
            auth,
            entity_type=jsonapi_type,
            project_id=int(project_id),
            name=_local_broker_clean_text(entity.get("name")),
            code=_local_broker_clean_text(entity.get("code")),
        )
    if normalized_type == "department":
        return _sg_find_step_by_identity(
            auth,
            name=_local_broker_clean_text(entity.get("name")),
            code=_local_broker_clean_text(entity.get("code")),
            short_name=_local_broker_clean_text(entity.get("shortName")),
        )
    if normalized_type == "artist":
        return _sg_find_human_user_by_identity(
            auth,
            login=_local_broker_clean_text(entity.get("login")),
            email=_local_broker_clean_text(entity.get("email")),
        )
    return None


def _local_broker_build_entity_create_payload(
    auth: dict[str, Any],
    *,
    project_id: int,
    entity_type: str,
    entity: dict[str, Any],
) -> tuple[str, dict[str, Any], dict[str, Any] | None]:
    normalized_type = _local_broker_normalize_entity_type(entity_type)
    if not normalized_type:
        raise RuntimeError(f"Unsupported entity type: {entity_type}")

    attributes: dict[str, Any] = {}
    relationships: dict[str, Any] | None = None

    if normalized_type == "asset":
        attributes["code"] = entity["code"]
        if entity.get("description"):
            attributes["description"] = entity["description"]
        relationships = {"project": {"data": {"type": "projects", "id": str(int(project_id))}}}
        return _LOCAL_BROKER_ENTITY_TO_JSONAPI[normalized_type], attributes, relationships

    if normalized_type == "sequence":
        attributes["code"] = entity["code"]
        if entity.get("description"):
            attributes["description"] = entity["description"]
        relationships = {"project": {"data": {"type": "projects", "id": str(int(project_id))}}}
        return _LOCAL_BROKER_ENTITY_TO_JSONAPI[normalized_type], attributes, relationships

    if normalized_type == "shot":
        attributes["code"] = entity["code"]
        if entity.get("description"):
            attributes["description"] = entity["description"]
        relationships = {"project": {"data": {"type": "projects", "id": str(int(project_id))}}}
        sequence = _sg_find_sequence_by_identity(
            auth,
            project_id=int(project_id),
            sequence_id=_coerce_int(entity.get("sequenceId")),
            sequence_name=_local_broker_clean_text(entity.get("sequenceName")),
        )
        if not sequence or not sequence.get("id"):
            raise RuntimeError("Shot sequence was not found in ShotGrid")
        relationships["sg_sequence"] = {"data": {"type": "sequences", "id": str(int(sequence["id"]))}}
        return _LOCAL_BROKER_ENTITY_TO_JSONAPI[normalized_type], attributes, relationships

    if normalized_type == "artist":
        attributes["firstname"] = entity["firstName"]
        attributes["lastname"] = entity["lastName"]
        attributes["login"] = entity["login"]
        attributes["email"] = entity["email"]
        return _LOCAL_BROKER_ENTITY_TO_JSONAPI[normalized_type], attributes, relationships

    if normalized_type == "department":
        attributes["name"] = entity["name"]
        if entity.get("shortName"):
            attributes["short_name"] = entity["shortName"]
        if entity.get("code"):
            attributes["code"] = entity["code"]
        return _LOCAL_BROKER_ENTITY_TO_JSONAPI[normalized_type], attributes, relationships

    raise RuntimeError(f"Unsupported entity type: {entity_type}")


def _local_broker_queue_entity_operation(
    repo_root: Path,
    *,
    project_id: int,
    synthetic_task_id: str,
    payload: dict[str, Any],
    source: str,
    auth_account_id: str | None = None,
    auth_policy: str = "script_only",
    allow_script_fallback: bool = False,
    effective_actor: str = "script",
    fallback_used: bool = False,
):
    _local_broker_initialize(repo_root)
    now = _now_s()
    conn = _local_broker_connect(repo_root)
    try:
        payload_json = json.dumps(payload, ensure_ascii=False)
        conn.execute(
            """
            DELETE FROM local_sync_queue
            WHERE project_id = ? AND task_id = ? AND status IN ('pending', 'failed')
            """,
            (int(project_id), str(synthetic_task_id)),
        )
        conn.execute(
            """
            INSERT INTO local_sync_queue(
                project_id, task_id, sg_task_id, auth_account_id, auth_policy, allow_script_fallback, effective_actor, fallback_used,
                op_type, payload_json, source, status, attempts, next_attempt_at, last_error, created_at, updated_at
            )
            VALUES(?, ?, NULL, ?, ?, ?, ?, ?, 'entity_create', ?, ?, 'pending', 0, 0, NULL, ?, ?)
            """,
            (
                int(project_id),
                str(synthetic_task_id),
                str(auth_account_id or "").strip() or None,
                _normalize_auth_policy(auth_policy, default="script_only"),
                1 if allow_script_fallback else 0,
                str(effective_actor or "none"),
                1 if fallback_used else 0,
                payload_json,
                source,
                now,
                now,
            ),
        )
    finally:
        conn.close()
    _LOCAL_BROKER_WAKE_EVENT.set()


def _local_broker_db_path(repo_root: Path) -> Path:
    global _LOCAL_BROKER_DB_PATH
    if _LOCAL_BROKER_DB_PATH is None:
        _LOCAL_BROKER_DB_PATH = _runtime_data_root(repo_root) / ".local_sync_broker.sqlite3"
    return _LOCAL_BROKER_DB_PATH


def _sql_quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _local_broker_auto_encryption_enabled() -> bool:
    return _parse_bool(_env("LOCAL_BROKER_AUTO_ENCRYPTION", default="1"))


def _local_broker_auto_migrate_plaintext_enabled() -> bool:
    return _parse_bool(_env("LOCAL_BROKER_AUTO_MIGRATE_PLAINTEXT", default="1"))


def _local_broker_encryption_required() -> bool:
    return _parse_bool(_env("LOCAL_BROKER_ENCRYPTION_REQUIRED"))


def _local_broker_default_managed_key_dir(repo_root: Path | None = None) -> Path:
    if _env("UTS_DATA_DIR"):
        return _runtime_data_root(repo_root or _runtime_app_root())
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "UP_TO_SPEED"
    if os.name == "nt":
        appdata = os.getenv("APPDATA")
        if appdata and appdata.strip():
            return Path(appdata) / "UP_TO_SPEED"
        return Path.home() / "AppData" / "Roaming" / "UP_TO_SPEED"
    return Path.home() / ".config" / "uptospeed"


def _local_broker_resolve_path(repo_root: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = (_runtime_config_root(repo_root) / path).resolve()
    return path


def _local_broker_managed_key_path(repo_root: Path) -> Path:
    key_file = _env("LOCAL_BROKER_MANAGED_KEY_FILE")
    if key_file:
        return _local_broker_resolve_path(repo_root, key_file)
    key_dir = _env("LOCAL_BROKER_MANAGED_KEY_DIR")
    if key_dir:
        return _local_broker_resolve_path(repo_root, key_dir) / _LOCAL_BROKER_MANAGED_KEY_FILENAME
    return _local_broker_default_managed_key_dir(repo_root) / _LOCAL_BROKER_MANAGED_KEY_FILENAME


def _local_broker_try_chmod(path: Path, mode: int):
    try:
        os.chmod(path, mode)
    except Exception:
        return


def _local_broker_read_key_file(path: Path, *, label: str) -> str:
    if not path.exists():
        raise ValueError(f"{label} does not exist: {path}")
    key = path.read_text(encoding="utf-8").rstrip("\r\n")
    if not key:
        raise ValueError(f"{label} is empty: {path}")
    return key


def _local_broker_get_or_create_managed_key(repo_root: Path) -> str:
    key_path = _local_broker_managed_key_path(repo_root)

    if key_path.exists():
        _local_broker_try_chmod(key_path, 0o600)
        return _local_broker_read_key_file(key_path, label="Managed local broker key file")

    try:
        key_path.parent.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise RuntimeError(f"Failed to create managed key directory: {key_path.parent}") from exc

    _local_broker_try_chmod(key_path.parent, 0o700)
    key = secrets.token_hex(32)
    try:
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        _local_broker_try_chmod(key_path, 0o600)
        return _local_broker_read_key_file(key_path, label="Managed local broker key file")
    except Exception as exc:
        raise RuntimeError(f"Failed to create managed key file: {key_path}") from exc

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(key)
    except Exception as exc:
        try:
            key_path.unlink()
        except Exception:
            pass
        raise RuntimeError(f"Failed to write managed key file: {key_path}") from exc

    _local_broker_try_chmod(key_path, 0o600)
    _log(f"[local-broker] Generated managed SQLCipher key: {key_path}")
    return key


def _local_broker_encryption_key_from_file(repo_root: Path) -> str | None:
    key_file = _env("LOCAL_BROKER_ENCRYPTION_KEY_FILE")
    if not key_file:
        return None
    path = _local_broker_resolve_path(repo_root, key_file)
    return _local_broker_read_key_file(path, label="LOCAL_BROKER_ENCRYPTION_KEY_FILE")


def _local_broker_load_encryption_key(repo_root: Path) -> tuple[str | None, str]:
    direct_key = _env("LOCAL_BROKER_ENCRYPTION_KEY")
    if direct_key is not None:
        return direct_key, "env"
    from_file = _local_broker_encryption_key_from_file(repo_root)
    if from_file is not None:
        return from_file, "file"
    if _local_broker_auto_encryption_enabled():
        return _local_broker_get_or_create_managed_key(repo_root), "managed"
    return None, "none"


def _local_broker_load_sqlcipher_module() -> Any:
    try:
        from pysqlcipher3 import dbapi2 as sqlcipher_module

        return sqlcipher_module
    except Exception:
        pass
    try:
        return importlib.import_module("sqlcipher3")
    except Exception as exc:
        raise RuntimeError(
            "Local broker encryption requires SQLCipher. Install dependency: "
            "python3 -m pip install sqlcipher3 (or pysqlcipher3-binary)"
        ) from exc


def _local_broker_apply_sqlcipher_key(conn: Any, key: str):
    conn.execute(f"PRAGMA key = {_sql_quote_literal(key)}")
    try:
        conn.execute("PRAGMA cipher_memory_security = ON")
    except Exception:
        pass


def _local_broker_probe_connection(conn: Any):
    conn.execute("SELECT count(*) AS c FROM sqlite_master").fetchone()


def _local_broker_remove_sidecars(path: Path):
    for suffix in ("-wal", "-shm"):
        sidecar = Path(f"{path}{suffix}")
        try:
            sidecar.unlink()
        except FileNotFoundError:
            continue
        except Exception:
            continue


def _local_broker_try_encrypted_probe(path: Path, key: str, sqlite_module: Any):
    conn = sqlite_module.connect(path, timeout=30, isolation_level=None)
    try:
        _local_broker_apply_sqlcipher_key(conn, key)
        _local_broker_probe_connection(conn)
    finally:
        conn.close()


def _local_broker_migrate_plaintext_database(path: Path, key: str, sqlite_module: Any):
    ts = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    backup_path = path.with_name(f"{path.name}.plaintext-backup-{ts}")
    temp_path = path.with_name(f"{path.name}.encrypted-tmp-{os.getpid()}-{int(time.time() * 1000)}")
    checkpoint_conn = None
    migrate_conn = None
    migrated = False
    try:
        checkpoint_conn = sqlite3.connect(path, timeout=30, isolation_level=None)
        _local_broker_probe_connection(checkpoint_conn)
        try:
            checkpoint_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:
            pass
        checkpoint_conn.close()
        checkpoint_conn = None

        migrate_conn = sqlite_module.connect(path, timeout=30, isolation_level=None)
        migrate_conn.execute("ATTACH DATABASE ? AS encrypted KEY ?", (str(temp_path), key))
        migrate_conn.execute("SELECT sqlcipher_export('encrypted')")
        migrate_conn.execute("DETACH DATABASE encrypted")
        migrate_conn.close()
        migrate_conn = None

        _local_broker_try_encrypted_probe(temp_path, key, sqlite_module)

        _local_broker_remove_sidecars(path)

        shutil.copy2(path, backup_path)
        os.replace(temp_path, path)
        migrated = True
        _log(f"[local-broker] Migrated plaintext DB to SQLCipher: {path} (backup: {backup_path})")
    except Exception as exc:
        raise RuntimeError(
            "Failed to migrate local broker DB from plaintext to encrypted format. "
            "If this DB is already encrypted, verify LOCAL_BROKER_ENCRYPTION_KEY."
        ) from exc
    finally:
        if migrate_conn is not None:
            migrate_conn.close()
        if checkpoint_conn is not None:
            checkpoint_conn.close()
        if not migrated:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass
            except Exception:
                pass


def _local_broker_configure_sqlite(repo_root: Path):
    global _LOCAL_BROKER_ENCRYPTION_CONFIGURED
    global _LOCAL_BROKER_SQLITE_MODULE
    global _LOCAL_BROKER_ENCRYPTION_KEY
    global _LOCAL_BROKER_ENCRYPTION_MODE
    global _LOCAL_BROKER_ENCRYPTION_KEY_SOURCE

    if _LOCAL_BROKER_ENCRYPTION_CONFIGURED:
        return

    with _LOCAL_BROKER_CONFIG_LOCK:
        if _LOCAL_BROKER_ENCRYPTION_CONFIGURED:
            return

        key, key_source = _local_broker_load_encryption_key(repo_root)
        if not key:
            if _local_broker_encryption_required():
                raise RuntimeError(
                    "LOCAL_BROKER_ENCRYPTION_REQUIRED is enabled but no encryption key is set. "
                    "Set LOCAL_BROKER_ENCRYPTION_KEY or LOCAL_BROKER_ENCRYPTION_KEY_FILE."
                )
            _LOCAL_BROKER_SQLITE_MODULE = sqlite3
            _LOCAL_BROKER_ENCRYPTION_KEY = None
            _LOCAL_BROKER_ENCRYPTION_MODE = "plaintext"
            _LOCAL_BROKER_ENCRYPTION_KEY_SOURCE = "none"
            _LOCAL_BROKER_ENCRYPTION_CONFIGURED = True
            return

        sqlite_module = _local_broker_load_sqlcipher_module()
        path = _local_broker_db_path(repo_root)

        if path.exists() and path.stat().st_size > 0:
            try:
                _local_broker_try_encrypted_probe(path, key, sqlite_module)
            except Exception as probe_exc:
                if not _local_broker_auto_migrate_plaintext_enabled():
                    raise RuntimeError(
                        "Existing local broker DB cannot be opened with the provided encryption key. "
                        "Set LOCAL_BROKER_AUTO_MIGRATE_PLAINTEXT=1 to migrate plaintext DBs, "
                        "or verify LOCAL_BROKER_ENCRYPTION_KEY if the DB is already encrypted."
                    ) from probe_exc
                _local_broker_migrate_plaintext_database(path, key, sqlite_module)

        _LOCAL_BROKER_SQLITE_MODULE = sqlite_module
        _LOCAL_BROKER_ENCRYPTION_KEY = key
        _LOCAL_BROKER_ENCRYPTION_MODE = "sqlcipher"
        _LOCAL_BROKER_ENCRYPTION_KEY_SOURCE = key_source
        _LOCAL_BROKER_ENCRYPTION_CONFIGURED = True


def _local_broker_encryption_status() -> dict[str, Any]:
    return {
        "enabled": _LOCAL_BROKER_ENCRYPTION_MODE == "sqlcipher",
        "mode": _LOCAL_BROKER_ENCRYPTION_MODE,
        "key_source": _LOCAL_BROKER_ENCRYPTION_KEY_SOURCE,
    }


def _local_broker_connect(repo_root: Path) -> sqlite3.Connection:
    _local_broker_configure_sqlite(repo_root)
    path = _local_broker_db_path(repo_root)
    conn = _LOCAL_BROKER_SQLITE_MODULE.connect(path, timeout=30, isolation_level=None)
    try:
        if _LOCAL_BROKER_ENCRYPTION_KEY:
            _local_broker_apply_sqlcipher_key(conn, _LOCAL_BROKER_ENCRYPTION_KEY)
            _local_broker_probe_connection(conn)
        conn.row_factory = getattr(_LOCAL_BROKER_SQLITE_MODULE, "Row", sqlite3.Row)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA foreign_keys=ON")
    except Exception:
        conn.close()
        raise
    return conn


def _local_broker_table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    names: set[str] = set()
    for row in rows:
        try:
            if isinstance(row, dict) or hasattr(row, "keys"):
                name = str(row["name"]).strip()
            else:
                name = str(row[1]).strip()
        except Exception:
            continue
        if name:
            names.add(name)
    return names


def _local_broker_ensure_column(conn: sqlite3.Connection, table_name: str, column_name: str, ddl: str):
    columns = _local_broker_table_columns(conn, table_name)
    if column_name in columns:
        return
    conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {ddl}")


def _local_broker_apply_schema_migrations(conn: sqlite3.Connection):
    _local_broker_ensure_column(conn, "local_sync_queue", "auth_account_id", "TEXT")
    _local_broker_ensure_column(conn, "local_sync_queue", "auth_policy", "TEXT NOT NULL DEFAULT 'script_only'")
    _local_broker_ensure_column(conn, "local_sync_queue", "allow_script_fallback", "INTEGER NOT NULL DEFAULT 0")
    _local_broker_ensure_column(conn, "local_sync_queue", "effective_actor", "TEXT NOT NULL DEFAULT 'script'")
    _local_broker_ensure_column(conn, "local_sync_queue", "fallback_used", "INTEGER NOT NULL DEFAULT 0")
    _local_broker_ensure_column(conn, "local_task_overrides", "auth_account_id", "TEXT")
    _local_broker_ensure_column(conn, "agent_connections", "provider_id", "TEXT")
    _local_broker_ensure_column(conn, "agent_connections", "profile_label", "TEXT")
    _local_broker_ensure_column(conn, "agent_profiles", "name", "TEXT")
    _local_broker_ensure_column(conn, "agent_profiles", "role", "TEXT")
    _local_broker_ensure_column(conn, "agent_profiles", "provider_id", "TEXT")
    _local_broker_ensure_column(conn, "agent_profiles", "default_model_ref", "TEXT")
    _local_broker_ensure_column(conn, "agent_profiles", "default_project_scope", "TEXT")
    _local_broker_ensure_column(conn, "agent_profiles", "description", "TEXT")
    _local_broker_ensure_column(conn, "agent_profiles", "active", "INTEGER NOT NULL DEFAULT 1")
    _local_broker_ensure_column(conn, "agent_threads", "provider_id", "TEXT")
    _local_broker_ensure_column(conn, "agent_threads", "model_ref", "TEXT")
    _local_broker_ensure_column(conn, "agent_runs", "provider_id", "TEXT")
    _local_broker_ensure_column(conn, "agent_runs", "model_ref", "TEXT")
    _local_broker_ensure_column(conn, "agent_runs", "agent_profile_id", "TEXT")
    _local_broker_ensure_column(conn, "agent_runs", "auth_profile_id", "TEXT")
    _local_broker_ensure_column(conn, "agent_runs", "worker_id", "TEXT")
    _local_broker_ensure_column(conn, "agent_runs", "heartbeat_at", "REAL")
    _local_broker_ensure_column(conn, "agent_runs", "lease_expires_at", "REAL")
    _local_broker_ensure_column(conn, "agent_runs", "cancel_requested_at", "REAL")
    _local_broker_ensure_column(conn, "agent_runs", "interrupted_reason", "TEXT")
    _local_broker_ensure_column(conn, "agent_trust_rules", "permission", "TEXT NOT NULL DEFAULT 'trust'")
    profile_columns = _local_broker_table_columns(conn, "agent_profiles")
    legacy_display_name = "display_name" if "display_name" in profile_columns else "''"
    legacy_provider = "provider" if "provider" in profile_columns else "''"
    legacy_model = "model" if "model" in profile_columns else "''"
    conn.execute(
        f"""
        UPDATE agent_profiles
        SET
            name = COALESCE(NULLIF(name, ''), {legacy_display_name}, {legacy_provider}, id),
            role = COALESCE(NULLIF(role, ''), ?),
            provider_id = COALESCE(NULLIF(provider_id, ''), {legacy_provider}, 'codex'),
            default_model_ref = COALESCE(NULLIF(default_model_ref, ''), {legacy_model}),
            default_project_scope = COALESCE(NULLIF(default_project_scope, ''), 'global'),
            description = COALESCE(description, ''),
            active = COALESCE(active, 1)
        """,
        (_AGENT_DEFAULT_PROFILE_ROLE,),
    )


def _agent_now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _agent_new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _agent_json_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _agent_json_loads(raw: Any, fallback: Any):
    if raw is None:
        return fallback
    text = str(raw).strip()
    if not text:
        return fallback
    try:
        parsed = json.loads(text)
    except Exception:
        return fallback
    return parsed


def _agent_truncate_text(value: Any, *, limit: int = 2000) -> tuple[str, bool]:
    text = str(value or "").replace("\x00", "")
    if not text:
        return "", False
    if len(text) <= limit:
        return text, False
    clipped = text[: max(0, limit - 1)].rstrip()
    return f"{clipped}…", True


def _agent_row_to_dict(row: Any) -> dict[str, Any]:
    if row is None:
        return {}
    try:
        if isinstance(row, dict):
            return dict(row)
        return dict(row)
    except Exception:
        return {}


def _agent_normalize_provider(value: Any) -> str:
    provider = str(value or "").strip().lower()
    if not provider:
        return ""
    provider = _AGENT_PROVIDER_ALIASES.get(provider, provider)
    return provider if provider in _AGENT_PROVIDER_VALUES else ""


def _agent_provider_title(provider: str) -> str:
    normalized = _agent_normalize_provider(provider)
    if normalized == "codex":
        return "Codex"
    if normalized == "openai":
        return "OpenAI"
    if normalized == "anthropic":
        return "Anthropic"
    if normalized == "gemini":
        return "Gemini"
    return normalized or str(provider or "")


def _agent_provider_auth_modes(provider: str) -> list[dict[str, Any]]:
    normalized = _agent_normalize_provider(provider)
    if normalized == "codex":
        return [
            {
                "id": "codex_cli",
                "label": "Codex OAuth",
                "type": "oauth",
                "placeholder": "",
                "supports_test": True,
                "supports_secret": False,
            },
            {
                "id": "openai_key",
                "label": "OpenAI API key",
                "type": "api_key",
                "placeholder": "OpenAI API key",
                "supports_test": True,
                "supports_secret": True,
            },
        ]
    if normalized == "openai":
        return [
            {
                "id": "openai_key",
                "label": "OpenAI API key",
                "type": "api_key",
                "placeholder": "OpenAI API key",
                "supports_test": True,
                "supports_secret": True,
            }
        ]
    if normalized == "anthropic":
        return [
            {
                "id": "anthropic_key",
                "label": "Anthropic API key",
                "type": "api_key",
                "placeholder": "Anthropic API key",
                "supports_test": True,
                "supports_secret": True,
            }
        ]
    if normalized == "gemini":
        return [
            {
                "id": "gemini_key",
                "label": "Google AI API key",
                "type": "api_key",
                "placeholder": "Google AI API key",
                "supports_test": True,
                "supports_secret": True,
            }
        ]
    return []


def _agent_provider_aliases(provider: str) -> list[str]:
    normalized = _agent_normalize_provider(provider)
    if normalized == "anthropic":
        return ["claude"]
    return []


def _agent_provider_logo_path(provider: str) -> str | None:
    normalized = _agent_normalize_provider(provider)
    if normalized in {"codex", "openai"}:
        return "assets/branding/openai-codex-logo.png"
    if normalized == "anthropic":
        return "assets/branding/claude-logo.svg"
    return None


def _agent_provider_capabilities(provider: str) -> dict[str, Any]:
    normalized = _agent_normalize_provider(provider)
    return {
        "structured_output_mode": "json_object_text",
        "supports_reasoning_effort": normalized in {"codex", "openai", "anthropic", "gemini"},
        "supports_fallback": True,
        "supports_tool_planning": True,
        "supports_oauth": normalized == "codex",
        "supports_model_discovery": normalized in {"codex", "openai", "anthropic", "gemini"},
    }


def _agent_model_ref(provider: str, model_name: str) -> str:
    normalized_provider = _agent_normalize_provider(provider)
    model_id = str(model_name or "").strip()
    if not normalized_provider:
        return ""
    if not model_id:
        model_id = "default"
    return f"{normalized_provider}/{model_id}"


def _agent_split_model_ref(model_ref: Any) -> tuple[str, str]:
    raw = str(model_ref or "").strip()
    if "/" not in raw:
        provider = _agent_normalize_provider(raw)
        if not provider:
            return "", ""
        return provider, "default"
    provider_raw, model_id = raw.split("/", 1)
    provider = _agent_normalize_provider(provider_raw)
    return provider, str(model_id or "").strip()


def _agent_builtin_default_model_ids() -> dict[str, str]:
    codex_model = str(_env("UTS_AGENT_CODEX_CLI_MODEL", default="") or "").strip() or "default"
    openai_model = str(_env("UTS_AGENT_OPENAI_MODEL", default="gpt-4o-mini") or "gpt-4o-mini").strip() or "gpt-4o-mini"
    anthropic_model = str(
        _env("UTS_AGENT_ANTHROPIC_MODEL", default="claude-3-5-sonnet-20241022")
        or "claude-3-5-sonnet-20241022"
    ).strip() or "claude-3-5-sonnet-20241022"
    gemini_model = str(_env("UTS_AGENT_GEMINI_MODEL", default="gemini-2.0-flash") or "gemini-2.0-flash").strip() or "gemini-2.0-flash"
    return {
        "codex": codex_model,
        "openai": openai_model,
        "anthropic": anthropic_model,
        "gemini": gemini_model,
    }


def _agent_default_model_ref_for_provider(provider: Any) -> str:
    normalized = _agent_normalize_provider(provider)
    defaults = _agent_builtin_default_model_ids()
    return _agent_model_ref(normalized or "codex", defaults.get(normalized or "codex", "default"))


def _agent_builtin_models() -> dict[str, dict[str, Any]]:
    defaults = _agent_builtin_default_model_ids()
    rows = [
        {
            "model_ref": _agent_model_ref("codex", defaults["codex"]),
            "provider_id": "codex",
            "model_id": defaults["codex"],
            "label": "Codex Default" if defaults["codex"] == "default" else defaults["codex"],
            "description": "Codex adapter model selection",
        },
        {
            "model_ref": _agent_model_ref("openai", defaults["openai"]),
            "provider_id": "openai",
            "model_id": defaults["openai"],
            "label": defaults["openai"],
            "description": "Default OpenAI API model",
        },
        {
            "model_ref": _agent_model_ref("anthropic", defaults["anthropic"]),
            "provider_id": "anthropic",
            "model_id": defaults["anthropic"],
            "label": defaults["anthropic"],
            "description": "Default Anthropic model",
        },
        {
            "model_ref": _agent_model_ref("gemini", defaults["gemini"]),
            "provider_id": "gemini",
            "model_id": defaults["gemini"],
            "label": defaults["gemini"],
            "description": "Default Gemini model",
        },
    ]
    catalog: dict[str, dict[str, Any]] = {}
    for row in rows:
        model_ref = str(row.get("model_ref") or "").strip()
        if not model_ref:
            continue
        catalog[model_ref] = {
            **row,
            "capabilities": _agent_provider_capabilities(str(row.get("provider_id") or "")),
            "source": "builtin",
        }
    return catalog


def _agent_normalize_model_ref(value: Any, *, fallback_provider: str | None = None) -> str:
    raw = str(value or "").strip()
    if not raw:
        if fallback_provider:
            return _agent_default_model_ref_for_provider(fallback_provider)
        return ""
    provider_id, model_id = _agent_split_model_ref(raw)
    if provider_id and model_id:
        return _agent_model_ref(provider_id, model_id)
    normalized_provider = _agent_normalize_provider(raw)
    if normalized_provider:
        return _agent_default_model_ref_for_provider(normalized_provider)
    return ""


def _agent_normalize_model_entry(model_ref: str, raw: Any) -> dict[str, Any]:
    builtin = _agent_builtin_models().get(model_ref, {})
    source = raw if isinstance(raw, dict) else {}
    provider_id, model_id = _agent_split_model_ref(model_ref)
    source_capabilities = source.get("capabilities") if isinstance(source.get("capabilities"), dict) else None
    entry = {
        "model_ref": model_ref,
        "provider_id": provider_id,
        "model_id": model_id or "default",
        "label": str(source.get("label") or builtin.get("label") or model_id or model_ref),
        "description": str(source.get("description") or builtin.get("description") or "").strip(),
        "capabilities": source_capabilities or builtin.get("capabilities") or _agent_provider_capabilities(provider_id),
        "source": str(source.get("source") or builtin.get("source") or "config"),
        "enabled": source.get("enabled") is not False,
    }
    if source.get("is_default") is True:
        entry["is_default"] = True
    metadata = source.get("metadata")
    if isinstance(metadata, dict) and metadata:
        entry["metadata"] = metadata
    return entry


def _agent_normalize_model_catalog(
    raw_models: Any,
    *,
    discovered_models: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    catalog = _agent_builtin_models()
    if isinstance(discovered_models, dict):
        for model_ref_raw, raw_entry in discovered_models.items():
            model_ref = _agent_normalize_model_ref(model_ref_raw)
            if not model_ref:
                continue
            catalog[model_ref] = _agent_normalize_model_entry(model_ref, raw_entry)
    if not isinstance(raw_models, dict):
        return catalog
    for model_ref_raw, raw_entry in raw_models.items():
        model_ref = _agent_normalize_model_ref(model_ref_raw)
        if not model_ref:
            continue
        catalog[model_ref] = _agent_normalize_model_entry(model_ref, raw_entry)
    return catalog


def _agent_normalize_user_id(value: Any) -> str:
    token = str(value or "").strip()
    if token:
        return token
    return "local-user"


def _agent_normalize_project_scope(value: Any) -> str:
    token = str(value or "").strip()
    if token:
        return token
    return "global"


def _agent_default_config() -> dict[str, Any]:
    return _agent_json_loads(_agent_json_dumps(_AGENT_DEFAULT_CONFIG), {})


def _agent_merge_config(existing: dict[str, Any] | None, updates: dict[str, Any] | None) -> dict[str, Any]:
    merged = _agent_default_config()
    if isinstance(existing, dict):
        merged.update(existing)
    if isinstance(updates, dict):
        merged.update(updates)
    merged["enableStreaming"] = merged.get("enableStreaming") is not False
    merged["strictSafetyLimits"] = merged.get("strictSafetyLimits") is not False
    merged["autoRunMentions"] = merged.get("autoRunMentions") is not False
    merged["backgroundSupervisorEnabled"] = merged.get("backgroundSupervisorEnabled") is not False
    merged["backgroundSupervisorProfileId"] = str(merged.get("backgroundSupervisorProfileId") or "").strip()
    try:
        background_interval = int(merged.get("backgroundSupervisorIntervalMinutes"))
    except Exception:
        background_interval = int(_AGENT_DEFAULT_CONFIG["backgroundSupervisorIntervalMinutes"])
    merged["backgroundSupervisorIntervalMinutes"] = max(5, min(240, background_interval))
    catalog = _agent_normalize_model_catalog(merged.get("models"))
    merged["models"] = catalog

    legacy_default_by_project = merged.get("defaultAgentByProject")
    default_model_by_project = merged.get("defaultModelByProject")
    if not isinstance(default_model_by_project, dict):
        default_model_by_project = {}
    if isinstance(legacy_default_by_project, dict):
        for key, provider_id in legacy_default_by_project.items():
            scope = str(key or "").strip()
            if not scope or scope in default_model_by_project:
                continue
            default_model_by_project[scope] = _agent_default_model_ref_for_provider(provider_id)

    merged["defaultModel"] = _agent_normalize_model_ref(merged.get("defaultModel")) or _agent_default_model_ref_for_provider("codex")
    merged["defaultModelByProject"] = {
        str(k): (
            _agent_normalize_model_ref(v)
            or _agent_normalize_model_ref(merged["defaultModel"])
            or _agent_default_model_ref_for_provider("codex")
        )
        for k, v in default_model_by_project.items()
        if str(k).strip()
    }
    fallbacks_raw = merged.get("fallbacks")
    fallbacks: list[str] = []
    if isinstance(fallbacks_raw, list):
        for item in fallbacks_raw:
            model_ref = _agent_normalize_model_ref(item)
            if not model_ref or model_ref == merged["defaultModel"] or model_ref in fallbacks:
                continue
            fallbacks.append(model_ref)
    merged["fallbacks"] = fallbacks
    for key, lower, upper in (
        ("maxActionsPerRun", 1, 128),
        ("maxToolCallsPerRun", 1, 256),
        ("maxRetriesPerRun", 0, 8),
        ("toolTimeoutMs", 1000, 120000),
    ):
        try:
            value = int(merged.get(key))
        except Exception:
            value = int(_AGENT_DEFAULT_CONFIG[key])
        merged[key] = max(lower, min(upper, value))
    return merged


def _agent_encode_secret(secret: str) -> str:
    raw = str(secret or "").encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


def _agent_decode_secret(encoded: Any) -> str:
    raw = str(encoded or "").strip()
    if not raw:
        return ""
    try:
        return base64.b64decode(raw.encode("ascii"), validate=True).decode("utf-8")
    except Exception:
        return ""


def _agent_mask_secret(secret: Any) -> str:
    value = str(secret or "").strip()
    if len(value) <= 6:
        return "*" * len(value)
    return f"{value[:4]}{'*' * max(0, len(value) - 6)}{value[-2:]}"


def _agent_gateway_host() -> str:
    return str(_env("UTS_AGENT_GATEWAY_HOST", default="127.0.0.1") or "127.0.0.1").strip() or "127.0.0.1"


def _agent_gateway_port() -> int:
    try:
        return max(1, min(65535, int(_env("UTS_AGENT_GATEWAY_PORT", default="7340") or "7340")))
    except Exception:
        return 7340


def _agent_gateway_token() -> str:
    token = str(_env("UTS_AGENT_GATEWAY_TOKEN", default="") or "").strip()
    return token or "uptospeed-agent-gateway-dev-token"


def _agent_gateway_url(path: str) -> str:
    p = str(path or "/").strip() or "/"
    if not p.startswith("/"):
        p = "/" + p
    return f"http://{_agent_gateway_host()}:{_agent_gateway_port()}{p}"


def _agent_http_json(
    *,
    url: str,
    method: str = "GET",
    payload: Any = None,
    headers: dict[str, str] | None = None,
    timeout_s: float = 20.0,
) -> tuple[bool, int, dict[str, Any], str]:
    body = None
    req_headers = {"Content-Type": "application/json"}
    if isinstance(headers, dict):
        req_headers.update({str(k): str(v) for k, v in headers.items()})
    if payload is not None:
        body = _agent_json_dumps(payload).encode("utf-8")
    req = Request(url, data=body, method=method.upper())
    for key, value in req_headers.items():
        req.add_header(key, value)
    try:
        with urlopen(req, timeout=max(1.0, float(timeout_s))) as res:
            raw = res.read().decode("utf-8", errors="replace")
            parsed = _agent_json_loads(raw, {})
            if not isinstance(parsed, dict):
                parsed = {}
            return True, int(res.status), parsed, raw
    except HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", errors="replace")
        except Exception:
            raw = ""
        parsed = _agent_json_loads(raw, {})
        if not isinstance(parsed, dict):
            parsed = {}
        return False, int(exc.code or 0), parsed, raw
    except URLError as exc:
        return False, 0, {}, str(exc)
    except Exception as exc:
        return False, 0, {}, str(exc)


def _agent_gateway_health() -> dict[str, Any]:
    ok, status, parsed, raw = _agent_http_json(
        url=_agent_gateway_url("/health"),
        method="GET",
        headers={"x-uts-agent-token": _agent_gateway_token()},
        timeout_s=5.0,
    )
    payload = parsed if isinstance(parsed, dict) else {}
    return {
        "ok": ok and status == 200 and payload.get("ok") is True,
        "status": status,
        "payload": payload,
        "error": "" if ok else (payload.get("error") or raw or "Gateway unavailable"),
    }


def _agent_gateway_manifest() -> dict[str, Any]:
    ok, status, parsed, raw = _agent_http_json(
        url=_agent_gateway_url("/manifest"),
        method="GET",
        headers={"x-uts-agent-token": _agent_gateway_token()},
        timeout_s=5.0,
    )
    payload = parsed if isinstance(parsed, dict) else {}
    tools = payload.get("tools")
    return {
        "ok": ok and status == 200 and payload.get("ok") is True and isinstance(tools, list),
        "status": status,
        "tools": tools if isinstance(tools, list) else [],
        "error": "" if ok else (payload.get("error") or raw or "Manifest unavailable"),
    }


def _agent_gateway_invoke(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "toolName": str(tool_name or "").strip(),
        "args": args if isinstance(args, dict) else {},
    }
    ok, status, parsed, raw = _agent_http_json(
        url=_agent_gateway_url("/invoke"),
        method="POST",
        payload=payload,
        headers={"x-uts-agent-token": _agent_gateway_token()},
        timeout_s=30.0,
    )
    body = parsed if isinstance(parsed, dict) else {}
    return {
        "ok": ok and status == 200 and body.get("ok") is True,
        "status": status,
        "payload": body.get("payload"),
        "error": body.get("error") or ("" if ok else raw or "invoke_failed"),
    }


def _agent_strip_ansi(text: str) -> str:
    raw = str(text or "")
    cleaned = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", raw)
    cleaned = cleaned.replace("\b", "")
    return cleaned


def _agent_codex_cli_path() -> str:
    return str(shutil.which("codex") or "").strip()


def _agent_codex_cli_available() -> tuple[bool, str]:
    path = _agent_codex_cli_path()
    if path:
        return True, path
    return (
        False,
        "Codex CLI is not installed. Install it and run `codex login` first, or use OpenAI API key fallback.",
    )


def _agent_codex_parse_error_message(raw: str) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    parsed = _agent_json_loads(text, {})
    if isinstance(parsed, dict):
        detail = str(parsed.get("detail") or parsed.get("message") or parsed.get("error") or "").strip()
        if detail:
            return detail
    return text


def _agent_codex_exec_error(stdout_text: str, stderr_text: str, fallback: str = "") -> str:
    candidates: list[str] = []
    for raw_line in f"{stdout_text}\n{stderr_text}".splitlines():
        line = _agent_strip_ansi(raw_line).strip()
        if not line:
            continue
        if line.startswith("{") and line.endswith("}"):
            event = _agent_json_loads(line, {})
            if isinstance(event, dict):
                event_type = str(event.get("type") or "").strip()
                if event_type == "error":
                    message = _agent_codex_parse_error_message(str(event.get("message") or ""))
                    if message:
                        candidates.append(message)
                if event_type == "turn.failed":
                    err = event.get("error")
                    if isinstance(err, dict):
                        message = _agent_codex_parse_error_message(str(err.get("message") or ""))
                        if message:
                            candidates.append(message)
            continue
        if "ERROR:" in line:
            message = _agent_codex_parse_error_message(line.split("ERROR:", 1)[1])
            if message:
                candidates.append(message)
            continue
        if "model" in line.lower() and "not supported" in line.lower():
            candidates.append(line)
            continue
    if candidates:
        return candidates[-1]
    return str(fallback or "").strip()


def _agent_codex_login_status() -> dict[str, Any]:
    ok_path, path_or_error = _agent_codex_cli_available()
    if not ok_path:
        return {
            "ok": False,
            "logged_in": False,
            "output": "",
            "error": path_or_error,
            "cli_path": "",
        }
    try:
        result = subprocess.run(
            [path_or_error, "login", "status"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        output = _agent_strip_ansi(result.stdout or result.stderr or "").strip()
        logged_in = bool(re.search(r"\blogged in\b", output, flags=re.IGNORECASE))
        return {
            "ok": result.returncode == 0,
            "logged_in": logged_in,
            "output": output,
            "error": "" if result.returncode == 0 else (output or f"exit {result.returncode}"),
            "cli_path": path_or_error,
        }
    except Exception as exc:
        return {"ok": False, "logged_in": False, "output": "", "error": str(exc), "cli_path": ""}


def _agent_codex_cli_version() -> str:
    ok_path, path_or_error = _agent_codex_cli_available()
    if not ok_path:
        return ""
    try:
        result = subprocess.run(
            [path_or_error, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        output = _agent_strip_ansi(result.stdout or result.stderr or "").strip()
        if result.returncode != 0:
            return ""
        return output
    except Exception:
        return ""


def _agent_codex_login_snapshot() -> dict[str, Any]:
    with _AGENT_CODEX_LOGIN_LOCK:
        return dict(_AGENT_CODEX_LOGIN_STATE)


def _agent_codex_login_state_update(patch: dict[str, Any]):
    with _AGENT_CODEX_LOGIN_LOCK:
        _AGENT_CODEX_LOGIN_STATE.update(patch)
        _AGENT_CODEX_LOGIN_STATE["updated_at"] = _agent_now_iso()


def _agent_codex_parse_device_auth_line(line: str):
    cleaned = _agent_strip_ansi(line)
    if not cleaned:
        return
    url_match = re.search(r"https://auth\.openai\.com/[^\s]+", cleaned)
    if url_match:
        _agent_codex_login_state_update({"url": url_match.group(0).strip()})
    code_match = re.search(r"\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b", cleaned)
    if code_match:
        _agent_codex_login_state_update({"code": code_match.group(1).strip()})


def _agent_codex_device_auth_worker(repo_root: Path):
    _agent_codex_login_state_update(
        {
            "running": True,
            "url": "",
            "code": "",
            "error": "",
            "exit_code": None,
            "started_at": _agent_now_iso(),
            "finished_at": "",
        }
    )
    process: subprocess.Popen[str] | None = None
    try:
        ok_path, path_or_error = _agent_codex_cli_available()
        if not ok_path:
            raise RuntimeError(path_or_error)
        # Use `script` to allocate a pseudo-TTY because `codex login --device-auth`
        # is interactive and otherwise does not emit the device URL/code.
        process = subprocess.Popen(
            ["script", "-q", "/dev/null", path_or_error, "login", "--device-auth"],
            cwd=str(repo_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        if process.stdout is not None:
            for line in process.stdout:
                _agent_codex_parse_device_auth_line(line)
        exit_code = process.wait(timeout=1200)
        status = _agent_codex_login_status()
        _agent_codex_login_state_update(
            {
                "running": False,
                "finished_at": _agent_now_iso(),
                "exit_code": int(exit_code),
                "error": "" if status.get("logged_in") else str(status.get("error") or ""),
            }
        )
    except Exception as exc:
        _agent_codex_login_state_update(
            {
                "running": False,
                "finished_at": _agent_now_iso(),
                "error": str(exc),
            }
        )
        if process is not None:
            try:
                process.kill()
            except Exception:
                pass


def _agent_codex_start_device_auth(repo_root: Path) -> dict[str, Any]:
    status = _agent_codex_login_status()
    if status.get("logged_in") is True:
        _agent_codex_login_state_update(
            {
                "running": False,
                "error": "",
                "finished_at": _agent_now_iso(),
                "exit_code": 0,
            }
        )
        snapshot = _agent_codex_login_snapshot()
        snapshot["logged_in"] = True
        snapshot["status_output"] = status.get("output")
        return snapshot

    with _AGENT_CODEX_LOGIN_LOCK:
        if _AGENT_CODEX_LOGIN_STATE.get("running") is True:
            snapshot = dict(_AGENT_CODEX_LOGIN_STATE)
            snapshot["logged_in"] = False
            return snapshot
        thread = threading.Thread(
            target=_agent_codex_device_auth_worker,
            args=(repo_root,),
            name="agent-codex-device-auth",
            daemon=True,
        )
        thread.start()

    deadline = time.time() + 4.0
    while time.time() < deadline:
        snapshot = _agent_codex_login_snapshot()
        if snapshot.get("url") and snapshot.get("code"):
            break
        time.sleep(0.1)

    snapshot = _agent_codex_login_snapshot()
    snapshot["logged_in"] = False
    return snapshot


def _agent_codex_app_server_model_list(
    repo_root: Path,
    *,
    include_hidden: bool = False,
    limit: int = 100,
) -> tuple[bool, list[dict[str, Any]], str]:
    ok_path, path_or_error = _agent_codex_cli_available()
    if not ok_path:
        return False, [], path_or_error
    process: subprocess.Popen[str] | None = None
    stderr_lines: list[str] = []
    timeout_s = 12.0
    try:
        process = subprocess.Popen(
            [path_or_error, "app-server"],
            cwd=str(repo_root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if process.stdin is None or process.stdout is None or process.stderr is None:
            raise RuntimeError("Codex app-server stdio is unavailable.")

        def _write_message(payload: dict[str, Any]):
            process.stdin.write(_agent_json_dumps(payload) + "\n")
            process.stdin.flush()

        def _poll_until_response(expected_id: int) -> dict[str, Any]:
            deadline = time.monotonic() + timeout_s
            while time.monotonic() < deadline:
                wait_s = max(0.05, min(0.25, deadline - time.monotonic()))
                ready, _, _ = select.select([process.stdout, process.stderr], [], [], wait_s)
                if not ready:
                    if process.poll() is not None:
                        break
                    continue
                for stream in ready:
                    line = stream.readline()
                    if not line:
                        continue
                    cleaned = _agent_strip_ansi(line).strip()
                    if not cleaned:
                        continue
                    if stream is process.stderr:
                        stderr_lines.append(cleaned)
                        continue
                    payload = _agent_json_loads(cleaned, None)
                    if not isinstance(payload, dict):
                        continue
                    if str(payload.get("id")) == str(expected_id):
                        return payload
            raise RuntimeError(f"Timed out waiting for Codex app-server response {expected_id}.")

        _write_message(
            {
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "uptospeed_model_catalog",
                        "title": "UP TO SPEED Model Catalog",
                        "version": "1.0.0",
                    },
                    "capabilities": {
                        "optOutNotificationMethods": [
                            "item/agentMessage/delta",
                            "thread/tokenUsage/updated",
                        ]
                    },
                },
            }
        )
        initialize_response = _poll_until_response(1)
        initialize_error = initialize_response.get("error")
        if isinstance(initialize_error, dict):
            raise RuntimeError(str(initialize_error.get("message") or "Codex app-server initialize failed.").strip())

        _write_message({"method": "initialized", "params": {}})
        _write_message(
            {
                "id": 2,
                "method": "model/list",
                "params": {
                    "limit": max(1, min(500, int(limit or 100))),
                    "includeHidden": include_hidden is True,
                },
            }
        )
        response = _poll_until_response(2)
        error_payload = response.get("error")
        if isinstance(error_payload, dict):
            message = str(error_payload.get("message") or "Codex app-server model/list failed.").strip()
            return False, [], message or "Codex app-server model/list failed."
        result_payload = response.get("result")
        if not isinstance(result_payload, dict):
            return False, [], "Codex app-server returned an invalid model list payload."
        data = result_payload.get("data")
        if not isinstance(data, list):
            return False, [], "Codex app-server returned an invalid model list."
        models = [item for item in data if isinstance(item, dict)]
        return True, models, ""
    except Exception as exc:
        message = str(exc).strip() or "Codex app-server model discovery failed."
        if stderr_lines:
            message = message or stderr_lines[-1]
        return False, [], message
    finally:
        if process is not None:
            try:
                if process.stdin is not None:
                    process.stdin.close()
            except Exception:
                pass
            if process.poll() is None:
                try:
                    process.terminate()
                    process.wait(timeout=1.0)
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass


def _agent_discovered_model_entry(
    provider_id: str,
    model_id: Any,
    *,
    label: Any = None,
    description: Any = None,
    source: str = "discovered",
    is_default: bool = False,
    metadata: dict[str, Any] | None = None,
    capabilities: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    normalized_provider = _agent_normalize_provider(provider_id)
    normalized_model_id = str(model_id or "").strip()
    if not normalized_provider or not normalized_model_id:
        return None
    entry = {
        "model_ref": _agent_model_ref(normalized_provider, normalized_model_id),
        "provider_id": normalized_provider,
        "model_id": normalized_model_id,
        "label": str(label or normalized_model_id).strip() or normalized_model_id,
        "description": str(description or "").strip(),
        "source": str(source or "discovered").strip() or "discovered",
        "enabled": True,
        "is_default": is_default is True,
    }
    if isinstance(capabilities, dict) and capabilities:
        entry["capabilities"] = capabilities
    if isinstance(metadata, dict) and metadata:
        entry["metadata"] = metadata
    return entry


def _agent_connection_is_connected(connection: Any) -> bool:
    return str((connection or {}).get("status") or "").strip().lower() == "connected"


def _agent_provider_connection_metadata(connection: Any) -> dict[str, Any]:
    metadata = _agent_json_loads((connection or {}).get("metadata_json"), {})
    return metadata if isinstance(metadata, dict) else {}


def _agent_openai_model_is_supported(model_id: Any) -> bool:
    token = str(model_id or "").strip().lower()
    if not token or token.startswith("ft:"):
        return False
    if any(term in token for term in ("audio", "realtime", "transcribe", "tts", "embedding", "moderation", "image", "whisper", "search")):
        return False
    return (
        token.startswith("gpt-")
        or token.startswith("o1")
        or token.startswith("o3")
        or token.startswith("o4")
        or token.startswith("chatgpt-")
    )


def _agent_openai_model_alias(model_id: str) -> str:
    return re.sub(r"-20\d{2}(?:-\d{2}){2}$", "", str(model_id or "").strip().lower())


def _agent_openai_model_sort_key(model: dict[str, Any]) -> tuple[Any, ...]:
    token = str(model.get("id") or "").strip().lower()
    created = int(model.get("created") or 0) if str(model.get("created") or "").strip() else 0
    family_rank = 4
    if token.startswith("gpt-5"):
        family_rank = 0
    elif token.startswith("gpt-4.1"):
        family_rank = 1
    elif token.startswith("gpt-4o"):
        family_rank = 2
    elif token.startswith(("o3", "o4", "o1")):
        family_rank = 3
    preview_penalty = 1 if any(term in token for term in ("preview", "beta", "alpha")) else 0
    size_penalty = 2 if "-nano" in token else (1 if "-mini" in token else 0)
    pro_penalty = 1 if "-pro" in token else 0
    alias_penalty = 1 if token.startswith("chatgpt-") else 0
    return (-created, family_rank, preview_penalty, size_penalty, pro_penalty, alias_penalty, token)


def _agent_openai_discovered_models(repo_root: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    connection = _agent_get_connection(repo_root, "openai") or {}
    metadata = _agent_provider_connection_metadata(connection)
    info = {
        "source": "openai_api",
        "status": str(connection.get("status") or "disconnected").strip().lower() or "disconnected",
        "error": str(metadata.get("error") or "").strip(),
        "fetched_at": _agent_now_iso(),
        "count": 0,
    }
    if not _agent_connection_is_connected(connection):
        if not info["error"]:
            info["error"] = "OpenAI is not connected."
        return {}, info

    api_key = _agent_get_connection_secret(repo_root, "openai")
    if not api_key:
        info["status"] = "error"
        info["error"] = "OpenAI API key is unavailable."
        return {}, info

    ok, status, payload, raw = _agent_http_json(
        url="https://api.openai.com/v1/models?limit=200",
        method="GET",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout_s=20.0,
    )
    if not ok or status != 200:
        error_payload = payload.get("error")
        if isinstance(error_payload, dict):
            info["error"] = str(error_payload.get("message") or "").strip()
        if not info["error"]:
            info["error"] = str(payload.get("error") or raw or f"HTTP {status}").strip() or "OpenAI model discovery failed."
        info["status"] = "error"
        return {}, info

    data = payload.get("data")
    if not isinstance(data, list):
        info["status"] = "error"
        info["error"] = "OpenAI returned an invalid models payload."
        return {}, info

    candidates = [item for item in data if isinstance(item, dict) and _agent_openai_model_is_supported(item.get("id"))]
    candidate_ids = {str(item.get("id") or "").strip().lower() for item in candidates if str(item.get("id") or "").strip()}
    ordered_rows = sorted(
        [
            item
            for item in candidates
            if not (
                _agent_openai_model_alias(str(item.get("id") or "").strip()) != str(item.get("id") or "").strip().lower()
                and _agent_openai_model_alias(str(item.get("id") or "").strip()) in candidate_ids
            )
        ],
        key=_agent_openai_model_sort_key,
    )

    catalog: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(ordered_rows):
        model_id = str(item.get("id") or "").strip()
        created = int(item.get("created") or 0) if str(item.get("created") or "").strip() else 0
        entry = _agent_discovered_model_entry(
            "openai",
            model_id,
            label=model_id,
            description="Available through the OpenAI API",
            source="openai_api",
            is_default=index == 0,
            metadata={
                "created_at": created or None,
                "owned_by": str(item.get("owned_by") or "").strip() or None,
                "sort_rank": index,
            },
            capabilities=dict(_agent_provider_capabilities("openai")),
        )
        if entry:
            catalog[str(entry.get("model_ref") or "")] = entry
    info["status"] = "connected"
    info["count"] = len(catalog)
    return catalog, info


def _agent_anthropic_model_is_supported(model_id: Any) -> bool:
    token = str(model_id or "").strip().lower()
    return token.startswith("claude-")


def _agent_anthropic_model_sort_key(model: dict[str, Any]) -> tuple[Any, ...]:
    token = str(model.get("id") or "").strip().lower()
    created_dt = _parse_iso_datetime(str(model.get("created_at") or model.get("createdAt") or ""))
    created_ts = created_dt.timestamp() if created_dt is not None else 0
    preview_penalty = 1 if "preview" in token else 0
    return (-created_ts, preview_penalty, token)


def _agent_anthropic_discovered_models(repo_root: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    connection = _agent_get_connection(repo_root, "anthropic") or {}
    metadata = _agent_provider_connection_metadata(connection)
    info = {
        "source": "anthropic_api",
        "status": str(connection.get("status") or "disconnected").strip().lower() or "disconnected",
        "error": str(metadata.get("error") or "").strip(),
        "fetched_at": _agent_now_iso(),
        "count": 0,
    }
    if not _agent_connection_is_connected(connection):
        if not info["error"]:
            info["error"] = "Anthropic is not connected."
        return {}, info

    api_key = _agent_get_connection_secret(repo_root, "anthropic")
    if not api_key:
        info["status"] = "error"
        info["error"] = "Anthropic API key is unavailable."
        return {}, info

    ok, status, payload, raw = _agent_http_json(
        url="https://api.anthropic.com/v1/models",
        method="GET",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        timeout_s=20.0,
    )
    if not ok or status != 200:
        error_payload = payload.get("error")
        if isinstance(error_payload, dict):
            info["error"] = str(error_payload.get("message") or "").strip()
        if not info["error"]:
            info["error"] = str(payload.get("error") or raw or f"HTTP {status}").strip() or "Anthropic model discovery failed."
        info["status"] = "error"
        return {}, info

    data = payload.get("data")
    if not isinstance(data, list):
        info["status"] = "error"
        info["error"] = "Anthropic returned an invalid models payload."
        return {}, info

    ordered_rows = sorted(
        [item for item in data if isinstance(item, dict) and _agent_anthropic_model_is_supported(item.get("id"))],
        key=_agent_anthropic_model_sort_key,
    )

    catalog: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(ordered_rows):
        model_id = str(item.get("id") or "").strip()
        created_at = str(item.get("created_at") or item.get("createdAt") or "").strip()
        entry = _agent_discovered_model_entry(
            "anthropic",
            model_id,
            label=str(item.get("display_name") or item.get("displayName") or model_id).strip() or model_id,
            description="Available through the Anthropic API",
            source="anthropic_api",
            is_default=index == 0,
            metadata={
                "created_at": created_at or None,
                "type": str(item.get("type") or "").strip() or None,
                "sort_rank": index,
            },
            capabilities=dict(_agent_provider_capabilities("anthropic")),
        )
        if entry:
            catalog[str(entry.get("model_ref") or "")] = entry
    info["status"] = "connected"
    info["count"] = len(catalog)
    return catalog, info


def _agent_gemini_supported_model_id(model_id: Any) -> bool:
    token = str(model_id or "").strip().lower()
    if not token or not token.startswith("gemini-"):
        return False
    return not any(term in token for term in ("embedding", "aqa"))


def _agent_gemini_model_sort_key(model: dict[str, Any]) -> tuple[Any, ...]:
    model_id = str(model.get("baseModelId") or model.get("model_id") or "").strip().lower()
    match = re.search(r"gemini-(\d+)(?:\.(\d+))?", model_id)
    major = int(match.group(1)) if match else 0
    minor = int(match.group(2)) if match and match.group(2) is not None else 0
    preview_penalty = 1 if any(term in model_id for term in ("preview", "exp", "experimental")) else 0
    latest_penalty = 1 if model_id.endswith("-latest") else 0
    tier_rank = 3
    if "-pro" in model_id:
        tier_rank = 0
    elif "flash-lite" in model_id:
        tier_rank = 2
    elif "-flash" in model_id:
        tier_rank = 1
    return (-major, -minor, preview_penalty, tier_rank, latest_penalty, model_id)


def _agent_gemini_discovered_models(repo_root: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    connection = _agent_get_connection(repo_root, "gemini") or {}
    metadata = _agent_provider_connection_metadata(connection)
    info = {
        "source": "google_ai_api",
        "status": str(connection.get("status") or "disconnected").strip().lower() or "disconnected",
        "error": str(metadata.get("error") or "").strip(),
        "fetched_at": _agent_now_iso(),
        "count": 0,
    }
    if not _agent_connection_is_connected(connection):
        if not info["error"]:
            info["error"] = "Gemini is not connected."
        return {}, info

    api_key = _agent_get_connection_secret(repo_root, "gemini")
    if not api_key:
        info["status"] = "error"
        info["error"] = "Google AI API key is unavailable."
        return {}, info

    ok, status, payload, raw = _agent_http_json(
        url=f"https://generativelanguage.googleapis.com/v1beta/models?{urlencode({'key': api_key})}",
        method="GET",
        timeout_s=20.0,
    )
    if not ok or status != 200:
        error_payload = payload.get("error")
        if isinstance(error_payload, dict):
            info["error"] = str(error_payload.get("message") or "").strip()
        if not info["error"]:
            info["error"] = str(payload.get("error") or raw or f"HTTP {status}").strip() or "Gemini model discovery failed."
        info["status"] = "error"
        return {}, info

    rows = payload.get("models")
    if not isinstance(rows, list):
        info["status"] = "error"
        info["error"] = "Gemini returned an invalid models payload."
        return {}, info

    best_by_model_id: dict[str, dict[str, Any]] = {}
    for item in rows:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        supported_methods = item.get("supportedGenerationMethods")
        methods = supported_methods if isinstance(supported_methods, list) else []
        if "generateContent" not in methods and "streamGenerateContent" not in methods:
            continue
        fallback_model_id = name.split("/", 1)[1] if "/" in name else ""
        model_id = str(item.get("baseModelId") or fallback_model_id).strip()
        if not _agent_gemini_supported_model_id(model_id):
            continue
        normalized_row = {**item, "baseModelId": model_id}
        previous = best_by_model_id.get(model_id)
        if previous is None or _agent_gemini_model_sort_key(normalized_row) < _agent_gemini_model_sort_key(previous):
            best_by_model_id[model_id] = normalized_row

    ordered_rows = sorted(best_by_model_id.values(), key=_agent_gemini_model_sort_key)

    catalog: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(ordered_rows):
        model_id = str(item.get("baseModelId") or "").strip()
        supported_methods = item.get("supportedGenerationMethods")
        methods = [str(method).strip() for method in supported_methods] if isinstance(supported_methods, list) else []
        entry = _agent_discovered_model_entry(
            "gemini",
            model_id,
            label=str(item.get("displayName") or model_id).strip() or model_id,
            description=str(item.get("description") or "Available through the Google AI API").strip(),
            source="google_ai_api",
            is_default=index == 0,
            metadata={
                "version": str(item.get("version") or "").strip() or None,
                "supported_generation_methods": methods,
                "input_token_limit": item.get("inputTokenLimit"),
                "output_token_limit": item.get("outputTokenLimit"),
                "sort_rank": index,
            },
            capabilities=dict(_agent_provider_capabilities("gemini")),
        )
        if entry:
            catalog[str(entry.get("model_ref") or "")] = entry
    info["status"] = "connected"
    info["count"] = len(catalog)
    return catalog, info


def _agent_codex_discovered_models(repo_root: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    connection = _agent_get_connection(repo_root, "codex") or {}
    auth_mode = str(connection.get("auth_mode") or "").strip()
    status = str(connection.get("status") or "").strip().lower()
    login_status = _agent_codex_login_status() if auth_mode == "codex_cli" else {}
    logged_in = login_status.get("logged_in") is True
    cli_version = _agent_codex_cli_version() if (auth_mode == "codex_cli" or status == "connected") else ""
    info = {
        "source": "codex_app_server",
        "status": "unavailable",
        "error": "",
        "cli_version": cli_version,
        "fetched_at": _agent_now_iso(),
        "count": 0,
    }
    if auth_mode != "codex_cli":
        info["error"] = "Codex CLI OAuth is not the active connection mode."
        return {}, info
    if not logged_in:
        info["status"] = "pending"
        info["error"] = str(login_status.get("error") or "Codex OAuth is not connected.").strip()
        return {}, info

    ok, models, error_message = _agent_codex_app_server_model_list(repo_root)
    if not ok:
        info["status"] = "error"
        info["error"] = error_message
        return {}, info

    catalog: dict[str, dict[str, Any]] = {}
    default_entry: dict[str, Any] | None = None
    for model in models:
        model_id = str(model.get("model") or model.get("id") or "").strip()
        display_name = str(model.get("displayName") or model.get("display_name") or model_id).strip() or model_id
        supported_efforts = model.get("supportedReasoningEfforts")
        effort_values: list[str] = []
        if isinstance(supported_efforts, list):
            for item in supported_efforts:
                if not isinstance(item, dict):
                    continue
                effort = str(item.get("reasoningEffort") or item.get("reasoning_effort") or "").strip()
                if effort and effort not in effort_values:
                    effort_values.append(effort)
        input_modalities = model.get("inputModalities")
        modalities: list[str] = []
        if isinstance(input_modalities, list):
            modalities = [str(item).strip() for item in input_modalities if str(item).strip()]
        capabilities = _agent_provider_capabilities("codex")
        capabilities = dict(capabilities)
        if effort_values:
            capabilities["supported_reasoning_efforts"] = effort_values
            capabilities["default_reasoning_effort"] = str(model.get("defaultReasoningEffort") or "").strip() or None
        if modalities:
            capabilities["input_modalities"] = modalities
        metadata = {
            "hidden": model.get("hidden") is True,
            "supports_personality": model.get("supportsPersonality") is True,
            "upgrade_model": str(model.get("upgrade") or "").strip() or None,
            "availability_nux": model.get("availabilityNux"),
            "cli_version": cli_version or None,
        }
        entry = _agent_discovered_model_entry(
            "codex",
            model_id,
            label=display_name,
            description=model.get("description") or "Available through Codex CLI",
            source="codex_app_server",
            is_default=model.get("isDefault") is True,
            metadata=metadata,
            capabilities=capabilities,
        )
        if not entry:
            continue
        if entry.get("is_default") is True:
            default_entry = entry
        catalog[str(entry.get("model_ref") or "")] = entry
    if default_entry:
        default_label = str(default_entry.get("label") or default_entry.get("model_id") or "Codex default").strip()
        catalog["codex/default"] = {
            **catalog.get("codex/default", _agent_builtin_models().get("codex/default", {})),
            "model_ref": "codex/default",
            "provider_id": "codex",
            "model_id": "default",
            "label": f"Codex Default ({default_label})",
            "description": f"Use the active Codex default model ({str(default_entry.get('model_id') or '').strip()}).",
            "source": "codex_app_server",
            "enabled": True,
            "metadata": {
                "resolved_model_ref": str(default_entry.get("model_ref") or ""),
                "cli_version": cli_version or None,
            },
        }
    info["status"] = "connected"
    info["count"] = len([entry for entry in catalog.values() if isinstance(entry, dict)])
    return catalog, info


def _agent_discover_model_catalog(repo_root: Path) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    discovered: dict[str, dict[str, Any]] = {}
    discovery_info: dict[str, dict[str, Any]] = {}
    registry = _agent_provider_registry()
    for provider_id, provider_entry in registry.items():
        list_models = provider_entry.get("list_models")
        if not callable(list_models):
            continue
        try:
            provider_models, provider_info = list_models(repo_root)
        except Exception as exc:
            provider_models = {}
            provider_info = {
                "status": "error",
                "error": str(exc),
                "fetched_at": _agent_now_iso(),
                "count": 0,
            }
        if isinstance(provider_models, dict):
            discovered.update(provider_models)
        if isinstance(provider_info, dict):
            discovery_info[str(provider_id)] = provider_info
    return discovered, discovery_info


def _agent_catalog_default_model_ref(
    provider_id: str,
    model_catalog: dict[str, dict[str, Any]],
) -> str:
    normalized_provider = _agent_normalize_provider(provider_id)
    if not normalized_provider:
        return ""
    candidates = [
        entry
        for entry in model_catalog.values()
        if isinstance(entry, dict)
        and _agent_normalize_provider(entry.get("provider_id")) == normalized_provider
        and entry.get("enabled") is not False
    ]
    default_candidate = next(
        (
            entry
            for entry in candidates
            if entry.get("is_default") is True and str(entry.get("model_id") or "").strip() != "default"
        ),
        None,
    )
    if isinstance(default_candidate, dict):
        return _agent_normalize_model_ref(default_candidate.get("model_ref"), fallback_provider=normalized_provider)
    alias_candidate = next(
        (
            entry
            for entry in candidates
            if str(entry.get("model_id") or "").strip() == "default"
        ),
        None,
    )
    if isinstance(alias_candidate, dict):
        return _agent_normalize_model_ref(alias_candidate.get("model_ref"), fallback_provider=normalized_provider)
    return _agent_default_model_ref_for_provider(normalized_provider)


def _agent_tool_args_preview(args: dict[str, Any]) -> dict[str, Any]:
    payload = dict(args or {})
    payload["confirm"] = False
    return payload


def _agent_tool_args_apply(args: dict[str, Any]) -> dict[str, Any]:
    payload = dict(args or {})
    payload["confirm"] = True
    return payload


def _agent_emit_run_event(run_id: str, event: str, payload: Any, *, event_id: str | None = None):
    rid = str(run_id or "").strip()
    if not rid:
        return
    with _AGENT_RUN_STREAM_LOCK:
        if event == "message.assistant":
            existing = list(_AGENT_RUN_TRANSIENT_EVENTS.get(rid) or [])
            if existing:
                next_events = [entry for entry in existing if entry[0] != "message.assistant.delta"]
                if next_events:
                    _AGENT_RUN_TRANSIENT_EVENTS[rid] = next_events
                elif rid in _AGENT_RUN_TRANSIENT_EVENTS:
                    _AGENT_RUN_TRANSIENT_EVENTS.pop(rid, None)
        elif event in _AGENT_RUN_TRANSIENT_EVENT_NAMES:
            existing = list(_AGENT_RUN_TRANSIENT_EVENTS.get(rid) or [])
            existing.append((event, payload, event_id))
            _AGENT_RUN_TRANSIENT_EVENTS[rid] = existing[-128:]
        queues = list(_AGENT_RUN_STREAMS.get(rid) or [])
    if not queues:
        return
    for sub in queues:
        try:
            sub.put_nowait((event, payload, event_id))
        except queue.Full:
            try:
                sub.get_nowait()
            except Exception:
                pass
            try:
                sub.put_nowait((event, payload, event_id))
            except Exception:
                continue


def _agent_subscribe_run_stream(run_id: str) -> queue.Queue[tuple[str, Any, str | None]]:
    rid = str(run_id or "").strip()
    subscriber: queue.Queue[tuple[str, Any, str | None]] = queue.Queue(maxsize=256)
    with _AGENT_RUN_STREAM_LOCK:
        current = _AGENT_RUN_STREAMS.setdefault(rid, [])
        current.append(subscriber)
        backlog = list(_AGENT_RUN_TRANSIENT_EVENTS.get(rid) or [])
    for event, payload, event_id in backlog:
        try:
            subscriber.put_nowait((event, payload, event_id))
        except queue.Full:
            break
    return subscriber


def _agent_unsubscribe_run_stream(run_id: str, subscriber: queue.Queue[tuple[str, Any, str | None]]):
    rid = str(run_id or "").strip()
    with _AGENT_RUN_STREAM_LOCK:
        current = _AGENT_RUN_STREAMS.get(rid) or []
        next_items = [item for item in current if item is not subscriber]
        if next_items:
            _AGENT_RUN_STREAMS[rid] = next_items
        elif rid in _AGENT_RUN_STREAMS:
            _AGENT_RUN_STREAMS.pop(rid, None)


def _local_broker_initialize_agent_schema(conn: sqlite3.Connection):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT,
            provider_id TEXT NOT NULL,
            default_model_ref TEXT,
            default_project_scope TEXT,
            description TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_connections (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL UNIQUE,
            provider_id TEXT,
            auth_mode TEXT NOT NULL,
            profile_label TEXT,
            credential_ref TEXT,
            secret_ciphertext TEXT,
            status TEXT NOT NULL DEFAULT 'disconnected',
            metadata_json TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            last_tested_at REAL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_threads (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            project_scope TEXT NOT NULL,
            source TEXT NOT NULL,
            task_id TEXT,
            title TEXT,
            provider_id TEXT,
            model_ref TEXT,
            context_json TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            run_id TEXT,
            role TEXT NOT NULL,
            provider TEXT,
            content TEXT NOT NULL,
            metadata_json TEXT,
            created_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            project_scope TEXT NOT NULL,
            source TEXT NOT NULL,
            provider TEXT NOT NULL,
            provider_id TEXT,
            model_ref TEXT,
            agent_profile_id TEXT,
            auth_profile_id TEXT,
            worker_id TEXT,
            status TEXT NOT NULL,
            prompt TEXT NOT NULL,
            context_json TEXT,
            model TEXT,
            error TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            started_at REAL,
            heartbeat_at REAL,
            lease_expires_at REAL,
            cancel_requested_at REAL,
            finished_at REAL,
            interrupted_reason TEXT,
            updated_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_actions (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            sequence_index INTEGER NOT NULL,
            tool_name TEXT NOT NULL,
            args_json TEXT NOT NULL,
            target_scope TEXT,
            field_signature TEXT,
            preview_json TEXT,
            preview_ok INTEGER,
            status TEXT NOT NULL,
            decision TEXT,
            decision_by TEXT,
            decision_at REAL,
            applied_json TEXT,
            failure_reason TEXT,
            retry_of_action_id TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_trust_rules (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            project_scope TEXT NOT NULL,
            agent_profile_id TEXT,
            tool_name TEXT NOT NULL,
            field_signature TEXT,
            target_scope TEXT,
            permission TEXT NOT NULL DEFAULT 'trust',
            active INTEGER NOT NULL DEFAULT 1,
            created_at REAL NOT NULL,
            revoked_at REAL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            run_id TEXT,
            action_id TEXT,
            event_type TEXT NOT NULL,
            payload_json TEXT,
            created_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_agent_messages_thread_created
        ON agent_messages(thread_id, created_at ASC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_agent_runs_created
        ON agent_runs(created_at DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_agent_runs_status
        ON agent_runs(status, updated_at DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_agent_actions_run_seq
        ON agent_actions(run_id, sequence_index ASC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_agent_actions_status
        ON agent_actions(status, updated_at DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_agent_trust_lookup
        ON agent_trust_rules(user_id, project_scope, tool_name, active)
        """
    )


def _local_broker_initialize(repo_root: Path):
    global _LOCAL_BROKER_INITIALIZED
    if _LOCAL_BROKER_INITIALIZED:
        return
    with _LOCAL_BROKER_INIT_LOCK:
        if _LOCAL_BROKER_INITIALIZED:
            return
        conn = _local_broker_connect(repo_root)
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_task_overrides (
                    project_id INTEGER NOT NULL,
                    task_id TEXT NOT NULL,
                    sg_task_id INTEGER,
                    auth_account_id TEXT,
                    task_json TEXT NOT NULL,
                    sync_state TEXT NOT NULL DEFAULT 'pending',
                    last_error TEXT,
                    source TEXT NOT NULL DEFAULT 'unknown',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    synced_at REAL,
                    PRIMARY KEY (project_id, task_id)
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_local_task_overrides_project_state
                ON local_task_overrides(project_id, sync_state, updated_at DESC)
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_sync_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    task_id TEXT NOT NULL,
                    sg_task_id INTEGER,
                    auth_account_id TEXT,
                    auth_policy TEXT NOT NULL DEFAULT 'script_only',
                    allow_script_fallback INTEGER NOT NULL DEFAULT 0,
                    effective_actor TEXT NOT NULL DEFAULT 'script',
                    fallback_used INTEGER NOT NULL DEFAULT 0,
                    op_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'unknown',
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at REAL NOT NULL DEFAULT 0,
                    last_error TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_local_sync_queue_status_due
                ON local_sync_queue(status, next_attempt_at, id)
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_task_links (
                    project_id INTEGER NOT NULL,
                    local_id TEXT NOT NULL,
                    sg_task_id INTEGER NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (project_id, local_id)
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_local_task_links_project_sg
                ON local_task_links(project_id, sg_task_id)
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_broker_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS auth_accounts (
                    account_id TEXT PRIMARY KEY,
                    base_url TEXT NOT NULL,
                    grant_type TEXT,
                    login TEXT,
                    display_name TEXT,
                    sg_user_id INTEGER,
                    access_token TEXT NOT NULL,
                    refresh_token TEXT,
                    access_expires_at REAL,
                    refresh_expires_at REAL,
                    remembered INTEGER NOT NULL DEFAULT 1,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    last_used_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_sync_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    queue_job_id INTEGER,
                    requested_actor TEXT NOT NULL,
                    effective_actor TEXT NOT NULL,
                    operation_type TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    error TEXT,
                    created_at REAL NOT NULL,
                    finished_at REAL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_auth_accounts_last_used
                ON auth_accounts(last_used_at DESC)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_local_sync_audit_job
                ON local_sync_audit(queue_job_id, created_at DESC)
                """
            )
            _local_broker_initialize_agent_schema(conn)
            _local_broker_apply_schema_migrations(conn)
        finally:
            conn.close()
        _LOCAL_BROKER_INITIALIZED = True


def _local_broker_auth_key(auth: dict[str, Any] | None) -> str:
    if not isinstance(auth, dict):
        return "unknown"
    mode = str(auth.get("mode") or "script")
    if mode == "script":
        client_id = str(auth.get("client_id") or "script")
        return f"script:{client_id}"
    account_id = str(auth.get("account_id") or "").strip()
    if account_id:
        return f"user:account:{account_id}"
    sg_user_id = _coerce_int(auth.get("sg_user_id"))
    if sg_user_id and sg_user_id > 0:
        return f"user:sg:{sg_user_id}"
    ident = str(auth.get("id") or "user")
    return f"user:{ident}"


def _local_broker_set_meta(repo_root: Path, key: str, value: str):
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        now = _now_s()
        conn.execute(
            """
            INSERT INTO local_broker_meta(key, value, updated_at)
            VALUES(?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              value=excluded.value,
              updated_at=excluded.updated_at
            """,
            (key, value, now),
        )
    finally:
        conn.close()


def _local_broker_get_meta(repo_root: Path, key: str) -> str | None:
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        row = conn.execute("SELECT value FROM local_broker_meta WHERE key = ?", (key,)).fetchone()
        if not row:
            return None
        return str(row["value"])
    finally:
        conn.close()


def _agent_get_config(repo_root: Path) -> dict[str, Any]:
    raw = _local_broker_get_meta(repo_root, _AGENT_CONFIG_META_KEY)
    parsed = _agent_json_loads(raw, {})
    if not isinstance(parsed, dict):
        parsed = {}
    return _agent_merge_config(parsed, None)


def _agent_set_config(repo_root: Path, updates: dict[str, Any] | None) -> dict[str, Any]:
    current = _agent_get_config(repo_root)
    merged = _agent_merge_config(current, updates if isinstance(updates, dict) else {})
    _local_broker_set_meta(repo_root, _AGENT_CONFIG_META_KEY, _agent_json_dumps(merged))
    return merged


def _agent_connection_to_public(row: dict[str, Any]) -> dict[str, Any]:
    metadata = _agent_json_loads(row.get("metadata_json"), {})
    if not isinstance(metadata, dict):
        metadata = {}
    provider_id = _agent_normalize_provider(row.get("provider_id") or row.get("provider") or "")
    secret = _agent_decode_secret(row.get("secret_ciphertext"))
    return {
        "id": str(row.get("id") or ""),
        "provider_id": provider_id,
        "provider": provider_id,
        "providerLabel": _agent_provider_title(provider_id),
        "profile_label": str(row.get("profile_label") or "").strip() or None,
        "auth_mode": str(row.get("auth_mode") or ""),
        "credential_ref": str(row.get("credential_ref") or "") or None,
        "status": str(row.get("status") or "disconnected"),
        "metadata": metadata,
        "secret_masked": _agent_mask_secret(secret) if secret else "",
        "last_tested_at": row.get("last_tested_at"),
        "updated_at": row.get("updated_at"),
    }


def _agent_connection_default(provider: str) -> dict[str, Any]:
    normalized = _agent_normalize_provider(provider)
    return {
        "id": "",
        "provider_id": normalized,
        "provider": normalized,
        "providerLabel": _agent_provider_title(normalized),
        "profile_label": None,
        "auth_mode": "",
        "credential_ref": None,
        "status": "disconnected",
        "metadata": {},
        "secret_masked": "",
        "last_tested_at": None,
        "updated_at": None,
    }


def _agent_get_connection(repo_root: Path, provider: str) -> dict[str, Any] | None:
    normalized = _agent_normalize_provider(provider)
    if not normalized:
        return None
    lookup_values = [normalized]
    for alias, target in _AGENT_PROVIDER_ALIASES.items():
        if target == normalized and alias not in lookup_values:
            lookup_values.append(alias)
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        row = conn.execute(
            f"SELECT * FROM agent_connections WHERE provider IN ({', '.join(['?'] * len(lookup_values))}) ORDER BY updated_at DESC LIMIT 1",
            tuple(lookup_values),
        ).fetchone()
        if not row:
            return None
        return _agent_row_to_dict(row)
    finally:
        conn.close()


def _agent_list_connections(repo_root: Path) -> list[dict[str, Any]]:
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    rows: list[dict[str, Any]] = []
    try:
        fetched = conn.execute("SELECT * FROM agent_connections ORDER BY provider ASC").fetchall()
        rows = [_agent_row_to_dict(row) for row in fetched]
    finally:
        conn.close()

    by_provider: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not row:
            continue
        provider_id = _agent_normalize_provider(row.get("provider_id") or row.get("provider") or "")
        if not provider_id:
            continue
        current = by_provider.get(provider_id)
        if current is None or float(row.get("updated_at") or 0) >= float(current.get("updated_at") or 0):
            by_provider[provider_id] = row
    results: list[dict[str, Any]] = []
    for provider in sorted(_AGENT_PROVIDER_VALUES):
        row = by_provider.get(provider)
        if row:
            results.append(_agent_connection_to_public(row))
        else:
            results.append(_agent_connection_default(provider))
    return results


def _agent_upsert_connection(
    repo_root: Path,
    *,
    provider: str,
    auth_mode: str,
    status: str,
    metadata: dict[str, Any] | None = None,
    secret: str | None = None,
    credential_ref: str | None = None,
    profile_label: str | None = None,
    tested: bool = False,
) -> dict[str, Any]:
    normalized_provider = _agent_normalize_provider(provider)
    if not normalized_provider:
        raise ValueError("provider must be a supported provider")
    mode = str(auth_mode or "").strip()
    if not mode:
        raise ValueError("auth_mode is required")
    next_status = str(status or "").strip() or "disconnected"
    existing = _agent_get_connection(repo_root, normalized_provider)
    now = _now_s()
    row_id = str(existing.get("id") if isinstance(existing, dict) else "") or _agent_new_id("agent_conn")
    metadata_payload = metadata if isinstance(metadata, dict) else {}
    metadata_json = _agent_json_dumps(metadata_payload)
    if secret is not None:
        secret_ciphertext = _agent_encode_secret(secret)
    else:
        secret_ciphertext = str(existing.get("secret_ciphertext") or "") if isinstance(existing, dict) else ""
    if credential_ref is None:
        next_credential_ref = str(existing.get("credential_ref") or "") if isinstance(existing, dict) else ""
    else:
        next_credential_ref = str(credential_ref or "")
    if profile_label is None:
        next_profile_label = str(existing.get("profile_label") or "") if isinstance(existing, dict) else ""
    else:
        next_profile_label = str(profile_label or "")

    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        existing_provider_value = str(existing.get("provider") or "") if isinstance(existing, dict) else normalized_provider
        conn.execute(
            """
            INSERT INTO agent_connections(
                id, provider, provider_id, auth_mode, profile_label, credential_ref,
                secret_ciphertext, status, metadata_json, created_at, updated_at, last_tested_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider) DO UPDATE SET
              provider=excluded.provider,
              provider_id=excluded.provider_id,
              auth_mode=excluded.auth_mode,
              profile_label=excluded.profile_label,
              credential_ref=excluded.credential_ref,
              secret_ciphertext=excluded.secret_ciphertext,
              status=excluded.status,
              metadata_json=excluded.metadata_json,
              updated_at=excluded.updated_at,
              last_tested_at=excluded.last_tested_at
            """,
            (
                row_id,
                existing_provider_value or normalized_provider,
                normalized_provider,
                mode,
                next_profile_label or None,
                next_credential_ref or None,
                secret_ciphertext or None,
                next_status,
                metadata_json,
                now,
                now,
                now if tested else (existing.get("last_tested_at") if isinstance(existing, dict) else None),
            ),
        )
        if existing_provider_value and existing_provider_value != normalized_provider:
            conn.execute(
                "UPDATE agent_connections SET provider = ?, provider_id = ?, updated_at = ? WHERE provider = ?",
                (normalized_provider, normalized_provider, now, existing_provider_value),
            )
        row = conn.execute(
            "SELECT * FROM agent_connections WHERE provider_id = ? OR provider = ? ORDER BY updated_at DESC LIMIT 1",
            (normalized_provider, normalized_provider),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError("Failed to persist agent connection")
    return _agent_connection_to_public(_agent_row_to_dict(row))


def _agent_get_connection_secret(repo_root: Path, provider: str) -> str:
    row = _agent_get_connection(repo_root, provider)
    if not row:
        return ""
    return _agent_decode_secret(row.get("secret_ciphertext"))


def _agent_catalog_payload(repo_root: Path, config: dict[str, Any] | None = None) -> dict[str, Any]:
    merged_config = _agent_merge_config(config, None) if isinstance(config, dict) else _agent_get_config(repo_root)
    connections = _agent_list_connections(repo_root)
    connection_by_provider = {
        str(item.get("provider_id") or item.get("provider") or ""): item
        for item in connections
        if isinstance(item, dict) and str(item.get("provider_id") or item.get("provider") or "")
    }
    discovered_models, discovery_info = _agent_discover_model_catalog(repo_root)
    model_catalog = _agent_normalize_model_catalog(
        merged_config.get("models"),
        discovered_models=discovered_models,
    )
    models = sorted(
        model_catalog.values(),
        key=lambda item: (
            str(item.get("provider_id") or ""),
            str(item.get("label") or item.get("model_ref") or ""),
        ),
    )
    providers: list[dict[str, Any]] = []
    for provider_id in sorted(_AGENT_PROVIDER_VALUES):
        providers.append(
            {
                "provider_id": provider_id,
                "label": _agent_provider_title(provider_id),
                "logo_path": _agent_provider_logo_path(provider_id),
                "aliases": _agent_provider_aliases(provider_id),
                "auth_modes": _agent_provider_auth_modes(provider_id),
                "capabilities": _agent_provider_capabilities(provider_id),
                "default_model_ref": _agent_catalog_default_model_ref(provider_id, model_catalog),
                "connection": connection_by_provider.get(provider_id, _agent_connection_default(provider_id)),
                "model_discovery": discovery_info.get(provider_id, {}),
            }
        )
    return {
        "providers": providers,
        "models": models,
        "connections": connections,
        "defaults": {
            "default_model": str(merged_config.get("defaultModel") or _agent_default_model_ref_for_provider("codex")),
            "default_model_by_project": merged_config.get("defaultModelByProject") if isinstance(merged_config.get("defaultModelByProject"), dict) else {},
            "fallbacks": merged_config.get("fallbacks") if isinstance(merged_config.get("fallbacks"), list) else [],
        },
    }


def _agent_insert_audit(
    repo_root: Path,
    *,
    user_id: str | None,
    run_id: str | None,
    action_id: str | None,
    event_type: str,
    payload: Any,
):
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            """
            INSERT INTO agent_audit(user_id, run_id, action_id, event_type, payload_json, created_at)
            VALUES(?, ?, ?, ?, ?, ?)
            """,
            (
                str(user_id or "").strip() or None,
                str(run_id or "").strip() or None,
                str(action_id or "").strip() or None,
                str(event_type or "").strip() or "event",
                _agent_json_dumps(payload) if payload is not None else None,
                _now_s(),
            ),
        )
    finally:
        conn.close()


def _agent_profile_row_to_payload(row: dict[str, Any]) -> dict[str, Any]:
    payload = _agent_row_to_dict(row)
    provider_id = _agent_normalize_provider(payload.get("provider_id") or payload.get("provider") or "") or "codex"
    default_model_ref = _agent_normalize_model_ref(
        payload.get("default_model_ref") or payload.get("model_ref") or payload.get("model"),
        fallback_provider=provider_id,
    ) or _agent_default_model_ref_for_provider(provider_id)
    return {
        "id": str(payload.get("id") or ""),
        "name": str(payload.get("name") or payload.get("display_name") or _agent_provider_title(provider_id)).strip(),
        "role": str(payload.get("role") or _AGENT_DEFAULT_PROFILE_ROLE).strip() or _AGENT_DEFAULT_PROFILE_ROLE,
        "provider_id": provider_id,
        "providerLabel": _agent_provider_title(provider_id),
        "default_model_ref": default_model_ref,
        "default_project_scope": _agent_normalize_project_scope(payload.get("default_project_scope") or "global"),
        "description": str(payload.get("description") or "").strip(),
        "active": bool(int(payload.get("active") or 0) if str(payload.get("active") or "").strip() else 0),
        "created_at": payload.get("created_at"),
        "updated_at": payload.get("updated_at"),
    }


def _agent_default_profiles_seed(config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    resolved_config = config if isinstance(config, dict) else _agent_get_config(_runtime_app_root(Path(__file__).resolve().parents[1]))
    profiles: list[dict[str, Any]] = []
    for provider_id in sorted(_AGENT_PROVIDER_VALUES):
        default_model_ref, _ = _agent_resolve_model_selection(
            resolved_config,
            requested_model_ref=None,
            provider_hint=provider_id,
            project_scope="global",
        )
        profiles.append(
            {
                "id": f"agent_profile_{provider_id}_default",
                "name": f"{_agent_provider_title(provider_id)} Operator",
                "role": _AGENT_DEFAULT_PROFILE_ROLE,
                "provider_id": provider_id,
                "default_model_ref": default_model_ref,
                "default_project_scope": "global",
                "description": f"Default {_agent_provider_title(provider_id)} profile.",
                "active": True,
            }
        )
    return profiles


def _agent_seed_default_profiles(repo_root: Path):
    config = _agent_get_config(repo_root)
    profiles = _agent_default_profiles_seed(config)
    if not profiles:
        return
    now = _now_s()
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        profile_columns = _local_broker_table_columns(conn, "agent_profiles")
        has_legacy_display_name = "display_name" in profile_columns
        has_legacy_provider = "provider" in profile_columns
        has_legacy_model = "model" in profile_columns
        for profile in profiles:
            existing = conn.execute(
                "SELECT id FROM agent_profiles WHERE id = ? LIMIT 1",
                (profile["id"],),
            ).fetchone()
            if existing:
                continue
            insert_columns = [
                "id",
                "name",
                "role",
                "provider_id",
                "default_model_ref",
                "default_project_scope",
                "description",
                "active",
                "created_at",
                "updated_at",
            ]
            insert_values: list[Any] = [
                profile["id"],
                profile["name"],
                profile["role"],
                profile["provider_id"],
                profile["default_model_ref"],
                profile["default_project_scope"],
                profile["description"],
                1 if profile["active"] else 0,
                now,
                now,
            ]
            if has_legacy_display_name:
                insert_columns.insert(2, "display_name")
                insert_values.insert(2, profile["name"])
            if has_legacy_provider:
                provider_index = insert_columns.index("provider_id")
                insert_columns.insert(provider_index, "provider")
                insert_values.insert(provider_index, profile["provider_id"])
            if has_legacy_model:
                model_index = insert_columns.index("default_model_ref")
                insert_columns.insert(model_index, "model")
                insert_values.insert(model_index, profile["default_model_ref"])
            conn.execute(
                f"""
                INSERT INTO agent_profiles({", ".join(insert_columns)})
                VALUES({", ".join(["?"] * len(insert_columns))})
                """,
                tuple(insert_values),
            )
    finally:
        conn.close()


def _agent_list_profiles(
    repo_root: Path,
    *,
    active_only: bool = False,
    provider_id: str | None = None,
) -> list[dict[str, Any]]:
    _agent_seed_default_profiles(repo_root)
    normalized_provider = _agent_normalize_provider(provider_id) if provider_id else ""
    where: list[str] = []
    params: list[Any] = []
    if active_only:
        where.append("COALESCE(active, 1) = 1")
    if normalized_provider:
        where.append("COALESCE(NULLIF(provider_id, ''), 'codex') = ?")
        params.append(normalized_provider)
    where_clause = f"WHERE {' AND '.join(where)}" if where else ""
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(
            f"""
            SELECT * FROM agent_profiles
            {where_clause}
            ORDER BY COALESCE(active, 1) DESC, updated_at DESC, created_at DESC
            """
            ,
            tuple(params),
        ).fetchall()
        return [_agent_profile_row_to_payload(_agent_row_to_dict(row)) for row in rows]
    finally:
        conn.close()


def _agent_get_profile(repo_root: Path, profile_id: str) -> dict[str, Any] | None:
    pid = str(profile_id or "").strip()
    if not pid:
        return None
    _agent_seed_default_profiles(repo_root)
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        row = conn.execute(
            "SELECT * FROM agent_profiles WHERE id = ? LIMIT 1",
            (pid,),
        ).fetchone()
        return _agent_profile_row_to_payload(_agent_row_to_dict(row)) if row else None
    finally:
        conn.close()


def _agent_save_profile(repo_root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("profile payload is required")
    profile_id = str(payload.get("id") or "").strip() or _agent_new_id("agent_profile")
    provider_id = _agent_normalize_provider(payload.get("provider_id") or payload.get("providerId") or payload.get("provider"))
    if not provider_id:
        raise ValueError("provider_id is required")
    name = str(payload.get("name") or "").strip() or f"{_agent_provider_title(provider_id)} Operator"
    role = str(payload.get("role") or _AGENT_DEFAULT_PROFILE_ROLE).strip() or _AGENT_DEFAULT_PROFILE_ROLE
    default_model_ref = _agent_normalize_model_ref(
        payload.get("default_model_ref") or payload.get("defaultModelRef"),
        fallback_provider=provider_id,
    ) or _agent_default_model_ref_for_provider(provider_id)
    default_project_scope = _agent_normalize_project_scope(
        payload.get("default_project_scope") or payload.get("defaultProjectScope") or "global"
    )
    description = str(payload.get("description") or "").strip()
    active = payload.get("active")
    active_value = 0 if active is False else 1
    now = _now_s()
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        profile_columns = _local_broker_table_columns(conn, "agent_profiles")
        has_legacy_display_name = "display_name" in profile_columns
        has_legacy_provider = "provider" in profile_columns
        has_legacy_model = "model" in profile_columns
        existing = conn.execute("SELECT id, created_at FROM agent_profiles WHERE id = ? LIMIT 1", (profile_id,)).fetchone()
        if existing:
            assignments = [
                "name = ?",
                "role = ?",
                "provider_id = ?",
                "default_model_ref = ?",
                "default_project_scope = ?",
                "description = ?",
                "active = ?",
                "updated_at = ?",
            ]
            values: list[Any] = [
                name,
                role,
                provider_id,
                default_model_ref,
                default_project_scope,
                description,
                active_value,
                now,
            ]
            if has_legacy_display_name:
                assignments.insert(1, "display_name = ?")
                values.insert(1, name)
            if has_legacy_provider:
                provider_assignment_index = assignments.index("provider_id = ?")
                assignments.insert(provider_assignment_index, "provider = ?")
                values.insert(provider_assignment_index, provider_id)
            if has_legacy_model:
                model_assignment_index = assignments.index("default_model_ref = ?")
                assignments.insert(model_assignment_index, "model = ?")
                values.insert(model_assignment_index, default_model_ref)
            conn.execute(
                f"""
                UPDATE agent_profiles
                SET {", ".join(assignments)}
                WHERE id = ?
                """,
                (*values, profile_id),
            )
        else:
            insert_columns = [
                "id",
                "name",
                "role",
                "provider_id",
                "default_model_ref",
                "default_project_scope",
                "description",
                "active",
                "created_at",
                "updated_at",
            ]
            insert_values: list[Any] = [
                profile_id,
                name,
                role,
                provider_id,
                default_model_ref,
                default_project_scope,
                description,
                active_value,
                now,
                now,
            ]
            if has_legacy_display_name:
                insert_columns.insert(2, "display_name")
                insert_values.insert(2, name)
            if has_legacy_provider:
                provider_index = insert_columns.index("provider_id")
                insert_columns.insert(provider_index, "provider")
                insert_values.insert(provider_index, provider_id)
            if has_legacy_model:
                model_index = insert_columns.index("default_model_ref")
                insert_columns.insert(model_index, "model")
                insert_values.insert(model_index, default_model_ref)
            conn.execute(
                f"""
                INSERT INTO agent_profiles({", ".join(insert_columns)})
                VALUES({", ".join(["?"] * len(insert_columns))})
                """,
                tuple(insert_values),
            )
        row = conn.execute("SELECT * FROM agent_profiles WHERE id = ? LIMIT 1", (profile_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError("Failed to save agent profile")
    return _agent_profile_row_to_payload(_agent_row_to_dict(row))


def _agent_delete_profile(repo_root: Path, profile_id: str) -> bool:
    pid = str(profile_id or "").strip()
    if not pid:
        return False
    if pid.startswith("agent_profile_") and pid.endswith("_default"):
        raise ValueError("Default profiles cannot be deleted.")
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        cur = conn.execute("DELETE FROM agent_profiles WHERE id = ?", (pid,))
        conn.execute(
            """
            UPDATE agent_trust_rules
            SET agent_profile_id = NULL
            WHERE agent_profile_id = ?
            """,
            (pid,),
        )
        conn.execute(
            """
            UPDATE agent_runs
            SET agent_profile_id = NULL
            WHERE agent_profile_id = ?
            """,
            (pid,),
        )
        return int(cur.rowcount or 0) > 0
    finally:
        conn.close()


def _agent_resolve_run_profile(
    repo_root: Path,
    *,
    requested_profile_id: str | None,
    provider_id: str,
    model_ref: str | None,
    project_scope: str,
) -> dict[str, Any]:
    requested = _agent_get_profile(repo_root, str(requested_profile_id or "").strip()) if requested_profile_id else None
    if requested and requested.get("active") is True:
        return requested

    normalized_provider = _agent_normalize_provider(provider_id) or "codex"
    normalized_scope = _agent_normalize_project_scope(project_scope)
    profiles = _agent_list_profiles(repo_root, active_only=True, provider_id=normalized_provider)
    if profiles:
        exact_scope = [profile for profile in profiles if str(profile.get("default_project_scope") or "") == normalized_scope]
        if exact_scope:
            return exact_scope[0]
        global_scope = [
            profile
            for profile in profiles
            if str(profile.get("default_project_scope") or "global") in {"global", "*"}
        ]
        if global_scope:
            return global_scope[0]
        return profiles[0]

    return _agent_save_profile(
        repo_root,
        {
            "id": f"agent_profile_{normalized_provider}_default",
            "name": f"{_agent_provider_title(normalized_provider)} Operator",
            "role": _AGENT_DEFAULT_PROFILE_ROLE,
            "provider_id": normalized_provider,
            "default_model_ref": _agent_normalize_model_ref(model_ref, fallback_provider=normalized_provider) or _agent_default_model_ref_for_provider(normalized_provider),
            "default_project_scope": "global",
            "description": f"Default {_agent_provider_title(normalized_provider)} profile.",
            "active": True,
        },
    )


def _agent_create_thread(
    repo_root: Path,
    *,
    user_id: str,
    project_scope: str,
    source: str,
    task_id: str | None,
    title: str,
    provider_id: str | None,
    model_ref: str | None,
    context: dict[str, Any] | None,
    thread_id: str | None = None,
) -> dict[str, Any]:
    now = _now_s()
    next_id = str(thread_id or "").strip() or _agent_new_id("agent_thread")
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        existing = conn.execute("SELECT * FROM agent_threads WHERE id = ? LIMIT 1", (next_id,)).fetchone()
        if existing:
            conn.execute(
                """
                UPDATE agent_threads
                SET updated_at = ?, title = ?, provider_id = ?, model_ref = ?, context_json = ?
                WHERE id = ?
                """,
                (
                    now,
                    str(title or "").strip() or None,
                    _agent_normalize_provider(provider_id) or None,
                    _agent_normalize_model_ref(model_ref, fallback_provider=provider_id or "codex") or None,
                    _agent_json_dumps(context if isinstance(context, dict) else {}),
                    next_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO agent_threads(
                    id, user_id, project_scope, source, task_id, title, provider_id, model_ref,
                    context_json, created_at, updated_at
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    next_id,
                    _agent_normalize_user_id(user_id),
                    _agent_normalize_project_scope(project_scope),
                    str(source or "chat"),
                    str(task_id or "").strip() or None,
                    str(title or "").strip() or None,
                    _agent_normalize_provider(provider_id) or None,
                    _agent_normalize_model_ref(model_ref, fallback_provider=provider_id or "codex") or None,
                    _agent_json_dumps(context if isinstance(context, dict) else {}),
                    now,
                    now,
                ),
            )
        row = conn.execute("SELECT * FROM agent_threads WHERE id = ? LIMIT 1", (next_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError("Failed to create agent thread")
    return _agent_row_to_dict(row)


def _agent_get_thread(repo_root: Path, thread_id: str) -> dict[str, Any] | None:
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        row = conn.execute("SELECT * FROM agent_threads WHERE id = ? LIMIT 1", (tid,)).fetchone()
        return _agent_row_to_dict(row) if row else None
    finally:
        conn.close()


def _agent_list_threads(
    repo_root: Path,
    *,
    user_id: str | None = None,
    project_scope: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    try:
        safe_limit = max(1, min(500, int(limit)))
    except Exception:
        safe_limit = 100
    try:
        safe_offset = max(0, int(offset))
    except Exception:
        safe_offset = 0
    normalized_user = str(user_id or "").strip()
    normalized_project = str(project_scope or "").strip()
    clauses: list[str] = []
    params: list[Any] = []
    if normalized_user:
        clauses.append("user_id = ?")
        params.append(_agent_normalize_user_id(normalized_user))
    if normalized_project:
        clauses.append("project_scope = ?")
        params.append(_agent_normalize_project_scope(normalized_project))
    sql = "SELECT * FROM agent_threads"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?"
    params.extend([safe_limit, safe_offset])
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(sql, tuple(params)).fetchall()
        return [_agent_row_to_dict(row) for row in rows]
    finally:
        conn.close()


def _agent_list_messages(
    repo_root: Path,
    *,
    thread_id: str | None = None,
    run_id: str | None = None,
    limit: int = 500,
    offset: int = 0,
) -> list[dict[str, Any]]:
    try:
        safe_limit = max(1, min(1000, int(limit)))
    except Exception:
        safe_limit = 500
    try:
        safe_offset = max(0, int(offset))
    except Exception:
        safe_offset = 0
    normalized_thread = str(thread_id or "").strip()
    normalized_run = str(run_id or "").strip()
    clauses: list[str] = []
    params: list[Any] = []
    if normalized_thread:
        clauses.append("thread_id = ?")
        params.append(normalized_thread)
    if normalized_run:
        clauses.append("run_id = ?")
        params.append(normalized_run)
    sql = "SELECT * FROM agent_messages"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY created_at ASC LIMIT ? OFFSET ?"
    params.extend([safe_limit, safe_offset])
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(sql, tuple(params)).fetchall()
        return [_agent_row_to_dict(row) for row in rows]
    finally:
        conn.close()


def _agent_append_message(
    repo_root: Path,
    *,
    thread_id: str,
    role: str,
    content: str,
    run_id: str | None = None,
    provider: str | None = None,
    metadata: dict[str, Any] | None = None,
    message_id: str | None = None,
) -> dict[str, Any]:
    tid = str(thread_id or "").strip()
    if not tid:
        raise ValueError("thread_id is required")
    rid = str(run_id or "").strip() or None
    msg_id = str(message_id or "").strip() or _agent_new_id("agent_msg")
    now = _now_s()
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            """
            INSERT INTO agent_messages(
                id, thread_id, run_id, role, provider, content, metadata_json, created_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                msg_id,
                tid,
                rid,
                str(role or "assistant"),
                str(provider or "").strip() or None,
                str(content or "").strip(),
                _agent_json_dumps(metadata if isinstance(metadata, dict) else {}),
                now,
            ),
        )
        conn.execute("UPDATE agent_threads SET updated_at = ? WHERE id = ?", (now, tid))
        row = conn.execute("SELECT * FROM agent_messages WHERE id = ? LIMIT 1", (msg_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError("Failed to persist agent message")
    return _agent_row_to_dict(row)


def _agent_create_run(
    repo_root: Path,
    *,
    thread_id: str,
    user_id: str,
    project_scope: str,
    source: str,
    provider: str,
    provider_id: str | None,
    model_ref: str | None,
    agent_profile_id: str | None,
    auth_profile_id: str | None,
    prompt: str,
    context: dict[str, Any] | None,
    model: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    rid = str(run_id or "").strip() or _agent_new_id("agent_run")
    now = _now_s()
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            """
            INSERT INTO agent_runs(
                id, thread_id, user_id, project_scope, source, provider, provider_id, model_ref, agent_profile_id,
                auth_profile_id, worker_id, status, prompt, context_json, model, error, retry_count, created_at,
                started_at, heartbeat_at, lease_expires_at, cancel_requested_at, finished_at, interrupted_reason, updated_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', ?, ?, ?, NULL, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
            """,
            (
                rid,
                str(thread_id or "").strip(),
                _agent_normalize_user_id(user_id),
                _agent_normalize_project_scope(project_scope),
                str(source or "chat"),
                _agent_normalize_provider(provider) or "codex",
                _agent_normalize_provider(provider_id or provider) or "codex",
                _agent_normalize_model_ref(model_ref, fallback_provider=provider_id or provider or "codex") or None,
                str(agent_profile_id or "").strip() or None,
                str(auth_profile_id or "").strip() or None,
                str(prompt or "").strip(),
                _agent_json_dumps(context if isinstance(context, dict) else {}),
                str(model or "").strip() or None,
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM agent_runs WHERE id = ? LIMIT 1", (rid,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError("Failed to create agent run")
    return _agent_row_to_dict(row)


def _agent_get_run(repo_root: Path, run_id: str) -> dict[str, Any] | None:
    rid = str(run_id or "").strip()
    if not rid:
        return None
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        row = conn.execute("SELECT * FROM agent_runs WHERE id = ? LIMIT 1", (rid,)).fetchone()
        return _agent_row_to_dict(row) if row else None
    finally:
        conn.close()


def _agent_lease_deadline_s(now_s: float | None = None) -> float:
    base = float(now_s if now_s is not None else _now_s())
    return base + _AGENT_RUN_LEASE_TTL_SECONDS


def _agent_interrupt_run(repo_root: Path, run_id: str, reason: str) -> dict[str, Any] | None:
    rid = str(run_id or "").strip()
    if not rid:
        return None
    run = _agent_get_run(repo_root, rid)
    if not run:
        return None
    status = str(run.get("status") or "").strip().lower()
    if status != "running":
        return run
    _agent_update_run(
        repo_root,
        rid,
        {
            "status": "interrupted",
            "error": str(reason or "").strip() or None,
            "lease_expires_at": None,
            "heartbeat_at": _now_s(),
            "worker_id": None,
            "finished_at": _now_s(),
            "interrupted_reason": str(reason or "").strip() or "Run worker lease expired.",
        },
    )
    updated = _agent_get_run(repo_root, rid) or run
    _agent_emit_run_event(
        rid,
        "run.status",
        _agent_compact_run_payload(updated),
        event_id=f"run-{rid}-interrupted",
    )
    return updated


def _agent_reconcile_stale_runs(repo_root: Path, run_id: str | None = None) -> int:
    now = _now_s()
    where = ["status = 'running'"]
    params: list[Any] = []
    if run_id:
        where.append("id = ?")
        params.append(str(run_id).strip())
    where_clause = " AND ".join(where)
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(
            f"""
            SELECT * FROM agent_runs
            WHERE {where_clause}
            """,
            tuple(params),
        ).fetchall()
    finally:
        conn.close()
    interrupted = 0
    for row in rows:
        run = _agent_row_to_dict(row)
        lease_expires_at = float(run.get("lease_expires_at") or 0.0)
        started_at = float(run.get("started_at") or run.get("created_at") or 0.0)
        heartbeat_at = float(run.get("heartbeat_at") or started_at or 0.0)
        if lease_expires_at > now:
            continue
        if lease_expires_at <= 0.0 and heartbeat_at > 0.0 and (now - heartbeat_at) <= _AGENT_RUN_LEASE_TTL_SECONDS:
            continue
        _agent_interrupt_run(repo_root, str(run.get("id") or ""), "Run worker lease expired before completion.")
        interrupted += 1
    return interrupted


def _agent_heartbeat_run(
    repo_root: Path,
    run_id: str,
    worker_id: str | None,
    *,
    force: bool = False,
) -> dict[str, Any] | None:
    rid = str(run_id or "").strip()
    if not rid:
        return None
    run = _agent_get_run(repo_root, rid)
    if not run:
        return None
    if worker_id:
        current_worker = str(run.get("worker_id") or "").strip()
        if current_worker and current_worker != str(worker_id).strip():
            return run
    now = _now_s()
    last_heartbeat = float(run.get("heartbeat_at") or 0.0)
    if not force and last_heartbeat > 0.0 and (now - last_heartbeat) < _AGENT_RUN_HEARTBEAT_THROTTLE_SECONDS:
        return run
    _agent_update_run(
        repo_root,
        rid,
        {
            "heartbeat_at": now,
            "lease_expires_at": _agent_lease_deadline_s(now),
            "worker_id": str(worker_id or "").strip() or None,
        },
    )
    return _agent_get_run(repo_root, rid) or run


def _agent_list_runs(
    repo_root: Path,
    *,
    user_id: str | None = None,
    project_scope: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    _agent_reconcile_stale_runs(repo_root)
    next_limit = max(1, min(500, int(limit)))
    next_offset = max(0, int(offset))
    where: list[str] = []
    params: list[Any] = []
    if user_id:
        where.append("user_id = ?")
        params.append(_agent_normalize_user_id(user_id))
    if project_scope:
        where.append("project_scope = ?")
        params.append(_agent_normalize_project_scope(project_scope))
    where_clause = f"WHERE {' AND '.join(where)}" if where else ""
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(
            f"""
            SELECT * FROM agent_runs
            {where_clause}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (*params, next_limit, next_offset),
        ).fetchall()
        return [_agent_row_to_dict(row) for row in rows]
    finally:
        conn.close()


def _agent_update_run(repo_root: Path, run_id: str, fields: dict[str, Any]):
    rid = str(run_id or "").strip()
    if not rid or not isinstance(fields, dict) or not fields:
        return
    payload = dict(fields)
    payload["updated_at"] = _now_s()
    keys = [key for key in payload.keys()]
    values = [payload[key] for key in keys]
    assignments = ", ".join([f"{key} = ?" for key in keys])
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            f"UPDATE agent_runs SET {assignments} WHERE id = ?",
            (*values, rid),
        )
    finally:
        conn.close()


def _agent_next_sequence_index(repo_root: Path, run_id: str) -> int:
    rid = str(run_id or "").strip()
    if not rid:
        return 0
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        row = conn.execute(
            "SELECT MAX(sequence_index) AS max_seq FROM agent_actions WHERE run_id = ?",
            (rid,),
        ).fetchone()
        max_seq = 0
        if row:
            try:
                max_seq = int(row["max_seq"] or 0)
            except Exception:
                max_seq = 0
        return max_seq + 1
    finally:
        conn.close()


def _agent_action_signature(tool_name: str, args: dict[str, Any]) -> tuple[str, str]:
    tool = str(tool_name or "").strip()
    payload = args if isinstance(args, dict) else {}
    target_scope = "*"
    changed_fields: list[str] = []

    if tool in {"uts_update_task", "uts_delete_task"}:
        target_scope = str(payload.get("taskId") or payload.get("task_id") or "*")
    elif tool in {"uts_bulk_update_tasks"}:
        updates = payload.get("updates")
        if isinstance(updates, list) and updates:
            first = updates[0] if isinstance(updates[0], dict) else {}
            target_scope = str(first.get("taskId") or "*")
            if isinstance(first.get("updates"), dict):
                changed_fields = sorted([str(key) for key in first["updates"].keys()])
    elif tool in {"uts_create_task"}:
        task_data = payload.get("taskData")
        if isinstance(task_data, dict):
            changed_fields = sorted([str(key) for key in task_data.keys()])
        target_scope = f"project:{payload.get('projectId') or 'default'}"
    elif tool in {"uts_update_endeavor", "uts_delete_endeavor", "uts_add_tasks_to_endeavor", "uts_remove_tasks_from_endeavor"}:
        endeavor_id = str(payload.get("endeavorId") or payload.get("endeavor_id") or "").strip()
        target_scope = f"endeavor:{endeavor_id or '*'}"
    elif tool == "uts_clear_endeavor":
        endeavor_id = str(payload.get("endeavorId") or payload.get("endeavor_id") or "").strip()
        target_scope = f"endeavor:{endeavor_id or '*'}:clear"
    elif tool == "uts_create_endeavor":
        endeavor_data = payload.get("endeavorData")
        if isinstance(endeavor_data, dict):
            project_name = str(endeavor_data.get("project") or "").strip()
            target_scope = f"project:{project_name or 'default'}"
            changed_fields = sorted([str(key) for key in endeavor_data.keys()])
        else:
            target_scope = "project:default"
    elif tool in {"uts_add_task_note", "uts_get_task_note_threads", "uts_open_task_notes"}:
        task_id = str(payload.get("taskId") or payload.get("task_id") or "").strip()
        target_scope = f"task:{task_id or '*'}:notes"
        if tool == "uts_add_task_note":
            changed_fields = ["content"]
            attachments = payload.get("attachments")
            if isinstance(attachments, list) and attachments:
                changed_fields.append("attachments")
    elif tool in {"uts_get_task_note_thread", "uts_reply_task_note"}:
        task_id = str(payload.get("taskId") or payload.get("task_id") or "").strip()
        thread_id = str(payload.get("threadId") or payload.get("thread_id") or "").strip()
        target_scope = f"task:{task_id or '*'}:notes:{thread_id or '*'}"
        if tool == "uts_reply_task_note":
            changed_fields = ["content"]
            attachments = payload.get("attachments")
            if isinstance(attachments, list) and attachments:
                changed_fields.append("attachments")
    elif tool == "uts_set_view_mode":
        mode = str(payload.get("mode") or "").strip()
        target_scope = f"view:{mode or '*'}"
        changed_fields = ["mode"]
    elif tool == "uts_select_task":
        task_id = str(payload.get("taskId") or payload.get("task_id") or "").strip()
        target_scope = f"task:{task_id or '*'}:selection"
        changed_fields = ["taskId"]
    elif tool == "uts_create_milestone":
        milestone_id = str(payload.get("id") or payload.get("milestoneId") or payload.get("milestone_id") or "").strip()
        title = str(payload.get("title") or "").strip()
        target_scope = f"milestone:{milestone_id or title or '*'}"
        changed_fields = sorted([str(key) for key in payload.keys() if key != "confirm"])
    elif tool in {"uts_update_milestone", "uts_delete_milestone"}:
        milestone_id = str(payload.get("milestoneId") or payload.get("milestone_id") or "").strip()
        target_scope = f"milestone:{milestone_id or '*'}"
    elif tool in {"uts_get_task_dependencies", "uts_add_task_dependency"}:
        task_id = str(payload.get("taskId") or payload.get("task_id") or "").strip()
        blocker_task_id = str(payload.get("blockerTaskId") or payload.get("blocker_task_id") or "").strip()
        target_scope = f"task:{task_id or '*'}:dependencies"
        if blocker_task_id:
            target_scope = f"{target_scope}:{blocker_task_id}"
        if tool == "uts_add_task_dependency":
            changed_fields = ["blockerTaskId"]
    elif tool == "uts_remove_task_dependency":
        dependency_id = str(payload.get("dependencyId") or payload.get("dependency_id") or "").strip()
        target_scope = f"dependency:{dependency_id or '*'}"
        changed_fields = ["dependencyId"]
    elif tool in {"uts_get_task_blockers", "uts_create_task_blocker"}:
        task_id = str(payload.get("taskId") or payload.get("task_id") or "").strip()
        target_scope = f"task:{task_id or '*'}:blockers"
        if tool == "uts_create_task_blocker":
            blocker_data = payload.get("blockerData")
            if isinstance(blocker_data, dict):
                changed_fields = sorted([str(key) for key in blocker_data.keys()])
    elif tool in {"uts_update_task_blocker", "uts_delete_task_blocker"}:
        blocker_id = str(payload.get("blockerId") or payload.get("blocker_id") or "").strip()
        target_scope = f"blocker:{blocker_id or '*'}"

    if tool == "uts_update_task":
        updates = payload.get("updates")
        if isinstance(updates, dict):
            changed_fields = sorted([str(key) for key in updates.keys()])
    elif tool == "uts_update_endeavor":
        updates = payload.get("updates")
        if isinstance(updates, dict):
            changed_fields = sorted([str(key) for key in updates.keys()])
    elif tool == "uts_update_milestone":
        updates = payload.get("updates")
        if isinstance(updates, dict):
            changed_fields = sorted([str(key) for key in updates.keys()])
    elif tool == "uts_update_task_blocker":
        updates = payload.get("updates")
        if isinstance(updates, dict):
            changed_fields = sorted([str(key) for key in updates.keys()])
    if not changed_fields:
        changed_fields = sorted([str(key) for key in payload.keys() if key != "confirm"])

    field_signature = ",".join([field for field in changed_fields if field]) or "*"
    return str(target_scope or "*"), field_signature


def _agent_create_action(
    repo_root: Path,
    *,
    run_id: str,
    sequence_index: int,
    tool_name: str,
    args: dict[str, Any],
    status: str = "proposed",
    preview_json: Any = None,
    preview_ok: bool | None = None,
    retry_of_action_id: str | None = None,
    retry_count: int = 0,
    action_id: str | None = None,
) -> dict[str, Any]:
    rid = str(run_id or "").strip()
    if not rid:
        raise ValueError("run_id is required")
    action_id_value = str(action_id or "").strip() or _agent_new_id("agent_action")
    target_scope, field_signature = _agent_action_signature(tool_name, args)
    now = _now_s()
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            """
            INSERT INTO agent_actions(
                id, run_id, sequence_index, tool_name, args_json, target_scope, field_signature,
                preview_json, preview_ok, status, decision, decision_by, decision_at, applied_json,
                failure_reason, retry_of_action_id, retry_count, created_at, updated_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
            """,
            (
                action_id_value,
                rid,
                int(sequence_index),
                str(tool_name or "").strip(),
                _agent_json_dumps(args if isinstance(args, dict) else {}),
                target_scope,
                field_signature,
                _agent_json_dumps(preview_json) if preview_json is not None else None,
                1 if preview_ok is True else (0 if preview_ok is False else None),
                str(status or "proposed"),
                str(retry_of_action_id or "").strip() or None,
                int(retry_count or 0),
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM agent_actions WHERE id = ? LIMIT 1", (action_id_value,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError("Failed to create agent action")
    return _agent_row_to_dict(row)


def _agent_get_action(repo_root: Path, action_id: str) -> dict[str, Any] | None:
    aid = str(action_id or "").strip()
    if not aid:
        return None
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        row = conn.execute("SELECT * FROM agent_actions WHERE id = ? LIMIT 1", (aid,)).fetchone()
        return _agent_row_to_dict(row) if row else None
    finally:
        conn.close()


def _agent_list_actions(
    repo_root: Path,
    *,
    run_id: str | None = None,
    status: str | None = None,
    user_id: str | None = None,
    project_scope: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict[str, Any]]:
    _agent_reconcile_stale_runs(repo_root, run_id=run_id if run_id else None)
    next_limit = max(1, min(500, int(limit)))
    next_offset = max(0, int(offset))
    where: list[str] = []
    params: list[Any] = []
    from_clause = "FROM agent_actions AS actions"
    if run_id:
        where.append("actions.run_id = ?")
        params.append(str(run_id))
    if status:
        where.append("actions.status = ?")
        params.append(str(status))
    if user_id or project_scope:
        from_clause += " JOIN agent_runs AS runs ON runs.id = actions.run_id"
        if user_id:
            where.append("runs.user_id = ?")
            params.append(_agent_normalize_user_id(user_id))
        if project_scope:
            where.append("runs.project_scope = ?")
            params.append(_agent_normalize_project_scope(project_scope))
    where_clause = f"WHERE {' AND '.join(where)}" if where else ""
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(
            f"""
            SELECT actions.* {from_clause}
            {where_clause}
            ORDER BY actions.created_at DESC, actions.sequence_index ASC
            LIMIT ? OFFSET ?
            """,
            (*params, next_limit, next_offset),
        ).fetchall()
        return [_agent_row_to_dict(row) for row in rows]
    finally:
        conn.close()


def _agent_update_action(repo_root: Path, action_id: str, fields: dict[str, Any]):
    aid = str(action_id or "").strip()
    if not aid or not isinstance(fields, dict) or not fields:
        return
    payload = dict(fields)
    payload["updated_at"] = _now_s()
    keys = [key for key in payload.keys()]
    values = [payload[key] for key in keys]
    assignments = ", ".join([f"{key} = ?" for key in keys])
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            f"UPDATE agent_actions SET {assignments} WHERE id = ?",
            (*values, aid),
        )
    finally:
        conn.close()


def _agent_normalize_permission(value: Any, *, fallback: str = "trust") -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"allow", "deny", "trust"}:
        return normalized
    return fallback


def _agent_list_trust_rules(
    repo_root: Path,
    *,
    user_id: str | None = None,
    project_scope: str | None = None,
    active_only: bool = True,
) -> list[dict[str, Any]]:
    where: list[str] = []
    params: list[Any] = []
    if user_id:
        where.append("user_id = ?")
        params.append(_agent_normalize_user_id(user_id))
    if project_scope:
        where.append("project_scope = ?")
        params.append(_agent_normalize_project_scope(project_scope))
    where.append("(permission = 'trust' OR permission IS NULL OR permission = '')")
    if active_only:
        where.append("active = 1")
    where_clause = f"WHERE {' AND '.join(where)}" if where else ""
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(
            f"""
            SELECT * FROM agent_trust_rules
            {where_clause}
            ORDER BY created_at DESC
            """,
            tuple(params),
        ).fetchall()
        return [_agent_row_to_dict(row) for row in rows]
    finally:
        conn.close()


def _agent_list_tool_permissions(
    repo_root: Path,
    *,
    user_id: str | None = None,
    project_scope: str | None = None,
    active_only: bool = True,
) -> list[dict[str, Any]]:
    where: list[str] = []
    params: list[Any] = []
    if user_id:
        where.append("user_id = ?")
        params.append(_agent_normalize_user_id(user_id))
    if project_scope:
        where.append("project_scope = ?")
        params.append(_agent_normalize_project_scope(project_scope))
    if active_only:
        where.append("active = 1")
    where_clause = f"WHERE {' AND '.join(where)}" if where else ""
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(
            f"""
            SELECT * FROM agent_trust_rules
            {where_clause}
            ORDER BY created_at DESC
            """,
            tuple(params),
        ).fetchall()
        normalized_rows = [_agent_row_to_dict(row) for row in rows]
        for row in normalized_rows:
            row["permission"] = _agent_normalize_permission(row.get("permission"))
        return normalized_rows
    finally:
        conn.close()


def _agent_set_tool_permission(
    repo_root: Path,
    *,
    user_id: str,
    project_scope: str,
    tool_name: str,
    permission: str,
    agent_profile_id: str | None = None,
    field_signature: str | None = None,
    target_scope: str | None = None,
) -> dict[str, Any]:
    normalized_permission = _agent_normalize_permission(permission)
    normalized_tool = str(tool_name or "").strip()
    if not normalized_tool:
        raise ValueError("tool_name is required")
    if normalized_tool in _AGENT_DESTRUCTIVE_TOOLS and normalized_permission in {"allow", "trust"}:
        raise ValueError(f"{normalized_permission.title()} is not allowed for destructive tools.")
    if normalized_permission == "trust" and not _agent_is_trustable_tool(normalized_tool):
        raise ValueError("Trust is not allowed for destructive tools.")
    now = _now_s()
    rule_id = _agent_new_id("agent_permission")
    normalized_user = _agent_normalize_user_id(user_id)
    normalized_project = _agent_normalize_project_scope(project_scope)
    normalized_profile = str(agent_profile_id or "").strip() or None
    normalized_field_signature = str(field_signature or "*").strip() or "*"
    normalized_target_scope = str(target_scope or "*").strip() or "*"
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            """
            UPDATE agent_trust_rules
            SET active = 0, revoked_at = ?
            WHERE user_id = ? AND project_scope = ? AND tool_name = ? AND active = 1
              AND COALESCE(NULLIF(agent_profile_id, ''), '*') = ?
              AND COALESCE(NULLIF(field_signature, ''), '*') = ?
              AND COALESCE(NULLIF(target_scope, ''), '*') = ?
            """,
            (
                now,
                normalized_user,
                normalized_project,
                normalized_tool,
                normalized_profile or "*",
                normalized_field_signature,
                normalized_target_scope,
            ),
        )
        conn.execute(
            """
            INSERT INTO agent_trust_rules(
                id, user_id, project_scope, agent_profile_id, tool_name,
                field_signature, target_scope, permission, active, created_at, revoked_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)
            """,
            (
                rule_id,
                normalized_user,
                normalized_project,
                normalized_profile,
                normalized_tool,
                normalized_field_signature,
                normalized_target_scope,
                normalized_permission,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM agent_trust_rules WHERE id = ? LIMIT 1", (rule_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError("Failed to store tool permission")
    payload = _agent_row_to_dict(row)
    payload["permission"] = normalized_permission
    return payload


def _agent_create_trust_rule(
    repo_root: Path,
    *,
    user_id: str,
    project_scope: str,
    agent_profile_id: str | None,
    tool_name: str,
    field_signature: str,
    target_scope: str,
) -> dict[str, Any]:
    return _agent_set_tool_permission(
        repo_root,
        user_id=user_id,
        project_scope=project_scope,
        agent_profile_id=agent_profile_id,
        tool_name=tool_name,
        permission="trust",
        field_signature=field_signature,
        target_scope=target_scope,
    )


def _agent_revoke_trust_rule(
    repo_root: Path,
    *,
    rule_id: str | None = None,
    user_id: str | None = None,
    project_scope: str | None = None,
    tool_name: str | None = None,
    agent_profile_id: str | None = None,
    field_signature: str | None = None,
    target_scope: str | None = None,
) -> int:
    conditions: list[str] = ["active = 1"]
    params: list[Any] = []
    if rule_id:
        conditions.append("id = ?")
        params.append(str(rule_id).strip())
    if user_id:
        conditions.append("user_id = ?")
        params.append(_agent_normalize_user_id(user_id))
    if project_scope:
        conditions.append("project_scope = ?")
        params.append(_agent_normalize_project_scope(project_scope))
    if tool_name:
        conditions.append("tool_name = ?")
        params.append(str(tool_name).strip())
    if agent_profile_id:
        conditions.append("COALESCE(NULLIF(agent_profile_id, ''), '*') = ?")
        params.append(str(agent_profile_id).strip() or "*")
    if field_signature:
        conditions.append("COALESCE(NULLIF(field_signature, ''), '*') = ?")
        params.append(str(field_signature).strip() or "*")
    if target_scope:
        conditions.append("COALESCE(NULLIF(target_scope, ''), '*') = ?")
        params.append(str(target_scope).strip() or "*")
    if not conditions:
        return 0
    where_clause = " AND ".join(conditions)
    now = _now_s()
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        cur = conn.execute(
            f"""
            UPDATE agent_trust_rules
            SET active = 0, revoked_at = ?
            WHERE {where_clause}
            """,
            (now, *params),
        )
        return int(cur.rowcount or 0)
    finally:
        conn.close()


def _agent_find_matching_trust_rule(
    repo_root: Path,
    *,
    user_id: str,
    project_scope: str,
    tool_name: str,
    field_signature: str,
    target_scope: str,
    agent_profile_id: str | None = None,
) -> dict[str, Any] | None:
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    normalized_user = _agent_normalize_user_id(user_id)
    normalized_project = _agent_normalize_project_scope(project_scope)
    tool = str(tool_name or "").strip()
    field_sig = str(field_signature or "*")
    target = str(target_scope or "*")
    profile = str(agent_profile_id or "").strip()
    try:
        rows = conn.execute(
            """
            SELECT * FROM agent_trust_rules
            WHERE active = 1
              AND user_id = ?
              AND project_scope = ?
              AND tool_name = ?
              AND COALESCE(NULLIF(permission, ''), 'trust') IN ('allow', 'deny', 'trust')
              AND (field_signature = ? OR field_signature = '*' OR field_signature IS NULL)
              AND (target_scope = ? OR target_scope = '*' OR target_scope IS NULL)
              AND (agent_profile_id IS NULL OR agent_profile_id = '' OR agent_profile_id = '*' OR agent_profile_id = ?)
            ORDER BY
              CASE WHEN agent_profile_id = ? THEN 0 ELSE 1 END,
              CASE WHEN field_signature = ? THEN 0 ELSE 1 END,
              CASE WHEN target_scope = ? THEN 0 ELSE 1 END,
              CASE WHEN COALESCE(NULLIF(permission, ''), 'trust') = 'deny' THEN 0 ELSE 1 END,
              created_at DESC
            LIMIT 1
            """,
            (
                normalized_user,
                normalized_project,
                tool,
                field_sig,
                target,
                profile,
                profile,
                field_sig,
                target,
            ),
        ).fetchall()
        if not rows:
            return None
        payload = _agent_row_to_dict(rows[0])
        payload["permission"] = _agent_normalize_permission(payload.get("permission"))
        return payload
    finally:
        conn.close()


def _agent_is_trustable_tool(tool_name: str) -> bool:
    tool = str(tool_name or "").strip()
    return bool(tool) and tool not in _AGENT_DESTRUCTIVE_TOOLS


def _agent_run_action_counts(repo_root: Path, run_id: str) -> dict[str, int]:
    rid = str(run_id or "").strip()
    if not rid:
        return {}
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(
            """
            SELECT status, COUNT(*) AS count
            FROM agent_actions
            WHERE run_id = ?
            GROUP BY status
            """,
            (rid,),
        ).fetchall()
        result: dict[str, int] = {}
        for row in rows:
            status = str(row["status"] or "").strip()
            if not status:
                continue
            try:
                result[status] = int(row["count"] or 0)
            except Exception:
                result[status] = 0
        return result
    finally:
        conn.close()


def _agent_recompute_run_status(repo_root: Path, run_id: str) -> str:
    counts = _agent_run_action_counts(repo_root, run_id)
    failed = counts.get("failed", 0)
    applied = counts.get("applied", 0)
    proposed = counts.get("proposed", 0)
    queued = counts.get("queued", 0)
    previewing = counts.get("previewing", 0)
    if failed > 0:
        next_status = "partial_failed" if applied > 0 else "failed"
    elif proposed > 0 or queued > 0 or previewing > 0:
        next_status = "waiting_approval"
    else:
        next_status = "completed"
    update_fields: dict[str, Any] = {"status": next_status}
    if next_status in {"completed", "failed", "partial_failed"}:
        update_fields["finished_at"] = _now_s()
    _agent_update_run(repo_root, run_id, update_fields)
    return next_status


def _agent_message_context_payload(message: dict[str, Any]) -> dict[str, Any]:
    metadata = _agent_json_loads(message.get("metadata_json"), {})
    if not isinstance(metadata, dict):
        metadata = {}
    return {
        "id": str(message.get("id") or ""),
        "role": str(message.get("role") or "assistant"),
        "provider_id": _agent_normalize_provider(message.get("provider") or ""),
        "content": str(message.get("content") or ""),
        "metadata": metadata,
        "created_at": message.get("created_at"),
    }


def _agent_action_context_payload(action: dict[str, Any]) -> dict[str, Any]:
    args = _agent_json_loads(action.get("args_json"), {})
    preview = _agent_json_loads(action.get("preview_json"), None)
    applied = _agent_json_loads(action.get("applied_json"), None)
    payload: dict[str, Any] = {
        "id": str(action.get("id") or ""),
        "sequence_index": int(action.get("sequence_index") or 0),
        "toolName": str(action.get("tool_name") or ""),
        "status": str(action.get("status") or ""),
        "decision": str(action.get("decision") or "").strip() or None,
        "args": args if isinstance(args, dict) else {},
        "target_scope": str(action.get("target_scope") or "*"),
        "field_signature": str(action.get("field_signature") or "*"),
        "failure_reason": str(action.get("failure_reason") or "").strip() or None,
        "created_at": action.get("created_at"),
        "updated_at": action.get("updated_at"),
    }
    if preview is not None:
        payload["preview"] = preview
    if applied is not None:
        payload["result"] = applied
    return payload


def _agent_build_run_context(repo_root: Path, run: dict[str, Any]) -> dict[str, Any]:
    run_context = _agent_json_loads(run.get("context_json"), {})
    if not isinstance(run_context, dict):
        run_context = {}

    merged_context: dict[str, Any] = {}
    thread = _agent_get_thread(repo_root, str(run.get("thread_id") or ""))
    if thread:
        thread_context = _agent_json_loads(thread.get("context_json"), {})
        if isinstance(thread_context, dict):
            merged_context.update(thread_context)
    merged_context.update(run_context)

    thread_id = str(run.get("thread_id") or "").strip()
    if thread_id:
        messages = _agent_list_messages(repo_root, thread_id=thread_id, limit=500, offset=0)
        if messages:
            merged_context["thread_messages"] = [
                _agent_message_context_payload(message)
                for message in messages[-40:]
            ]

    run_id = str(run.get("id") or "").strip()
    if run_id:
        actions = _agent_list_actions(repo_root, run_id=run_id, limit=500, offset=0)
        if actions:
            ordered_actions = sorted(
                actions,
                key=lambda row: (
                    int(row.get("sequence_index") or 0),
                    str(row.get("created_at") or ""),
                    str(row.get("id") or ""),
                ),
            )
            completed_actions: list[dict[str, Any]] = []
            pending_actions: list[dict[str, Any]] = []
            for action in ordered_actions:
                status = str(action.get("status") or "").strip()
                payload = _agent_action_context_payload(action)
                if status in {"applied", "failed", "rejected", "superseded"}:
                    completed_actions.append(payload)
                elif status in {"queued", "previewing", "proposed", "trusted"}:
                    pending_actions.append(payload)
            if completed_actions:
                trimmed_completed = completed_actions[-24:]
                merged_context["completed_actions"] = trimmed_completed
                merged_context["latest_action_result"] = trimmed_completed[-1]
            if pending_actions:
                merged_context["pending_actions"] = pending_actions[-8:]

    merged_context["run_state"] = {
        "run_id": str(run.get("id") or ""),
        "status": str(run.get("status") or ""),
        "provider_id": _agent_normalize_provider(run.get("provider_id") or run.get("provider") or ""),
        "model_ref": _agent_normalize_model_ref(run.get("model_ref"), fallback_provider=run.get("provider_id") or run.get("provider") or "codex"),
        "prompt": str(run.get("prompt") or ""),
    }
    return merged_context


def _agent_run_limit_usage(repo_root: Path, run_id: str) -> dict[str, Any]:
    actions = _agent_list_actions(repo_root, run_id=run_id, limit=500, offset=0)
    total_tool_calls = 0
    for action in actions:
        status = str(action.get("status") or "").strip()
        if status in {"proposed", "applied", "failed", "rejected", "trusted", "superseded"}:
            total_tool_calls += 1
        applied = _agent_json_loads(action.get("applied_json"), None)
        if applied is not None:
            total_tool_calls += 1
    return {
        "actions": len(actions),
        "tool_calls": total_tool_calls,
        "rows": actions,
    }


def _agent_supersede_pending_actions(
    repo_root: Path,
    run_id: str,
    *,
    except_action_id: str | None = None,
    reason: str = "Superseded after a later approved action resumed the run.",
) -> list[dict[str, Any]]:
    rid = str(run_id or "").strip()
    if not rid:
        return []
    skip_id = str(except_action_id or "").strip()
    now = _now_s()
    updated_rows: list[dict[str, Any]] = []
    for action in _agent_list_actions(repo_root, run_id=rid, limit=500, offset=0):
        action_id = str(action.get("id") or "").strip()
        status = str(action.get("status") or "").strip()
        if not action_id or action_id == skip_id:
            continue
        if status not in {"queued", "previewing", "proposed", "trusted"}:
            continue
        _agent_update_action(
            repo_root,
            action_id,
            {
                "status": "superseded",
                "decision": "supersede",
                "decision_by": "system:resume",
                "decision_at": now,
                "failure_reason": reason,
            },
        )
        updated_rows.append(_agent_get_action(repo_root, action_id) or action)
    if updated_rows:
        _agent_emit_run_event(
            rid,
            "actions.snapshot",
            {
                "ok": True,
                "run_id": rid,
                "actions": [_agent_compact_action_payload(action) for action in updated_rows],
            },
            event_id=f"run-{rid}-actions-superseded",
        )
    return updated_rows


def _agent_resume_run(
    repo_root: Path,
    run_id: str,
    *,
    allowed_statuses: set[str] | None = None,
) -> dict[str, Any] | None:
    rid = str(run_id or "").strip()
    if not rid:
        return None
    _agent_reconcile_stale_runs(repo_root, run_id=rid)
    run = _agent_get_run(repo_root, rid)
    if not run:
        return None
    current_status = str(run.get("status") or "").strip().lower()
    if isinstance(allowed_statuses, set) and current_status not in allowed_statuses:
        return None
    _agent_update_run(
        repo_root,
        rid,
        {
            "status": "queued",
            "error": None,
            "finished_at": None,
            "cancel_requested_at": None,
            "worker_id": None,
            "heartbeat_at": None,
            "lease_expires_at": None,
            "interrupted_reason": None,
        },
    )
    updated = _agent_get_run(repo_root, rid) or run
    _agent_emit_run_event(
        rid,
        "run.status",
        _agent_compact_run_payload(updated),
        event_id=f"run-{rid}-queued-resume",
    )
    _agent_start_run_worker(repo_root, rid)
    return updated


def _agent_retry_run_from_last_safe_point(repo_root: Path, run_id: str) -> dict[str, Any] | None:
    return _agent_resume_run(repo_root, run_id, allowed_statuses={"failed", "partial_failed"})


def _agent_cancel_run(
    repo_root: Path,
    *,
    run_id: str,
    user_id: str,
    project_scope: str,
) -> dict[str, Any]:
    rid = str(run_id or "").strip()
    if not rid:
        raise ValueError("run_id is required")
    run = _agent_get_run(repo_root, rid)
    if not run:
        raise ValueError("Run not found")
    normalized_user_id = _agent_normalize_user_id(user_id)
    normalized_project_scope = _agent_normalize_project_scope(project_scope)
    if normalized_user_id and str(run.get("user_id") or "").strip() != normalized_user_id:
        raise ValueError("Run not found")
    if normalized_project_scope and str(run.get("project_scope") or "").strip() != normalized_project_scope:
        raise ValueError("Run not found")
    status = str(run.get("status") or "").strip().lower()
    if status in {"completed", "failed", "partial_failed", "canceled"}:
        return {
            "ok": False,
            "error": "Run is no longer active.",
            "run": _agent_compact_run_payload(run),
        }
    now = _now_s()
    with _AGENT_RUN_STREAM_LOCK:
        cancel_event = _AGENT_RUN_CANCEL_EVENTS.get(rid)
        if cancel_event is None:
            cancel_event = threading.Event()
            _AGENT_RUN_CANCEL_EVENTS[rid] = cancel_event
        cancel_event.set()
    _agent_update_run(
        repo_root,
        rid,
        {
            "cancel_requested_at": now,
        },
    )
    if status in {"queued", "waiting_approval", "interrupted"}:
        _agent_update_run(
            repo_root,
            rid,
            {
                "status": "canceled",
                "error": "Run canceled by user.",
                "finished_at": now,
                "heartbeat_at": now,
                "lease_expires_at": None,
                "worker_id": None,
            },
        )
    _agent_insert_audit(
        repo_root,
        user_id=normalized_user_id or user_id or "local-user",
        run_id=rid,
        action_id=None,
        event_type="run.cancel_requested",
        payload={"project_scope": normalized_project_scope or project_scope or "global"},
    )
    updated = _agent_get_run(repo_root, rid) or run
    _agent_emit_run_event(
        rid,
        "run.status",
        _agent_compact_run_payload(updated),
        event_id=f"run-{rid}-cancel-requested",
    )
    return {
        "ok": True,
        "requested": True,
        "run": _agent_compact_run_payload(updated),
    }


def _agent_normalize_proposed_actions(actions: Any, max_actions: int) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    if not isinstance(actions, list):
        return normalized
    for item in actions:
        if len(normalized) >= max_actions:
            break
        if not isinstance(item, dict):
            continue
        tool_name = str(item.get("toolName") or item.get("tool_name") or "").strip()
        args = item.get("args")
        if not tool_name or not isinstance(args, dict):
            continue
        normalized.append({"toolName": tool_name, "args": args})
    return normalized


def _agent_extract_structured_output(raw_content: str, *, max_actions: int) -> dict[str, Any]:
    text = str(raw_content or "").strip()
    if not text:
        return {"assistant": "", "actions": []}

    parsed: dict[str, Any] | None = None
    fenced = re.search(r"```json\s*(\{[\s\S]*?\})\s*```", text, flags=re.IGNORECASE)
    if fenced:
        candidate = _agent_json_loads(fenced.group(1), {})
        if isinstance(candidate, dict):
            parsed = candidate
    if parsed is None:
        direct = _agent_json_loads(text, {})
        if isinstance(direct, dict):
            parsed = direct

    if isinstance(parsed, dict):
        assistant = str(parsed.get("assistant") or parsed.get("message") or "").strip()
        actions = _agent_normalize_proposed_actions(parsed.get("actions"), max_actions)
        return {"assistant": assistant, "actions": actions}

    preview = _agent_preview_assistant_text(text).strip()
    partial_actions = _agent_extract_partial_actions(text, max_actions=max_actions)
    if preview or partial_actions:
        return {"assistant": preview, "actions": partial_actions}
    return {"assistant": text if not text.startswith("{") else "", "actions": []}


def _agent_structured_output_has_content(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if str(value.get("assistant") or "").strip():
        return True
    actions = value.get("actions")
    if not isinstance(actions, list):
        return False
    for item in actions:
        if not isinstance(item, dict):
            continue
        tool_name = str(item.get("toolName") or item.get("tool_name") or "").strip()
        if not tool_name:
            continue
        if isinstance(item.get("args"), dict):
            return True
    return False


def _agent_run_failure_message_text(error: Any, *, partial: bool = False) -> str:
    detail = str(error or "").strip()
    prefix = (
        "The run stopped after applying part of the work."
        if partial
        else "The run stopped before it could finish."
    )
    if not detail:
        return prefix
    return f"{prefix} {detail}"


def _agent_append_run_failure_message(
    repo_root: Path,
    *,
    run: dict[str, Any],
    error: Any,
    partial: bool = False,
    provider_id: str | None = None,
    model: str | None = None,
    model_ref: str | None = None,
):
    thread_id = str(run.get("thread_id") or "").strip()
    run_id = str(run.get("id") or "").strip()
    if not thread_id or not run_id:
        return
    resolved_provider = _agent_normalize_provider(provider_id or run.get("provider_id") or run.get("provider") or "codex") or "codex"
    resolved_model_ref = _agent_normalize_model_ref(model_ref or run.get("model_ref"), fallback_provider=resolved_provider)
    metadata = {
        "kind": "run_error",
        "error": str(error or "").strip(),
        "partial": partial is True,
        "provider_id": resolved_provider,
        "model_ref": resolved_model_ref,
    }
    if str(model or "").strip():
        metadata["model"] = str(model).strip()
    try:
        message = _agent_append_message(
            repo_root,
            thread_id=thread_id,
            role="assistant",
            content=_agent_run_failure_message_text(error, partial=partial),
            run_id=run_id,
            provider=resolved_provider,
            metadata=metadata,
        )
        _agent_emit_run_event(
            run_id,
            "message.assistant",
            {
                "id": str(message.get("id") or ""),
                "thread_id": str(message.get("thread_id") or ""),
                "run_id": run_id,
                "content": str(message.get("content") or ""),
                "created_at": message.get("created_at"),
            },
            event_id=f"run-{run_id}-assistant-error-message",
        )
    except Exception:
        if _debug_enabled():
            _log(traceback.format_exc())


def _agent_extract_partial_json_string_value(raw_content: str, field_name: str) -> str | None:
    text = str(raw_content or "")
    key = str(field_name or "").strip()
    if not text or not key:
        return None
    match = re.search(rf'"{re.escape(key)}"\s*:\s*"', text)
    if not match:
        return None

    decoded: list[str] = []
    escape = False
    unicode_pending = 0
    unicode_buffer = ""
    index = match.end()
    while index < len(text):
        char = text[index]
        if unicode_pending > 0:
            if char.lower() in "0123456789abcdef":
                unicode_buffer += char
                unicode_pending -= 1
                if unicode_pending == 0:
                    try:
                        decoded.append(chr(int(unicode_buffer, 16)))
                    except Exception:
                        pass
                    unicode_buffer = ""
                index += 1
                continue
            break
        if escape:
            escape = False
            if char == "u":
                unicode_pending = 4
                unicode_buffer = ""
                index += 1
                continue
            decoded.append(
                {
                    '"': '"',
                    "\\": "\\",
                    "/": "/",
                    "b": "\b",
                    "f": "\f",
                    "n": "\n",
                    "r": "\r",
                    "t": "\t",
                }.get(char, char)
            )
            index += 1
            continue
        if char == "\\":
            escape = True
            index += 1
            continue
        if char == '"':
            return "".join(decoded)
        decoded.append(char)
        index += 1
    return "".join(decoded)


def _agent_preview_assistant_text(raw_content: str) -> str:
    text = str(raw_content or "")
    for field_name in ("assistant", "message"):
        preview = _agent_extract_partial_json_string_value(text, field_name)
        if preview is not None:
            return preview
    stripped = text.strip()
    if stripped and not stripped.startswith("{"):
        return stripped
    return ""


def _agent_extract_partial_actions(raw_content: str, *, max_actions: int) -> list[dict[str, Any]]:
    text = str(raw_content or "")
    match = re.search(r'"actions"\s*:\s*\[', text)
    if not match:
        return []
    index = match.end()
    depth = 0
    start_index: int | None = None
    in_string = False
    escape = False
    extracted: list[dict[str, Any]] = []
    while index < len(text):
        char = text[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            index += 1
            continue
        if char == "{":
            if depth == 0:
                start_index = index
            depth += 1
            index += 1
            continue
        if char == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start_index is not None:
                    candidate = _agent_json_loads(text[start_index:index + 1], None)
                    if isinstance(candidate, dict):
                        extracted.append(candidate)
                        if len(extracted) >= max_actions:
                            break
                    start_index = None
            index += 1
            continue
        if char == "]" and depth == 0:
            break
        index += 1
    return _agent_normalize_proposed_actions(extracted, max_actions)


def _agent_compact_run_payload(run: dict[str, Any]) -> dict[str, Any]:
    provider_id = _agent_normalize_provider(run.get("provider_id") or run.get("provider") or "")
    model_ref = _agent_normalize_model_ref(run.get("model_ref"), fallback_provider=provider_id or "codex")
    return {
        "id": str(run.get("id") or ""),
        "thread_id": str(run.get("thread_id") or ""),
        "user_id": str(run.get("user_id") or ""),
        "project_scope": str(run.get("project_scope") or ""),
        "source": str(run.get("source") or ""),
        "provider_id": provider_id,
        "provider": provider_id,
        "providerLabel": _agent_provider_title(provider_id),
        "model_ref": model_ref,
        "agent_profile_id": str(run.get("agent_profile_id") or "").strip() or None,
        "auth_profile_id": str(run.get("auth_profile_id") or "").strip() or None,
        "worker_id": str(run.get("worker_id") or "").strip() or None,
        "model": str(run.get("model") or "").strip() or None,
        "status": str(run.get("status") or ""),
        "prompt": str(run.get("prompt") or ""),
        "error": run.get("error"),
        "created_at": run.get("created_at"),
        "started_at": run.get("started_at"),
        "heartbeat_at": run.get("heartbeat_at"),
        "lease_expires_at": run.get("lease_expires_at"),
        "cancel_requested_at": run.get("cancel_requested_at"),
        "finished_at": run.get("finished_at"),
        "interrupted_reason": str(run.get("interrupted_reason") or "").strip() or None,
        "updated_at": run.get("updated_at"),
    }


def _agent_compact_message_payload(message: dict[str, Any]) -> dict[str, Any]:
    provider_id = _agent_normalize_provider(message.get("provider") or "")
    metadata = _agent_json_loads(message.get("metadata_json"), {})
    if not isinstance(metadata, dict):
        metadata = {}
    return {
        "id": str(message.get("id") or ""),
        "thread_id": str(message.get("thread_id") or ""),
        "run_id": str(message.get("run_id") or ""),
        "role": str(message.get("role") or "assistant"),
        "provider_id": provider_id,
        "provider": provider_id,
        "content": str(message.get("content") or ""),
        "metadata": metadata,
        "created_at": message.get("created_at"),
    }


def _agent_compact_thread_payload(thread: dict[str, Any], *, messages: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    provider_id = _agent_normalize_provider(thread.get("provider_id") or thread.get("provider") or "")
    model_ref = _agent_normalize_model_ref(thread.get("model_ref"), fallback_provider=provider_id or "codex")
    payload = {
        "id": str(thread.get("id") or ""),
        "user_id": str(thread.get("user_id") or ""),
        "project_scope": str(thread.get("project_scope") or ""),
        "source": str(thread.get("source") or ""),
        "task_id": str(thread.get("task_id") or "").strip() or None,
        "title": str(thread.get("title") or "").strip(),
        "provider_id": provider_id,
        "provider": provider_id,
        "providerLabel": _agent_provider_title(provider_id),
        "model_ref": model_ref,
        "created_at": thread.get("created_at"),
        "updated_at": thread.get("updated_at"),
    }
    if messages is not None:
        payload["messages"] = [_agent_compact_message_payload(message) for message in messages]
    return payload


def _agent_compact_action_payload(action: dict[str, Any]) -> dict[str, Any]:
    args = _agent_json_loads(action.get("args_json"), {})
    preview = _agent_json_loads(action.get("preview_json"), None)
    applied = _agent_json_loads(action.get("applied_json"), None)
    return {
        "id": str(action.get("id") or ""),
        "run_id": str(action.get("run_id") or ""),
        "sequence_index": int(action.get("sequence_index") or 0),
        "tool_name": str(action.get("tool_name") or ""),
        "args": args if isinstance(args, dict) else {},
        "target_scope": str(action.get("target_scope") or "*"),
        "field_signature": str(action.get("field_signature") or "*"),
        "preview": preview,
        "preview_ok": action.get("preview_ok"),
        "status": str(action.get("status") or ""),
        "decision": action.get("decision"),
        "decision_by": action.get("decision_by"),
        "decision_at": action.get("decision_at"),
        "applied": applied,
        "failure_reason": action.get("failure_reason"),
        "retry_of_action_id": action.get("retry_of_action_id"),
        "retry_count": int(action.get("retry_count") or 0),
        "created_at": action.get("created_at"),
        "updated_at": action.get("updated_at"),
        "trust_allowed": _agent_is_trustable_tool(str(action.get("tool_name") or "")),
    }


def _agent_test_openai_key(api_key: str) -> tuple[bool, str]:
    key = str(api_key or "").strip()
    if not key:
        return False, "OpenAI API key is required."
    ok, status, payload, raw = _agent_http_json(
        url="https://api.openai.com/v1/models?limit=1",
        method="GET",
        headers={"Authorization": f"Bearer {key}"},
        timeout_s=12.0,
    )
    if ok and status == 200:
        return True, "OpenAI API key is valid."
    message = ""
    error_payload = payload.get("error")
    if isinstance(error_payload, dict):
        message = str(error_payload.get("message") or "").strip()
    if not message:
        message = str(payload.get("error") or raw or f"HTTP {status}").strip()
    return False, message or "OpenAI key test failed."


def _agent_test_anthropic_key(api_key: str) -> tuple[bool, str]:
    key = str(api_key or "").strip()
    if not key:
        return False, "Anthropic API key is required."
    ok, status, payload, raw = _agent_http_json(
        url="https://api.anthropic.com/v1/models",
        method="GET",
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
        timeout_s=12.0,
    )
    if ok and status == 200:
        return True, "Anthropic API key is valid."
    message = str(payload.get("error") or raw or f"HTTP {status}").strip()
    if isinstance(payload.get("error"), dict):
        message = str(payload["error"].get("message") or message).strip()
    return False, message or "Anthropic key test failed."


def _agent_test_gemini_key(api_key: str) -> tuple[bool, str]:
    key = str(api_key or "").strip()
    if not key:
        return False, "Google AI API key is required."
    ok, status, payload, raw = _agent_http_json(
        url=f"https://generativelanguage.googleapis.com/v1beta/models?{urlencode({'key': key})}",
        method="GET",
        timeout_s=12.0,
    )
    if ok and status == 200:
        return True, "Google AI API key is valid."
    message = ""
    error_payload = payload.get("error")
    if isinstance(error_payload, dict):
        message = str(error_payload.get("message") or "").strip()
    if not message:
        message = str(payload.get("error") or raw or f"HTTP {status}").strip()
    return False, message or "Gemini key test failed."


def _agent_provider_system_prompt(available_tools: list[str]) -> str:
    tool_list = ", ".join(available_tools) if available_tools else "(no tools discovered)"
    return (
        "You are the UP TO SPEED Agent Hub planner.\n"
        "Return a JSON object only. Do not include markdown fences.\n"
        'Emit the "assistant" field before "actions" so clients can preview the reply while JSON is still streaming.\n'
        "Schema:\n"
        "{\n"
        '  "assistant": "short helpful response",\n'
        '  "actions": [\n'
        '    { "toolName": "uts_update_task", "args": { ... } }\n'
        "  ]\n"
        "}\n"
        "Actions must use known MCP tools and include complete args.\n"
        "Context may include thread_messages plus completed_actions with tool results from earlier steps.\n"
        "Use completed_actions and latest_action_result to continue the run after approved tools.\n"
        "Do not repeat a tool call that already succeeded unless the result is clearly insufficient.\n"
        "Use serial safe actions. Prefer read operations when uncertain.\n"
        'The "assistant" string is rendered as markdown in the Agent chat.\n'
        "Use markdown deliberately: short headings, bullet lists, numbered steps, bold, inline code, blockquotes, small tables, and fenced code blocks when they improve scanning.\n"
        "Prefer compact lists over dense prose. Keep tables narrow and only use them for genuinely tabular data.\n"
        "Lead with the answer or status, then supporting details. Use short label lines such as Summary:, Risks:, or Next: when helpful.\n"
        "When referencing a board task the user may want to inspect, format it as a markdown link with the task id, for example [Comp cleanup](task://1234). Those links open task details in the app.\n"
        "When referencing task notes, use [Comp cleanup notes](task-notes://1234).\n"
        "When referencing an endeavor, use [Weekly comp push](endeavor://endeavor-123).\n"
        "Do not invent ids or internal links. Only emit task://, task-notes://, or endeavor:// links when the id is present in the provided context or tool results.\n"
        "Do not dump raw large JSON into the assistant field unless the user explicitly asked for it. Summarize first.\n"
        f"Known tools: {tool_list}\n"
    )


def _agent_iter_sse_messages(stream: Any):
    event_name = ""
    data_lines: list[str] = []
    while True:
        raw_line = stream.readline()
        if not raw_line:
            break
        if isinstance(raw_line, bytes):
            line = raw_line.decode("utf-8", errors="replace")
        else:
            line = str(raw_line)
        line = line.rstrip("\r\n")
        if not line:
            if data_lines:
                yield event_name or "message", "\n".join(data_lines)
                event_name = ""
                data_lines = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line.split(":", 1)[1].strip()
            continue
        if line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].lstrip())
    if data_lines:
        yield event_name or "message", "\n".join(data_lines)


def _agent_provider_codex_cli_prompt(
    *,
    prompt: str,
    context: dict[str, Any],
    available_tools: list[str],
) -> str:
    user_payload = {
        "prompt": str(prompt or ""),
        "context": context if isinstance(context, dict) else {},
    }
    return (
        _agent_provider_system_prompt(available_tools)
        + "\nUser request payload (JSON):\n"
        + _agent_json_dumps(user_payload)
        + "\n\nReturn only the JSON object described above."
    )


def _agent_provider_codex_cli_generate(
    repo_root: Path,
    *,
    prompt: str,
    context: dict[str, Any],
    max_actions: int,
    model: str,
    available_tools: list[str],
    on_output_delta: Callable[[str], None] | None = None,
    on_progress_event: Callable[[dict[str, Any]], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    ok_path, path_or_error = _agent_codex_cli_available()
    if not ok_path:
        raise RuntimeError(path_or_error)
    timeout_s = 75
    try:
        timeout_s = max(15, min(600, int(_env("UTS_AGENT_CODEX_CLI_TIMEOUT_S", default="75") or "75")))
    except Exception:
        timeout_s = 75

    output_fd, output_file = tempfile.mkstemp(prefix="agent-codex-last-", suffix=".txt")
    try:
        os.close(output_fd)
    except Exception:
        pass
    output_path = Path(output_file)
    output_path.write_text("", encoding="utf-8")
    cmd = [
        path_or_error,
        "exec",
        "--json",
        "--output-last-message",
        str(output_path),
        "--color",
        "never",
    ]
    chosen_model = str(model or "").strip()
    if chosen_model:
        cmd.extend(["--model", chosen_model])
    cmd.append(
        _agent_provider_codex_cli_prompt(
            prompt=prompt,
            context=context,
            available_tools=available_tools,
        )
    )
    process: subprocess.Popen[str] | None = None
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    pending_agent_message: dict[str, Any] | None = None
    last_output_snapshot = ""
    stable_structured_since = 0.0
    stable_structured: dict[str, Any] | None = None

    def _emit_progress(payload: dict[str, Any] | None):
        if not callable(on_progress_event) or not isinstance(payload, dict):
            return
        on_progress_event(payload)

    def _flush_pending_agent_message(*, final_message: str = ""):
        nonlocal pending_agent_message
        if not pending_agent_message:
            return
        pending_text = str(pending_agent_message.get("text") or "").strip()
        if pending_text and pending_text != str(final_message or "").strip():
            _emit_progress(dict(pending_agent_message))
        pending_agent_message = None

    def _progress_status(event_type: str, item: dict[str, Any]) -> str:
        explicit = str(item.get("status") or "").strip().lower()
        if explicit:
            return explicit
        if event_type == "item.started":
            return "in_progress"
        if event_type == "item.failed":
            return "failed"
        if event_type == "item.completed":
            return "completed"
        if event_type == "item.updated":
            return "in_progress"
        return ""

    def _progress_payload_for(event_type: str, item: dict[str, Any]) -> dict[str, Any] | None:
        item_type = str(item.get("type") or "").strip()
        item_id = str(item.get("id") or "").strip()
        if not item_type or not item_id:
            return None
        status = _progress_status(event_type, item)
        if item_type == "agent_message":
            text = str(item.get("text") or "").strip()
            if not text:
                return None
            return {
                "item_id": item_id,
                "item_type": item_type,
                "status": status or "completed",
                "text": text,
                "updated_at": _agent_now_iso(),
            }
        if item_type == "command_execution":
            command = str(item.get("command") or "").strip()
            if not command:
                return None
            aggregated_output, output_truncated = _agent_truncate_text(item.get("aggregated_output") or "", limit=2000)
            exit_code = item.get("exit_code")
            try:
                exit_code = int(exit_code) if exit_code is not None and str(exit_code).strip() != "" else None
            except Exception:
                exit_code = None
            return {
                "item_id": item_id,
                "item_type": item_type,
                "status": status or "in_progress",
                "command": command,
                "aggregated_output": aggregated_output,
                "output_truncated": output_truncated,
                "exit_code": exit_code,
                "updated_at": _agent_now_iso(),
            }
        return None

    def _handle_output_line(cleaned: str, *, from_stderr: bool):
        nonlocal pending_agent_message
        if not cleaned:
            return
        if from_stderr:
            stderr_lines.append(cleaned)
            return
        stdout_lines.append(cleaned)
        event = _agent_json_loads(cleaned, None)
        if not isinstance(event, dict):
            return
        item = event.get("item") if isinstance(event.get("item"), dict) else None
        event_type = str(event.get("type") or "").strip()
        if not item or not event_type.startswith("item."):
            return
        progress_payload = _progress_payload_for(event_type, item)
        if not progress_payload:
            return
        if str(progress_payload.get("item_type") or "") == "agent_message":
            _flush_pending_agent_message()
            pending_agent_message = progress_payload
            return
        _flush_pending_agent_message()
        _emit_progress(progress_payload)

    def _stop_process(*, force: bool = False):
        if process is None or process.poll() is not None:
            return
        try:
            if force:
                process.kill()
            else:
                process.terminate()
        except Exception:
            pass

    def _read_structured_output_snapshot() -> tuple[str, dict[str, Any] | None]:
        nonlocal last_output_snapshot, stable_structured_since, stable_structured
        try:
            raw_snapshot = output_path.read_text(encoding="utf-8", errors="replace").strip()
        except Exception:
            raw_snapshot = ""
        changed = raw_snapshot != last_output_snapshot
        if changed and callable(on_output_delta) and raw_snapshot:
            if raw_snapshot.startswith(last_output_snapshot):
                delta_text = raw_snapshot[len(last_output_snapshot):]
                if delta_text:
                    on_output_delta(delta_text)
            elif not last_output_snapshot:
                on_output_delta(raw_snapshot)
        if changed:
            last_output_snapshot = raw_snapshot
        structured = _agent_extract_structured_output(raw_snapshot, max_actions=max_actions) if raw_snapshot else None
        if _agent_structured_output_has_content(structured):
            stable_structured = structured
            if changed or stable_structured_since <= 0.0:
                stable_structured_since = time.monotonic()
            return raw_snapshot, structured
        stable_structured_since = 0.0
        return raw_snapshot, None

    def _structured_result_payload(structured: dict[str, Any] | None) -> dict[str, Any]:
        payload = structured if isinstance(structured, dict) else {}
        return {
            "assistant": payload.get("assistant") or "",
            "actions": payload.get("actions") or [],
            "model": chosen_model or "codex_cli",
        }

    try:
        process = subprocess.Popen(
            cmd,
            cwd=str(repo_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if process.stdout is None or process.stderr is None:
            raise RuntimeError("Codex CLI provider streams are unavailable")
        deadline = time.monotonic() + timeout_s
        while True:
            if callable(should_cancel) and should_cancel():
                _flush_pending_agent_message()
                _stop_process(force=True)
                raise _AgentRunCanceled("Run canceled by user.")
            raw_snapshot, structured_snapshot = _read_structured_output_snapshot()
            if (
                process.poll() is None
                and structured_snapshot
                and stable_structured_since > 0.0
                and (time.monotonic() - stable_structured_since) >= 0.4
            ):
                _flush_pending_agent_message(final_message=raw_snapshot)
                _stop_process(force=False)
                if process.poll() is None:
                    try:
                        process.wait(timeout=0.5)
                    except subprocess.TimeoutExpired:
                        _stop_process(force=True)
                return _structured_result_payload(structured_snapshot)
            if process.poll() is not None:
                ready, _, _ = select.select([process.stdout, process.stderr], [], [], 0)
                if not ready:
                    break
            remaining_s = deadline - time.monotonic()
            if remaining_s <= 0:
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout_s)
            ready, _, _ = select.select(
                [process.stdout, process.stderr],
                [],
                [],
                max(0.05, min(0.25, remaining_s)),
            )
            if not ready:
                continue
            for stream in ready:
                line = stream.readline()
                if not line:
                    continue
                cleaned = _agent_strip_ansi(line).strip()
                _handle_output_line(cleaned, from_stderr=stream is process.stderr)
        for extra_line in process.stdout.readlines():
            if callable(should_cancel) and should_cancel():
                raise _AgentRunCanceled("Run canceled by user.")
            _handle_output_line(_agent_strip_ansi(extra_line).strip(), from_stderr=False)
        for extra_line in process.stderr.readlines():
            if callable(should_cancel) and should_cancel():
                raise _AgentRunCanceled("Run canceled by user.")
            _handle_output_line(_agent_strip_ansi(extra_line).strip(), from_stderr=True)
        return_code = process.wait(timeout=2.0)
        last_message, structured = _read_structured_output_snapshot()
        _flush_pending_agent_message(final_message=last_message)
        if return_code != 0:
            if _agent_structured_output_has_content(structured):
                return _structured_result_payload(structured)
            message = _agent_codex_exec_error(
                "\n".join(stdout_lines),
                "\n".join(stderr_lines),
                fallback=f"Codex CLI exited with status {return_code}",
            )
            raise RuntimeError(message or "Codex CLI provider call failed")
        return _structured_result_payload(structured)
    except subprocess.TimeoutExpired as exc:
        raw_snapshot, structured_snapshot = _read_structured_output_snapshot()
        _flush_pending_agent_message(final_message=raw_snapshot)
        _stop_process(force=True)
        if _agent_structured_output_has_content(structured_snapshot or stable_structured):
            return _structured_result_payload(structured_snapshot or stable_structured)
        raise RuntimeError(f"Codex CLI timed out after {timeout_s}s") from exc
    finally:
        if process is not None:
            try:
                if process.stdout is not None:
                    process.stdout.close()
            except Exception:
                pass
            try:
                if process.stderr is not None:
                    process.stderr.close()
            except Exception:
                pass
            if process.poll() is None:
                try:
                    process.kill()
                except Exception:
                    pass
        try:
            output_path.unlink()
        except Exception:
            pass


def _agent_provider_openai_generate(
    *,
    api_key: str,
    prompt: str,
    context: dict[str, Any],
    max_actions: int,
    model: str,
    available_tools: list[str],
    on_output_delta: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    req_payload = {
        "model": model,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": _agent_provider_system_prompt(available_tools)},
            {
                "role": "user",
                "content": _agent_json_dumps(
                    {
                        "prompt": prompt,
                        "context": context if isinstance(context, dict) else {},
                    }
                ),
            },
        ],
    }
    content = ""
    if callable(on_output_delta):
        req_payload["stream"] = True
        body = _agent_json_dumps(req_payload).encode("utf-8")
        req = Request(
            "https://api.openai.com/v1/chat/completions",
            data=body,
            method="POST",
        )
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", f"Bearer {api_key}")
        try:
            with urlopen(req, timeout=90.0) as res:
                streamed_parts: list[str] = []
                for _event_name, data in _agent_iter_sse_messages(res):
                    if callable(should_cancel) and should_cancel():
                        raise _AgentRunCanceled("Run canceled by user.")
                    if data == "[DONE]":
                        break
                    payload = _agent_json_loads(data, {})
                    if not isinstance(payload, dict):
                        continue
                    choices = payload.get("choices")
                    if not isinstance(choices, list) or not choices:
                        continue
                    first = choices[0] if isinstance(choices[0], dict) else {}
                    delta = first.get("delta") if isinstance(first.get("delta"), dict) else {}
                    piece = str(delta.get("content") or "")
                    if not piece:
                        continue
                    streamed_parts.append(piece)
                    on_output_delta(piece)
                content = "".join(streamed_parts).strip()
        except HTTPError as exc:
            try:
                raw = exc.read().decode("utf-8", errors="replace")
            except Exception:
                raw = ""
            parsed = _agent_json_loads(raw, {})
            if not isinstance(parsed, dict):
                parsed = {}
            message = ""
            err = parsed.get("error")
            if isinstance(err, dict):
                message = str(err.get("message") or "").strip()
            if not message:
                message = str(parsed.get("error") or raw or f"HTTP {int(exc.code or 0)}").strip()
            raise RuntimeError(message or "OpenAI provider call failed") from exc
        except URLError as exc:
            raise RuntimeError(str(exc.reason or exc)) from exc
        except Exception as exc:
            raise RuntimeError(str(exc)) from exc
    else:
        if callable(should_cancel) and should_cancel():
            raise _AgentRunCanceled("Run canceled by user.")
        ok, status, parsed, raw = _agent_http_json(
            url="https://api.openai.com/v1/chat/completions",
            method="POST",
            payload=req_payload,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout_s=60.0,
        )
        if not ok or status != 200:
            message = ""
            err = parsed.get("error")
            if isinstance(err, dict):
                message = str(err.get("message") or "").strip()
            if not message:
                message = str(parsed.get("error") or raw or f"HTTP {status}").strip()
            raise RuntimeError(message or "OpenAI provider call failed")

        choices = parsed.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0] if isinstance(choices[0], dict) else {}
            message = first.get("message") if isinstance(first.get("message"), dict) else {}
            content = str(message.get("content") or "").strip()
    structured = _agent_extract_structured_output(content, max_actions=max_actions)
    return {
        "assistant": structured.get("assistant") or "",
        "actions": structured.get("actions") or [],
        "model": model,
    }


def _agent_provider_anthropic_generate(
    *,
    api_key: str,
    prompt: str,
    context: dict[str, Any],
    max_actions: int,
    model: str,
    available_tools: list[str],
    on_output_delta: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    req_payload = {
        "model": model,
        "max_tokens": 1024,
        "temperature": 0.1,
        "system": _agent_provider_system_prompt(available_tools),
        "messages": [
            {
                "role": "user",
                "content": _agent_json_dumps(
                    {
                        "prompt": prompt,
                        "context": context if isinstance(context, dict) else {},
                    }
                ),
            }
        ],
    }
    content = ""
    if callable(on_output_delta):
        req_payload["stream"] = True
        body = _agent_json_dumps(req_payload).encode("utf-8")
        req = Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            method="POST",
        )
        req.add_header("Content-Type", "application/json")
        req.add_header("x-api-key", api_key)
        req.add_header("anthropic-version", "2023-06-01")
        try:
            with urlopen(req, timeout=90.0) as res:
                text_parts: list[str] = []
                for event_name, data in _agent_iter_sse_messages(res):
                    if callable(should_cancel) and should_cancel():
                        raise _AgentRunCanceled("Run canceled by user.")
                    payload = _agent_json_loads(data, {})
                    if not isinstance(payload, dict):
                        continue
                    if event_name == "error" or str(payload.get("type") or "") == "error":
                        error_payload = payload.get("error") if isinstance(payload.get("error"), dict) else {}
                        message = str(error_payload.get("message") or payload.get("error") or data).strip()
                        raise RuntimeError(message or "Anthropic provider call failed")
                    if event_name != "content_block_delta" and str(payload.get("type") or "") != "content_block_delta":
                        continue
                    delta = payload.get("delta") if isinstance(payload.get("delta"), dict) else {}
                    if str(delta.get("type") or "") != "text_delta":
                        continue
                    piece = str(delta.get("text") or "")
                    if not piece:
                        continue
                    text_parts.append(piece)
                    on_output_delta(piece)
                content = "".join(text_parts).strip()
        except HTTPError as exc:
            try:
                raw = exc.read().decode("utf-8", errors="replace")
            except Exception:
                raw = ""
            parsed = _agent_json_loads(raw, {})
            if not isinstance(parsed, dict):
                parsed = {}
            message = ""
            err = parsed.get("error")
            if isinstance(err, dict):
                message = str(err.get("message") or "").strip()
            if not message:
                message = str(parsed.get("error") or raw or f"HTTP {int(exc.code or 0)}").strip()
            raise RuntimeError(message or "Anthropic provider call failed") from exc
        except URLError as exc:
            raise RuntimeError(str(exc.reason or exc)) from exc
        except Exception as exc:
            raise RuntimeError(str(exc)) from exc
    else:
        if callable(should_cancel) and should_cancel():
            raise _AgentRunCanceled("Run canceled by user.")
        ok, status, parsed, raw = _agent_http_json(
            url="https://api.anthropic.com/v1/messages",
            method="POST",
            payload=req_payload,
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            timeout_s=60.0,
        )
        if not ok or status != 200:
            message = ""
            err = parsed.get("error")
            if isinstance(err, dict):
                message = str(err.get("message") or "").strip()
            if not message:
                message = str(parsed.get("error") or raw or f"HTTP {status}").strip()
            raise RuntimeError(message or "Anthropic provider call failed")

        parts = parsed.get("content")
        text_parts: list[str] = []
        if isinstance(parts, list):
            for part in parts:
                if not isinstance(part, dict):
                    continue
                if str(part.get("type") or "") == "text":
                    text_parts.append(str(part.get("text") or ""))
        content = "\n".join([item for item in text_parts if item]).strip()
    structured = _agent_extract_structured_output(content, max_actions=max_actions)
    return {
        "assistant": structured.get("assistant") or "",
        "actions": structured.get("actions") or [],
        "model": model,
    }


def _agent_provider_gemini_generate(
    *,
    api_key: str,
    prompt: str,
    context: dict[str, Any],
    max_actions: int,
    model: str,
    available_tools: list[str],
    on_output_delta: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    req_payload = {
        "systemInstruction": {
            "parts": [
                {
                    "text": _agent_provider_system_prompt(available_tools),
                }
            ]
        },
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": _agent_json_dumps(
                            {
                                "prompt": prompt,
                                "context": context if isinstance(context, dict) else {},
                            }
                        )
                    }
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
        },
    }
    content = ""
    if callable(on_output_delta):
        body = _agent_json_dumps(req_payload).encode("utf-8")
        req = Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?{urlencode({'alt': 'sse', 'key': api_key})}",
            data=body,
            method="POST",
        )
        req.add_header("Content-Type", "application/json")
        try:
            with urlopen(req, timeout=90.0) as res:
                text_parts: list[str] = []
                for _event_name, data in _agent_iter_sse_messages(res):
                    if callable(should_cancel) and should_cancel():
                        raise _AgentRunCanceled("Run canceled by user.")
                    payload = _agent_json_loads(data, {})
                    if not isinstance(payload, dict):
                        continue
                    error_payload = payload.get("error")
                    if isinstance(error_payload, dict):
                        message = str(error_payload.get("message") or data).strip()
                        raise RuntimeError(message or "Gemini provider call failed")
                    candidates = payload.get("candidates")
                    if not isinstance(candidates, list) or not candidates:
                        continue
                    first = candidates[0] if isinstance(candidates[0], dict) else {}
                    candidate_content = first.get("content") if isinstance(first.get("content"), dict) else {}
                    parts = candidate_content.get("parts") if isinstance(candidate_content.get("parts"), list) else []
                    for part in parts:
                        if not isinstance(part, dict):
                            continue
                        text_value = str(part.get("text") or "")
                        if not text_value:
                            continue
                        text_parts.append(text_value)
                        on_output_delta(text_value)
                content = "".join(text_parts).strip()
        except HTTPError as exc:
            try:
                raw = exc.read().decode("utf-8", errors="replace")
            except Exception:
                raw = ""
            parsed = _agent_json_loads(raw, {})
            if not isinstance(parsed, dict):
                parsed = {}
            message = ""
            err = parsed.get("error")
            if isinstance(err, dict):
                message = str(err.get("message") or "").strip()
            if not message:
                message = str(parsed.get("error") or raw or f"HTTP {int(exc.code or 0)}").strip()
            raise RuntimeError(message or "Gemini provider call failed") from exc
        except URLError as exc:
            raise RuntimeError(str(exc.reason or exc)) from exc
        except Exception as exc:
            raise RuntimeError(str(exc)) from exc
    else:
        if callable(should_cancel) and should_cancel():
            raise _AgentRunCanceled("Run canceled by user.")
        ok, status, parsed, raw = _agent_http_json(
            url=f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?{urlencode({'key': api_key})}",
            method="POST",
            payload=req_payload,
            timeout_s=60.0,
        )
        if not ok or status != 200:
            message = ""
            err = parsed.get("error")
            if isinstance(err, dict):
                message = str(err.get("message") or "").strip()
            if not message:
                message = str(parsed.get("error") or raw or f"HTTP {status}").strip()
            raise RuntimeError(message or "Gemini provider call failed")

        candidates = parsed.get("candidates")
        text_parts: list[str] = []
        if isinstance(candidates, list) and candidates:
            first = candidates[0] if isinstance(candidates[0], dict) else {}
            candidate_content = first.get("content") if isinstance(first.get("content"), dict) else {}
            parts = candidate_content.get("parts") if isinstance(candidate_content.get("parts"), list) else []
            for part in parts:
                if not isinstance(part, dict):
                    continue
                text_value = str(part.get("text") or "").strip()
                if text_value:
                    text_parts.append(text_value)
        content = "\n".join(text_parts).strip()
    structured = _agent_extract_structured_output(content, max_actions=max_actions)
    return {
        "assistant": structured.get("assistant") or "",
        "actions": structured.get("actions") or [],
        "model": model,
    }


def _agent_adapter_generate_codex(
    repo_root: Path,
    *,
    prompt: str,
    context: dict[str, Any],
    max_actions: int,
    model_id: str,
    available_tools: list[str],
    on_output_delta: Callable[[str], None] | None = None,
    on_progress_event: Callable[[dict[str, Any]], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    connection = _agent_get_connection(repo_root, "codex") or {}
    auth_mode = str(connection.get("auth_mode") or "").strip()
    status = str(connection.get("status") or "").strip().lower()
    secret = _agent_decode_secret(connection.get("secret_ciphertext")) if connection else ""
    if auth_mode == "codex_cli":
        login_status = _agent_codex_login_status()
        if login_status.get("logged_in") is not True:
            if secret:
                return _agent_provider_openai_generate(
                    api_key=secret,
                    prompt=prompt,
                    context=context,
                    max_actions=max_actions,
                    model=_agent_builtin_default_model_ids()["openai"],
                    available_tools=available_tools,
                    on_output_delta=on_output_delta,
                    should_cancel=should_cancel,
                )
            reason = str(login_status.get("error") or "").strip()
            if not reason and status == "pending":
                reason = "Finish the Codex OAuth/device login in Settings and click Verify."
            return {
                "assistant": "Codex OAuth is not connected yet. " + (reason if reason else "Open Settings -> Agents and complete Codex OAuth."),
                "actions": [],
                "model": "codex_cli",
            }
        existing_metadata = _agent_json_loads(connection.get("metadata_json"), {})
        if not isinstance(existing_metadata, dict):
            existing_metadata = {}
        existing_metadata.update(
            {
                "verified_at": _agent_now_iso(),
                "status_output": str(login_status.get("output") or ""),
                "cli_path": str(login_status.get("cli_path") or ""),
            }
        )
        _agent_upsert_connection(
            repo_root,
            provider="codex",
            auth_mode="codex_cli",
            status="connected",
            metadata=existing_metadata,
            secret="",
            tested=True,
        )
        chosen_model = "" if model_id == "default" else model_id
        return _agent_provider_codex_cli_generate(
            repo_root,
            prompt=prompt,
            context=context,
            max_actions=max_actions,
            model=chosen_model,
            available_tools=available_tools,
            on_output_delta=on_output_delta,
            on_progress_event=on_progress_event,
            should_cancel=should_cancel,
        )

    if not secret:
        return {
            "assistant": "Codex is not connected. Open Settings -> Agents and connect Codex first.",
            "actions": [],
            "model": "none",
        }
    fallback_model = model_id if model_id and model_id != "default" else _agent_builtin_default_model_ids()["openai"]
    return _agent_provider_openai_generate(
        api_key=secret,
        prompt=prompt,
        context=context,
        max_actions=max_actions,
        model=fallback_model,
        available_tools=available_tools,
        on_output_delta=on_output_delta,
        should_cancel=should_cancel,
    )


def _agent_adapter_generate_openai(
    repo_root: Path,
    *,
    prompt: str,
    context: dict[str, Any],
    max_actions: int,
    model_id: str,
    available_tools: list[str],
    on_output_delta: Callable[[str], None] | None = None,
    on_progress_event: Callable[[dict[str, Any]], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    secret = _agent_get_connection_secret(repo_root, "openai")
    if not secret:
        raise RuntimeError("OpenAI is not connected. Open Settings -> Agents and connect OpenAI first.")
    chosen_model = model_id if model_id and model_id != "default" else _agent_builtin_default_model_ids()["openai"]
    return _agent_provider_openai_generate(
        api_key=secret,
        prompt=prompt,
        context=context,
        max_actions=max_actions,
        model=chosen_model,
        available_tools=available_tools,
        on_output_delta=on_output_delta,
        should_cancel=should_cancel,
    )


def _agent_adapter_generate_anthropic(
    repo_root: Path,
    *,
    prompt: str,
    context: dict[str, Any],
    max_actions: int,
    model_id: str,
    available_tools: list[str],
    on_output_delta: Callable[[str], None] | None = None,
    on_progress_event: Callable[[dict[str, Any]], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    secret = _agent_get_connection_secret(repo_root, "anthropic")
    if not secret:
        raise RuntimeError("Anthropic is not connected. Open Settings -> Agents and connect Anthropic first.")
    chosen_model = model_id if model_id and model_id != "default" else _agent_builtin_default_model_ids()["anthropic"]
    return _agent_provider_anthropic_generate(
        api_key=secret,
        prompt=prompt,
        context=context,
        max_actions=max_actions,
        model=chosen_model,
        available_tools=available_tools,
        on_output_delta=on_output_delta,
        should_cancel=should_cancel,
    )


def _agent_adapter_generate_gemini(
    repo_root: Path,
    *,
    prompt: str,
    context: dict[str, Any],
    max_actions: int,
    model_id: str,
    available_tools: list[str],
    on_output_delta: Callable[[str], None] | None = None,
    on_progress_event: Callable[[dict[str, Any]], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    secret = _agent_get_connection_secret(repo_root, "gemini")
    if not secret:
        raise RuntimeError("Gemini is not connected. Open Settings -> Agents and connect Gemini first.")
    chosen_model = model_id if model_id and model_id != "default" else _agent_builtin_default_model_ids()["gemini"]
    return _agent_provider_gemini_generate(
        api_key=secret,
        prompt=prompt,
        context=context,
        max_actions=max_actions,
        model=chosen_model,
        available_tools=available_tools,
        on_output_delta=on_output_delta,
        should_cancel=should_cancel,
    )


def _agent_provider_registry() -> dict[str, dict[str, Any]]:
    return {
        "codex": {
            "provider_id": "codex",
            "generate": _agent_adapter_generate_codex,
            "list_models": _agent_codex_discovered_models,
            "test_auth_modes": {
                "codex_cli": None,
                "openai_key": _agent_test_openai_key,
            },
        },
        "openai": {
            "provider_id": "openai",
            "generate": _agent_adapter_generate_openai,
            "list_models": _agent_openai_discovered_models,
            "test_auth_modes": {
                "openai_key": _agent_test_openai_key,
            },
        },
        "anthropic": {
            "provider_id": "anthropic",
            "generate": _agent_adapter_generate_anthropic,
            "list_models": _agent_anthropic_discovered_models,
            "test_auth_modes": {
                "anthropic_key": _agent_test_anthropic_key,
            },
        },
        "gemini": {
            "provider_id": "gemini",
            "generate": _agent_adapter_generate_gemini,
            "list_models": _agent_gemini_discovered_models,
            "test_auth_modes": {
                "gemini_key": _agent_test_gemini_key,
            },
        },
    }


def _agent_test_and_store_connection(
    repo_root: Path,
    *,
    provider_id: str,
    auth_mode: str,
    secret: str | None = None,
    credential_ref: str | None = None,
    profile_label: str | None = None,
) -> tuple[bool, str, dict[str, Any] | None]:
    normalized_provider = _agent_normalize_provider(provider_id)
    mode = str(auth_mode or "").strip()
    registry = _agent_provider_registry()
    provider_entry = registry.get(normalized_provider)
    if not normalized_provider or not provider_entry:
        return False, "Unsupported provider.", None
    tester = provider_entry.get("test_auth_modes", {}).get(mode) if isinstance(provider_entry.get("test_auth_modes"), dict) else None
    if normalized_provider == "codex" and mode == "codex_cli":
        ok_cli, cli_message = _agent_codex_cli_available()
        if not ok_cli:
            connection = _agent_upsert_connection(
                repo_root,
                provider="codex",
                auth_mode="codex_cli",
                status="error",
                metadata={"error": cli_message, "verified_at": _agent_now_iso()},
                tested=False,
            )
            return False, cli_message, connection
        login_status = _agent_codex_login_status()
        if login_status.get("logged_in") is True:
            connection = _agent_upsert_connection(
                repo_root,
                provider="codex",
                auth_mode="codex_cli",
                status="connected",
                metadata={
                    "verified_at": _agent_now_iso(),
                    "status_output": str(login_status.get("output") or ""),
                    "cli_path": str(login_status.get("cli_path") or ""),
                },
                secret="",
                tested=True,
            )
            return True, "Codex OAuth verified.", connection
        connection = _agent_upsert_connection(
            repo_root,
            provider="codex",
            auth_mode="codex_cli",
            status="pending",
            metadata={
                "verified_at": _agent_now_iso(),
                "status_output": str(login_status.get("output") or ""),
                "cli_path": str(login_status.get("cli_path") or ""),
                "error": str(login_status.get("error") or ""),
            },
            tested=False,
        )
        return False, str(login_status.get("error") or "Codex OAuth is not connected."), connection
    if not callable(tester):
        return False, "Unsupported auth mode.", None
    ok, message = tester(str(secret or "").strip())
    status = "connected" if ok else "error"
    connection = _agent_upsert_connection(
        repo_root,
        provider=normalized_provider,
        auth_mode=mode,
        status=status,
        metadata={"verified_at": _agent_now_iso(), "error": "" if ok else message},
        secret=str(secret or "").strip() if ok else None,
        credential_ref=credential_ref,
        profile_label=profile_label,
        tested=True,
    )
    return ok, message, connection


def _agent_resolve_model_selection(
    config: dict[str, Any],
    *,
    requested_model_ref: Any = None,
    provider_hint: Any = None,
    project_scope: Any = None,
) -> tuple[str, list[str]]:
    selected = _agent_normalize_model_ref(requested_model_ref)
    if not selected:
        selected = _agent_normalize_model_ref(provider_hint)
    if not selected and project_scope:
        project_defaults = config.get("defaultModelByProject")
        if isinstance(project_defaults, dict):
            selected = _agent_normalize_model_ref(project_defaults.get(_agent_normalize_project_scope(project_scope)))
    if not selected:
        selected = _agent_normalize_model_ref(config.get("defaultModel")) or _agent_default_model_ref_for_provider("codex")
    fallbacks: list[str] = []
    for item in config.get("fallbacks") if isinstance(config.get("fallbacks"), list) else []:
        normalized = _agent_normalize_model_ref(item)
        if not normalized or normalized == selected or normalized in fallbacks:
            continue
        fallbacks.append(normalized)
    return selected, fallbacks


def _agent_provider_generate(
    repo_root: Path,
    *,
    provider: str | None = None,
    model_ref: str | None = None,
    prompt: str,
    context: dict[str, Any],
    max_actions: int,
    project_scope: str | None = None,
    config: dict[str, Any] | None = None,
    on_output_delta: Callable[[str], None] | None = None,
    on_progress_event: Callable[[dict[str, Any]], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    effective_config = _agent_merge_config(config, None) if isinstance(config, dict) else _agent_get_config(repo_root)
    selected_model_ref, fallback_model_refs = _agent_resolve_model_selection(
        effective_config,
        requested_model_ref=model_ref,
        provider_hint=provider,
        project_scope=project_scope,
    )
    manifest = _agent_gateway_manifest()
    available_tools = [
        str(tool.get("name") or "").strip()
        for tool in (manifest.get("tools") if isinstance(manifest.get("tools"), list) else [])
        if isinstance(tool, dict) and str(tool.get("name") or "").strip()
    ]
    registry = _agent_provider_registry()
    attempts = [selected_model_ref, *fallback_model_refs]
    errors: list[str] = []
    for attempt_model_ref in attempts:
        provider_id, model_id = _agent_split_model_ref(attempt_model_ref)
        adapter = registry.get(provider_id)
        if not adapter:
            errors.append(f"Unsupported provider for {attempt_model_ref}")
            continue
        try:
            result = adapter["generate"](
                repo_root,
                prompt=prompt,
                context=context,
                max_actions=max_actions,
                model_id=model_id or "default",
                available_tools=available_tools,
                on_output_delta=on_output_delta,
                on_progress_event=on_progress_event,
                should_cancel=should_cancel,
            )
            if isinstance(result, dict):
                result["provider_id"] = provider_id
                result["model_ref"] = attempt_model_ref
            return result
        except _AgentRunCanceled:
            raise
        except Exception as exc:
            errors.append(f"{attempt_model_ref}: {exc}")
            continue
    raise RuntimeError(errors[-1] if errors else "No provider configured.")


def _agent_preview_action(repo_root: Path, action_row: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action_row.get("id") or "")
    tool_name = str(action_row.get("tool_name") or "").strip()
    args = _agent_json_loads(action_row.get("args_json"), {})
    if not isinstance(args, dict):
        args = {}
    preview = _agent_gateway_invoke(tool_name, _agent_tool_args_preview(args))
    fields = {
        "preview_json": _agent_json_dumps(preview),
        "preview_ok": 1 if preview.get("ok") is True else 0,
    }
    if preview.get("ok") is True:
        fields["status"] = "proposed"
        fields["failure_reason"] = None
    else:
        fields["status"] = "failed"
        fields["failure_reason"] = str(preview.get("error") or "Preview failed")
    _agent_update_action(repo_root, action_id, fields)
    updated = _agent_get_action(repo_root, action_id) or action_row
    _agent_emit_run_event(
        str(updated.get("run_id") or ""),
        "action.preview",
        _agent_compact_action_payload(updated),
        event_id=f"action-preview-{action_id}",
    )
    return updated


def _agent_apply_action(
    repo_root: Path,
    action_row: dict[str, Any],
    *,
    decision: str,
    decision_by: str,
) -> dict[str, Any]:
    action_id = str(action_row.get("id") or "")
    run_id = str(action_row.get("run_id") or "")
    tool_name = str(action_row.get("tool_name") or "").strip()
    args = _agent_json_loads(action_row.get("args_json"), {})
    if not isinstance(args, dict):
        args = {}
    applied = _agent_gateway_invoke(tool_name, _agent_tool_args_apply(args))
    now = _now_s()
    if applied.get("ok") is True:
        _agent_update_action(
            repo_root,
            action_id,
            {
                "status": "applied",
                "decision": str(decision or "approve"),
                "decision_by": str(decision_by or "system"),
                "decision_at": now,
                "applied_json": _agent_json_dumps(applied),
                "failure_reason": None,
            },
        )
        updated = _agent_get_action(repo_root, action_id) or action_row
        _agent_insert_audit(
            repo_root,
            user_id=decision_by,
            run_id=run_id,
            action_id=action_id,
            event_type="action.applied",
            payload={"tool": tool_name, "decision": decision},
        )
        _agent_emit_run_event(
            run_id,
            "action.applied",
            _agent_compact_action_payload(updated),
            event_id=f"action-applied-{action_id}",
        )
        return {"ok": True, "action": updated, "result": applied}

    failure = str(applied.get("error") or "Apply failed")
    _agent_update_action(
        repo_root,
        action_id,
        {
            "status": "failed",
            "decision": str(decision or "approve"),
            "decision_by": str(decision_by or "system"),
            "decision_at": now,
            "applied_json": _agent_json_dumps(applied),
            "failure_reason": failure,
        },
    )
    updated = _agent_get_action(repo_root, action_id) or action_row
    _agent_insert_audit(
        repo_root,
        user_id=decision_by,
        run_id=run_id,
        action_id=action_id,
        event_type="action.failed",
        payload={"tool": tool_name, "decision": decision, "error": failure},
    )
    _agent_emit_run_event(
        run_id,
        "action.failed",
        _agent_compact_action_payload(updated),
        event_id=f"action-failed-{action_id}",
    )
    return {"ok": False, "action": updated, "result": applied, "error": failure}


def _agent_create_retry_action(repo_root: Path, action_row: dict[str, Any]) -> dict[str, Any]:
    run_id = str(action_row.get("run_id") or "").strip()
    if not run_id:
        raise ValueError("run_id is required for retry")
    retry_count = int(action_row.get("retry_count") or 0) + 1
    args = _agent_json_loads(action_row.get("args_json"), {})
    if not isinstance(args, dict):
        args = {}
    retry_action = _agent_create_action(
        repo_root,
        run_id=run_id,
        sequence_index=_agent_next_sequence_index(repo_root, run_id),
        tool_name=str(action_row.get("tool_name") or ""),
        args=args,
        status="queued",
        retry_of_action_id=str(action_row.get("id") or ""),
        retry_count=retry_count,
    )
    previewed = _agent_preview_action(repo_root, retry_action)
    return previewed


def _agent_run_worker(repo_root: Path, run_id: str, worker_id: str):
    rid = str(run_id or "").strip()
    if not rid:
        return
    _agent_reconcile_stale_runs(repo_root, run_id=rid)
    run = _agent_get_run(repo_root, rid)
    if not run:
        return
    with _AGENT_RUN_STREAM_LOCK:
        cancel_event = _AGENT_RUN_CANCEL_EVENTS.get(rid)
        if cancel_event is None:
            cancel_event = threading.Event()
            _AGENT_RUN_CANCEL_EVENTS[rid] = cancel_event
    try:
        start_ts = _now_s()
        _agent_update_run(
            repo_root,
            rid,
            {
                "status": "running",
                "started_at": run.get("started_at") or start_ts,
                "finished_at": None,
                "error": None,
                "worker_id": worker_id,
                "heartbeat_at": start_ts,
                "lease_expires_at": _agent_lease_deadline_s(start_ts),
                "cancel_requested_at": None,
                "interrupted_reason": None,
            },
        )
        run = _agent_get_run(repo_root, rid) or run
        _agent_emit_run_event(rid, "run.status", _agent_compact_run_payload(run), event_id=f"run-{rid}-running")

        config = _agent_get_config(repo_root)
        max_actions = int(config.get("maxActionsPerRun") or _AGENT_DEFAULT_CONFIG["maxActionsPerRun"])
        max_tool_calls = int(config.get("maxToolCallsPerRun") or _AGENT_DEFAULT_CONFIG["maxToolCallsPerRun"])
        strict_limits = config.get("strictSafetyLimits") is not False
        failure_error = ""
        assistant_stream_sequence = 0
        progress_stream_sequence = 0

        def should_cancel_now() -> bool:
            latest_run = _agent_get_run(repo_root, rid) or run
            latest_worker_id = str(latest_run.get("worker_id") or "").strip()
            if latest_worker_id and latest_worker_id != worker_id:
                return True
            if cancel_event.is_set():
                return True
            if latest_run.get("cancel_requested_at") is not None:
                return True
            _agent_heartbeat_run(repo_root, rid, worker_id)
            return False

        while True:
            _agent_heartbeat_run(repo_root, rid, worker_id, force=True)
            run = _agent_get_run(repo_root, rid) or run
            if str(run.get("worker_id") or "").strip() not in {"", worker_id}:
                return
            if should_cancel_now():
                raise _AgentRunCanceled("Run canceled by user.")
            usage = _agent_run_limit_usage(repo_root, rid)

            context = _agent_build_run_context(repo_root, run)
            thread_id = str(run.get("thread_id") or "")
            provider_id = _agent_normalize_provider(run.get("provider_id") or run.get("provider") or "codex") or "codex"
            model = str(run.get("model") or "").strip() or None
            resolved_model_ref = _agent_normalize_model_ref(run.get("model_ref"), fallback_provider=provider_id) or _agent_default_model_ref_for_provider(provider_id)
            streamed_output_state = {
                "raw": "",
                "preview": "",
                "last_emitted": "",
                "last_emit_at": 0.0,
            }

            def emit_stream_preview(force: bool = False):
                nonlocal assistant_stream_sequence
                preview = _agent_preview_assistant_text(streamed_output_state["raw"])
                streamed_output_state["preview"] = preview
                if not preview:
                    return
                if preview == streamed_output_state["last_emitted"]:
                    return
                now = _now_s()
                if not force:
                    grew_by = len(preview) - len(streamed_output_state["last_emitted"])
                    if (
                        grew_by < 24
                        and (now - float(streamed_output_state["last_emit_at"] or 0.0)) < 0.08
                        and not preview.endswith(("\n", ".", "!", "?", ":"))
                    ):
                        return
                assistant_stream_sequence += 1
                streamed_output_state["last_emitted"] = preview
                streamed_output_state["last_emit_at"] = now
                _agent_emit_run_event(
                    rid,
                    "message.assistant.delta",
                    {
                        "run_id": rid,
                        "thread_id": thread_id,
                        "content": preview,
                        "updated_at": _agent_now_iso(),
                    },
                    event_id=f"run-{rid}-assistant-delta-{assistant_stream_sequence}",
                )

            def on_output_delta(delta_text: str):
                piece = str(delta_text or "")
                if not piece:
                    return
                streamed_output_state["raw"] += piece
                _agent_heartbeat_run(repo_root, rid, worker_id)
                emit_stream_preview()

            def on_progress_event(progress: dict[str, Any]):
                nonlocal progress_stream_sequence
                if not isinstance(progress, dict):
                    return
                item_id = str(progress.get("item_id") or "").strip()
                item_type = str(progress.get("item_type") or "").strip()
                if not item_id or not item_type:
                    return
                _agent_heartbeat_run(repo_root, rid, worker_id)
                progress_stream_sequence += 1
                _agent_emit_run_event(
                    rid,
                    "run.progress",
                    {
                        "run_id": rid,
                        "thread_id": thread_id,
                        "sequence": progress_stream_sequence,
                        "item_id": item_id,
                        "item_type": item_type,
                        "status": str(progress.get("status") or "").strip(),
                        "text": str(progress.get("text") or ""),
                        "command": str(progress.get("command") or ""),
                        "aggregated_output": str(progress.get("aggregated_output") or ""),
                        "output_truncated": progress.get("output_truncated") is True,
                        "exit_code": progress.get("exit_code"),
                        "updated_at": str(progress.get("updated_at") or _agent_now_iso()),
                    },
                    event_id=f"run-{rid}-progress-{progress_stream_sequence}",
                )

            def should_cancel() -> bool:
                return should_cancel_now()

            provider_result = _agent_provider_generate(
                repo_root,
                provider=str(run.get("provider_id") or run.get("provider") or "codex"),
                model_ref=str(run.get("model_ref") or "").strip() or None,
                prompt=str(run.get("prompt") or ""),
                context=context,
                max_actions=max_actions,
                project_scope=str(run.get("project_scope") or "global"),
                config=config,
                on_output_delta=on_output_delta,
                on_progress_event=on_progress_event,
                should_cancel=should_cancel,
            )
            if should_cancel():
                raise _AgentRunCanceled("Run canceled by user.")
            if streamed_output_state["raw"]:
                emit_stream_preview(force=True)
            assistant_text = str(provider_result.get("assistant") or "").strip()
            actions = _agent_normalize_proposed_actions(provider_result.get("actions"), max_actions=max_actions)
            model = str(provider_result.get("model") or "").strip() or None
            provider_id = _agent_normalize_provider(provider_result.get("provider_id") or run.get("provider_id") or run.get("provider") or "codex") or "codex"
            resolved_model_ref = _agent_normalize_model_ref(provider_result.get("model_ref") or run.get("model_ref"), fallback_provider=provider_id) or _agent_default_model_ref_for_provider(provider_id)
            _agent_update_run(
                repo_root,
                rid,
                {
                    "model": model,
                    "provider_id": provider_id,
                    "model_ref": resolved_model_ref,
                },
            )

            if assistant_text:
                message = _agent_append_message(
                    repo_root,
                    thread_id=str(run.get("thread_id") or ""),
                    role="assistant",
                    content=assistant_text,
                    run_id=rid,
                    provider=provider_id,
                    metadata={"model": model, "model_ref": resolved_model_ref, "provider_id": provider_id},
                )
                _agent_emit_run_event(
                    rid,
                    "message.assistant",
                    {
                        "id": str(message.get("id") or ""),
                        "thread_id": str(message.get("thread_id") or ""),
                        "run_id": rid,
                        "content": str(message.get("content") or ""),
                        "created_at": message.get("created_at"),
                    },
                    event_id=f"run-{rid}-assistant-message",
                )

            next_action: dict[str, Any] | None = None
            for proposed in actions:
                tool_name = str(proposed.get("toolName") or "").strip()
                args = proposed.get("args")
                if tool_name and isinstance(args, dict):
                    next_action = {"tool_name": tool_name, "args": args}
                    break

            if not next_action:
                final_status = _agent_recompute_run_status(repo_root, rid)
                run = _agent_get_run(repo_root, rid) or run
                _agent_emit_run_event(rid, "run.status", _agent_compact_run_payload(run), event_id=f"run-{rid}-{final_status}")
                return

            if strict_limits and int(usage.get("actions") or 0) >= max_actions:
                failure_error = "Run stopped by max action limit."
                break
            if strict_limits and int(usage.get("tool_calls") or 0) + 1 > max_tool_calls:
                failure_error = "Run stopped by max tool call limit."
                break

            action = _agent_create_action(
                repo_root,
                run_id=rid,
                sequence_index=_agent_next_sequence_index(repo_root, rid),
                tool_name=str(next_action.get("tool_name") or ""),
                args=next_action.get("args") if isinstance(next_action.get("args"), dict) else {},
                status="queued",
            )
            _agent_emit_run_event(
                rid,
                "action.queued",
                _agent_compact_action_payload(action),
                event_id=f"action-queued-{action['id']}",
            )

            previewed = _agent_preview_action(repo_root, action)
            if str(previewed.get("status") or "") == "failed":
                failure_error = str(previewed.get("failure_reason") or "Preview failed")
                break

            tool_name = str(previewed.get("tool_name") or "").strip()
            target_scope = str(previewed.get("target_scope") or "*")
            field_signature = str(previewed.get("field_signature") or "*")
            permission_rule = _agent_find_matching_trust_rule(
                repo_root,
                user_id=str(run.get("user_id") or "local-user"),
                project_scope=str(run.get("project_scope") or "global"),
                tool_name=tool_name,
                field_signature=field_signature,
                target_scope=target_scope,
                agent_profile_id=str(run.get("agent_profile_id") or "").strip() or provider_id,
            )
            permission_mode = _agent_normalize_permission(permission_rule.get("permission")) if permission_rule else ""
            action_id = str(previewed.get("id") or "")
            if permission_mode == "trust" and not _agent_is_trustable_tool(tool_name):
                permission_mode = "allow"

            if permission_mode == "deny":
                denial_error = f"{tool_name} is disallowed by agent permissions."
                _agent_update_action(
                    repo_root,
                    action_id,
                    {
                        "status": "failed",
                        "decision": "deny",
                        "decision_by": "system:auto-deny",
                        "decision_at": _now_s(),
                        "failure_reason": denial_error,
                        "applied_json": _agent_json_dumps({"ok": False, "error": denial_error}),
                    },
                )
                denied_action = _agent_get_action(repo_root, action_id) or previewed
                _agent_insert_audit(
                    repo_root,
                    user_id="system:auto-deny",
                    run_id=rid,
                    action_id=action_id,
                    event_type="action.denied",
                    payload={"tool": tool_name, "error": denial_error},
                )
                _agent_emit_run_event(
                    rid,
                    "action.failed",
                    _agent_compact_action_payload(denied_action),
                    event_id=f"action-denied-{action_id}",
                )
                failure_error = denial_error
                break

            if permission_mode in {"allow", "trust"}:
                if strict_limits and int(usage.get("tool_calls") or 0) + 2 > max_tool_calls:
                    failure_error = "Run stopped by max tool call limit."
                    break
                if permission_mode == "trust":
                    _agent_update_action(
                        repo_root,
                        action_id,
                        {"status": "trusted"},
                    )
                applied = _agent_apply_action(
                    repo_root,
                    _agent_get_action(repo_root, action_id) or previewed,
                    decision="trust" if permission_mode == "trust" else "approve",
                    decision_by=f"system:auto-{permission_mode}",
                )
                if applied.get("ok") is not True:
                    failure_error = str(applied.get("error") or "Automatic apply failed")
                    break
                continue

            final_status = _agent_recompute_run_status(repo_root, rid)
            _agent_update_run(
                repo_root,
                rid,
                {
                    "worker_id": None,
                    "lease_expires_at": None,
                    "heartbeat_at": _now_s(),
                },
            )
            run = _agent_get_run(repo_root, rid) or run
            _agent_emit_run_event(rid, "run.status", _agent_compact_run_payload(run), event_id=f"run-{rid}-{final_status}")
            return

        if failure_error:
            counts = _agent_run_action_counts(repo_root, rid)
            status = "partial_failed" if counts.get("applied", 0) > 0 else "failed"
            _agent_update_run(
                repo_root,
                rid,
                {
                    "status": status,
                    "error": failure_error,
                    "finished_at": _now_s(),
                    "worker_id": None,
                    "lease_expires_at": None,
                    "heartbeat_at": _now_s(),
                    "interrupted_reason": None,
                },
            )
            run = _agent_get_run(repo_root, rid) or run
            _agent_append_run_failure_message(
                repo_root,
                run=run,
                error=failure_error,
                partial=status == "partial_failed",
                provider_id=str(run.get("provider_id") or run.get("provider") or "codex"),
                model=str(run.get("model") or "").strip() or None,
                model_ref=run.get("model_ref"),
            )
            _agent_emit_run_event(rid, "run.status", _agent_compact_run_payload(run), event_id=f"run-{rid}-{status}")
            return

        final_status = _agent_recompute_run_status(repo_root, rid)
        _agent_update_run(
            repo_root,
            rid,
            {
                "worker_id": None,
                "lease_expires_at": None,
                "heartbeat_at": _now_s(),
            },
        )
        run = _agent_get_run(repo_root, rid) or run
        _agent_emit_run_event(rid, "run.status", _agent_compact_run_payload(run), event_id=f"run-{rid}-{final_status}")
    except _AgentRunCanceled as exc:
        _agent_update_run(
            repo_root,
            rid,
            {
                "status": "canceled",
                "error": str(exc),
                "finished_at": _now_s(),
                "worker_id": None,
                "lease_expires_at": None,
                "heartbeat_at": _now_s(),
                "interrupted_reason": None,
            },
        )
        run = _agent_get_run(repo_root, rid) or {}
        _agent_append_run_failure_message(
            repo_root,
            run=run if isinstance(run, dict) else {"id": rid},
            error=str(exc),
            partial=False,
            provider_id=str((run if isinstance(run, dict) else {}).get("provider_id") or (run if isinstance(run, dict) else {}).get("provider") or "codex"),
            model=str((run if isinstance(run, dict) else {}).get("model") or "").strip() or None,
            model_ref=(run if isinstance(run, dict) else {}).get("model_ref"),
        )
        _agent_emit_run_event(
            rid,
            "run.status",
            _agent_compact_run_payload(run if isinstance(run, dict) else {"id": rid, "status": "canceled", "error": str(exc)}),
            event_id=f"run-{rid}-canceled",
        )
    except Exception as exc:
        _agent_update_run(
            repo_root,
            rid,
            {
                "status": "failed",
                "error": str(exc),
                "finished_at": _now_s(),
                "worker_id": None,
                "lease_expires_at": None,
                "heartbeat_at": _now_s(),
                "interrupted_reason": None,
            },
        )
        run = _agent_get_run(repo_root, rid) or {}
        _agent_append_run_failure_message(
            repo_root,
            run=run if isinstance(run, dict) else {"id": rid},
            error=str(exc),
            partial=False,
            provider_id=str((run if isinstance(run, dict) else {}).get("provider_id") or (run if isinstance(run, dict) else {}).get("provider") or "codex"),
            model=str((run if isinstance(run, dict) else {}).get("model") or "").strip() or None,
            model_ref=(run if isinstance(run, dict) else {}).get("model_ref"),
        )
        _agent_emit_run_event(
            rid,
            "run.status",
            _agent_compact_run_payload(run if isinstance(run, dict) else {"id": rid, "status": "failed", "error": str(exc)}),
            event_id=f"run-{rid}-failed",
        )
        if _debug_enabled():
            _log(traceback.format_exc())
    finally:
        with _AGENT_RUN_STREAM_LOCK:
            _AGENT_RUN_CANCEL_EVENTS.pop(rid, None)


def _agent_start_run_worker(repo_root: Path, run_id: str):
    rid = str(run_id or "").strip()
    if not rid:
        return
    worker_id = _agent_new_id("agent_worker")
    with _AGENT_RUN_STREAM_LOCK:
        _AGENT_RUN_CANCEL_EVENTS[rid] = threading.Event()
    _agent_update_run(
        repo_root,
        rid,
        {
            "worker_id": worker_id,
            "cancel_requested_at": None,
            "finished_at": None,
            "interrupted_reason": None,
        },
    )
    thread = threading.Thread(
        target=_agent_run_worker,
        args=(repo_root, rid, worker_id),
        name=f"agent-run-{rid}",
        daemon=True,
    )
    thread.start()


def _agent_decide_action(
    repo_root: Path,
    *,
    action_id: str,
    decision: str,
    decision_by: str,
    user_id: str,
    project_scope: str,
) -> dict[str, Any]:
    action = _agent_get_action(repo_root, action_id)
    if not action:
        raise ValueError("action not found")
    run_id = str(action.get("run_id") or "")
    run = _agent_get_run(repo_root, run_id)
    if not run:
        raise ValueError("run not found")
    effective_project_scope = _agent_normalize_project_scope(run.get("project_scope") or project_scope)

    normalized_decision = str(decision or "").strip().lower()
    if normalized_decision not in {"approve", "reject", "trust"}:
        raise ValueError("decision must be approve, reject, or trust")

    if normalized_decision == "reject":
        _agent_update_action(
            repo_root,
            action_id,
            {
                "status": "rejected",
                "decision": "reject",
                "decision_by": decision_by,
                "decision_at": _now_s(),
                "failure_reason": str(action.get("failure_reason") or ""),
            },
        )
        updated = _agent_get_action(repo_root, action_id) or action
        retry_payload = None
        if int(action.get("retry_count") or 0) < 1:
            retry_action = _agent_create_retry_action(repo_root, updated)
            retry_payload = _agent_compact_action_payload(retry_action)
        final_status = _agent_recompute_run_status(repo_root, run_id)
        run_payload = _agent_compact_run_payload(_agent_get_run(repo_root, run_id) or run)
        _agent_emit_run_event(run_id, "run.status", run_payload, event_id=f"run-{run_id}-{final_status}")
        return {
            "ok": True,
            "decision": "reject",
            "action": _agent_compact_action_payload(updated),
            "retry": retry_payload,
            "run": run_payload,
        }

    if normalized_decision == "trust" and not _agent_is_trustable_tool(str(action.get("tool_name") or "")):
        raise ValueError("Trust is not allowed for destructive tools.")

    apply_result = _agent_apply_action(
        repo_root,
        action,
        decision=normalized_decision,
        decision_by=decision_by,
    )
    updated_action = apply_result.get("action") if isinstance(apply_result.get("action"), dict) else (_agent_get_action(repo_root, action_id) or action)
    trust_rule_payload = None

    if normalized_decision == "trust" and apply_result.get("ok") is True:
        trust_rule = _agent_create_trust_rule(
            repo_root,
            user_id=user_id,
            project_scope=effective_project_scope,
            agent_profile_id=str(run.get("agent_profile_id") or "").strip() or None,
            tool_name=str(updated_action.get("tool_name") or ""),
            field_signature=str(updated_action.get("field_signature") or "*"),
            target_scope=str(updated_action.get("target_scope") or "*"),
        )
        trust_rule_payload = trust_rule
        _agent_insert_audit(
            repo_root,
            user_id=decision_by,
            run_id=run_id,
            action_id=action_id,
            event_type="trust.created",
            payload=trust_rule,
        )

    if apply_result.get("ok") is True:
        _agent_supersede_pending_actions(
            repo_root,
            run_id,
            except_action_id=action_id,
        )
        resumed_run = _agent_resume_run(repo_root, run_id, allowed_statuses={"waiting_approval", "interrupted"})
        run_payload = _agent_compact_run_payload(resumed_run or (_agent_get_run(repo_root, run_id) or run))
        return {
            "ok": True,
            "decision": normalized_decision,
            "action": _agent_compact_action_payload(updated_action),
            "trust_rule": trust_rule_payload,
            "run": run_payload,
            "error": None,
        }

    final_status = _agent_recompute_run_status(repo_root, run_id)
    run_payload = _agent_compact_run_payload(_agent_get_run(repo_root, run_id) or run)
    _agent_emit_run_event(run_id, "run.status", run_payload, event_id=f"run-{run_id}-{final_status}")

    return {
        "ok": apply_result.get("ok") is True,
        "decision": normalized_decision,
        "action": _agent_compact_action_payload(updated_action),
        "trust_rule": trust_rule_payload,
        "run": run_payload,
        "error": apply_result.get("error"),
    }


def _auth_accounts_upsert(repo_root: Path, account: dict[str, Any]):
    _local_broker_initialize(repo_root)
    account_id = str(account.get("account_id") or "").strip()
    base_url = str(account.get("base_url") or "").strip()
    access_token = str(account.get("access_token") or "").strip()
    if not account_id or not base_url or not access_token:
        raise ValueError("account_id, base_url, and access_token are required")

    now = _now_s()
    refresh_token = str(account.get("refresh_token") or "").strip() or None
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            """
            INSERT INTO auth_accounts(
                account_id,
                base_url,
                grant_type,
                login,
                display_name,
                sg_user_id,
                access_token,
                refresh_token,
                access_expires_at,
                refresh_expires_at,
                remembered,
                created_at,
                updated_at,
                last_used_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id) DO UPDATE SET
              base_url=excluded.base_url,
              grant_type=excluded.grant_type,
              login=excluded.login,
              display_name=excluded.display_name,
              sg_user_id=excluded.sg_user_id,
              access_token=excluded.access_token,
              refresh_token=excluded.refresh_token,
              access_expires_at=excluded.access_expires_at,
              refresh_expires_at=excluded.refresh_expires_at,
              remembered=excluded.remembered,
              updated_at=excluded.updated_at,
              last_used_at=excluded.last_used_at
            """,
            (
                account_id,
                base_url,
                str(account.get("grant_type") or "").strip() or None,
                str(account.get("login") or "").strip() or None,
                str(account.get("display_name") or account.get("name") or "").strip() or None,
                _coerce_int(account.get("sg_user_id")),
                access_token,
                refresh_token,
                float(account.get("access_expires_at") or 0),
                float(account.get("refresh_expires_at") or 0),
                1 if bool(account.get("remembered", True)) else 0,
                now,
                now,
                now,
            ),
        )
    finally:
        conn.close()


def _auth_accounts_get(repo_root: Path, account_id: str | None) -> dict[str, Any] | None:
    _local_broker_initialize(repo_root)
    target_id = str(account_id or "").strip()
    if not target_id:
        return None
    conn = _local_broker_connect(repo_root)
    try:
        row = conn.execute(
            """
            SELECT
              account_id, base_url, grant_type, login, display_name, sg_user_id,
              access_token, refresh_token, access_expires_at, refresh_expires_at,
              remembered, created_at, updated_at, last_used_at
            FROM auth_accounts
            WHERE account_id = ?
            """,
            (target_id,),
        ).fetchone()
        if not row:
            return None
        record = dict(row)
        conn.execute(
            "UPDATE auth_accounts SET last_used_at = ?, updated_at = ? WHERE account_id = ?",
            (_now_s(), _now_s(), target_id),
        )
        return record
    finally:
        conn.close()


def _auth_accounts_find(
    repo_root: Path,
    *,
    base_url: str,
    login: str | None = None,
    sg_user_id: int | None = None,
) -> dict[str, Any] | None:
    _local_broker_initialize(repo_root)
    base = _normalize_base_url(str(base_url or "").strip())
    if not base:
        return None
    conn = _local_broker_connect(repo_root)
    try:
        if sg_user_id and sg_user_id > 0:
            row = conn.execute(
                """
                SELECT
                  account_id, base_url, grant_type, login, display_name, sg_user_id,
                  access_token, refresh_token, access_expires_at, refresh_expires_at,
                  remembered, created_at, updated_at, last_used_at
                FROM auth_accounts
                WHERE base_url = ? AND sg_user_id = ?
                ORDER BY last_used_at DESC
                LIMIT 1
                """,
                (base, int(sg_user_id)),
            ).fetchone()
            if row:
                return dict(row)
        login_value = str(login or "").strip()
        if login_value:
            row = conn.execute(
                """
                SELECT
                  account_id, base_url, grant_type, login, display_name, sg_user_id,
                  access_token, refresh_token, access_expires_at, refresh_expires_at,
                  remembered, created_at, updated_at, last_used_at
                FROM auth_accounts
                WHERE base_url = ? AND lower(login) = lower(?)
                ORDER BY last_used_at DESC
                LIMIT 1
                """,
                (base, login_value),
            ).fetchone()
            if row:
                return dict(row)
        return None
    finally:
        conn.close()


def _auth_accounts_delete(repo_root: Path, account_id: str | None) -> bool:
    _local_broker_initialize(repo_root)
    target_id = str(account_id or "").strip()
    if not target_id:
        return False
    conn = _local_broker_connect(repo_root)
    try:
        row = conn.execute("DELETE FROM auth_accounts WHERE account_id = ?", (target_id,))
        return int(getattr(row, "rowcount", 0) or 0) > 0
    finally:
        conn.close()


def _local_broker_set_last_project(repo_root: Path, auth_key: str, project_id: int):
    _local_broker_set_meta(repo_root, f"last_project:{auth_key}", str(int(project_id)))


def _local_broker_get_last_project(repo_root: Path, auth_key: str) -> int | None:
    raw = _local_broker_get_meta(repo_root, f"last_project:{auth_key}")
    value = _coerce_int(raw)
    if value and value > 0:
        return value
    return None


def _local_broker_get_linked_sg_id(conn: sqlite3.Connection, project_id: int, local_id: str) -> int | None:
    row = conn.execute(
        "SELECT sg_task_id FROM local_task_links WHERE project_id = ? AND local_id = ?",
        (int(project_id), str(local_id)),
    ).fetchone()
    if not row:
        return None
    return _coerce_int(row["sg_task_id"])


def _local_broker_set_linked_sg_id(conn: sqlite3.Connection, project_id: int, local_id: str, sg_task_id: int):
    now = _now_s()
    conn.execute(
        """
        INSERT INTO local_task_links(project_id, local_id, sg_task_id, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(project_id, local_id) DO UPDATE SET
          sg_task_id=excluded.sg_task_id,
          updated_at=excluded.updated_at
        """,
        (int(project_id), str(local_id), int(sg_task_id), now, now),
    )


def _local_broker_delete_link(conn: sqlite3.Connection, project_id: int, local_id: str):
    conn.execute(
        "DELETE FROM local_task_links WHERE project_id = ? AND local_id = ?",
        (int(project_id), str(local_id)),
    )


def _sg_project_id_for_task(auth: dict[str, Any], task_id: int) -> int | None:
    records = _sg_search_records(
        auth,
        "tasks",
        [["id", "is", int(task_id)]],
        ["project"],
        page_size=2,
        max_pages=1,
    )
    if not records:
        return None
    for record in records:
        relationships = record.get("relationships") if isinstance(record.get("relationships"), dict) else {}
        project_rel = relationships.get("project")
        project_data = _sg_rel_data(project_rel)
        if isinstance(project_data, dict):
            project_id = _coerce_int(project_data.get("id"))
            if project_id and project_id > 0:
                return project_id
    return None


def _local_broker_resolve_project_id(
    repo_root: Path,
    auth: dict[str, Any] | None,
    *,
    body: dict[str, Any] | None = None,
    query: dict[str, list[str]] | None = None,
) -> int:
    body = body or {}
    query = query or {}
    has_remote_auth = isinstance(auth, dict) and bool(auth)

    explicit_raw = (
        body.get("project_id")
        or body.get("projectId")
        or (query.get("project_id", [None])[0] if query else None)
    )
    explicit = _coerce_int(explicit_raw)
    if explicit and explicit > 0:
        _local_broker_set_last_project(repo_root, _local_broker_auth_key(auth), explicit)
        return int(explicit)

    raw_project_name = body.get("project_name") or body.get("projectName") or body.get("project")
    if has_remote_auth and isinstance(raw_project_name, str) and raw_project_name.strip():
        project_name = raw_project_name.strip().lower()
        projects = _sg_list_projects(auth or {})
        matches = [p for p in projects if str(p.get("name") or "").strip().lower() == project_name]
        if len(matches) == 1:
            project_id = _coerce_int(matches[0].get("id"))
            if project_id and project_id > 0:
                _local_broker_set_last_project(repo_root, _local_broker_auth_key(auth), project_id)
                return int(project_id)
        if len(matches) > 1:
            raise ValueError(f'Ambiguous project name "{raw_project_name}"')

    operations = body.get("operations")
    if not isinstance(operations, list):
        operations = []

    inferred_from_task_ids: set[int] = set()
    if has_remote_auth:
        for op in operations:
            if not isinstance(op, dict):
                continue
            raw_id = op.get("taskId") or op.get("task_id") or op.get("Id")
            task_id = _coerce_int(raw_id)
            if not task_id or task_id <= 0:
                continue
            project_id = _sg_project_id_for_task(auth or {}, task_id)
            if project_id and project_id > 0:
                inferred_from_task_ids.add(project_id)
    if len(inferred_from_task_ids) == 1:
        resolved = next(iter(inferred_from_task_ids))
        _local_broker_set_last_project(repo_root, _local_broker_auth_key(auth), resolved)
        return int(resolved)
    if len(inferred_from_task_ids) > 1:
        raise ValueError("Operations reference tasks from multiple projects; pass project_id explicitly.")

    links: list[str] = []
    for op in operations:
        if not isinstance(op, dict):
            continue
        task_payload = op.get("task")
        if not isinstance(task_payload, dict):
            task_payload = op.get("taskData")
        if not isinstance(task_payload, dict):
            task_payload = op if (op.get("type") == "create") else None
        if not isinstance(task_payload, dict):
            continue
        for key in ("Link", "asset"):
            raw_link = task_payload.get(key)
            if isinstance(raw_link, str) and raw_link.strip():
                links.append(raw_link.strip())
                break
    if has_remote_auth and links:
        projects = _sg_list_projects(auth or {})
        matching_projects: list[int] = []
        for project in projects:
            project_id = _coerce_int(project.get("id"))
            if not project_id or project_id <= 0:
                continue
            is_match = True
            for link in links:
                entity = _sg_find_entity_by_name(auth or {}, link, project_id=project_id)
                if not entity:
                    is_match = False
                    break
            if is_match:
                matching_projects.append(project_id)
        if len(matching_projects) == 1:
            resolved = matching_projects[0]
            _local_broker_set_last_project(repo_root, _local_broker_auth_key(auth), resolved)
            return int(resolved)
        if len(matching_projects) > 1:
            raise ValueError("Project is ambiguous for the referenced assets; pass project_id explicitly.")

    last_project = _local_broker_get_last_project(repo_root, _local_broker_auth_key(auth))
    if last_project and last_project > 0:
        return int(last_project)

    default_project = _env_int("SHOTGRID_PROJECT_ID", "SG_PROJECT_ID")
    if default_project and default_project > 0:
        _local_broker_set_last_project(repo_root, _local_broker_auth_key(auth), default_project)
        return int(default_project)

    raise ValueError("Unable to resolve project_id. Pass project_id explicitly.")


def _local_broker_internalize_updates(payload: dict[str, Any]) -> dict[str, Any]:
    internal: dict[str, Any] = {}
    for key, value in payload.items():
        internal_key = _LOCAL_TASK_FIELD_ALIASES.get(key, key)
        internal[internal_key] = value
    return internal


def _local_broker_normalize_task(
    payload: dict[str, Any],
    existing: dict[str, Any] | None = None,
    *,
    fill_defaults: bool = True,
) -> dict[str, Any]:
    task: dict[str, Any] = dict(existing or {})
    internal = _local_broker_internalize_updates(payload)
    for key, value in internal.items():
        if key.startswith("__"):
            task[key] = value
            continue
        if value is None:
            task[key] = ""
            continue
        task[key] = value

    if fill_defaults and not str(task.get("Id") or "").strip():
        task["Id"] = f"local-{int(_now_s() * 1000)}-{secrets.token_hex(4)}"
    if "Id" in task:
        task["Id"] = str(task.get("Id") or "").strip()

    if fill_defaults and ("Task Name" not in task or not str(task.get("Task Name") or "").strip()):
        asset = str(task.get("Link") or "").strip()
        dept = str(task.get("Pipeline Step") or "").strip()
        fallback_name = "New Task"
        if asset and dept:
            fallback_name = f"{asset} - {dept}"
        elif asset:
            fallback_name = asset
        elif dept:
            fallback_name = dept
        task["Task Name"] = fallback_name

    if fill_defaults:
        task["Link"] = str(task.get("Link") or "")
        task["Assigned To"] = str(task.get("Assigned To") or "")
        task["Pipeline Step"] = str(task.get("Pipeline Step") or "")
        task["Status"] = str(task.get("Status") or "sch")
        task["Start"] = str(task.get("Start") or "")
        task["End"] = str(task.get("End") or "")
        task["Project Stage"] = str(task.get("Project Stage") or "")
        task["Location"] = str(task.get("Location") or "")
        task["Deadline"] = str(task.get("Deadline") or "")
        task["Dept Est"] = str(task.get("Dept Est") or "")
        task["Total Work"] = str(task.get("Total Work") or "")
        task["Dept Prod Note"] = str(task.get("Dept Prod Note") or "")
        task["Task Comments"] = str(task.get("Task Comments") or "")
        task["Target Status Summary"] = str(task.get("Target Status Summary") or "ON TARGET")
        task["% Allocation"] = str(task.get("% Allocation") or "100%")
        task["Project"] = str(task.get("Project") or "")
        task["Duration"] = str(_calc_business_days(task.get("Start") or "", task.get("End") or ""))
    else:
        for key in (
            "Task Name",
            "Link",
            "Assigned To",
            "Pipeline Step",
            "Status",
            "Start",
            "End",
            "Project Stage",
            "Location",
            "Deadline",
            "Dept Est",
            "Total Work",
            "Dept Prod Note",
            "Task Comments",
            "Target Status Summary",
            "% Allocation",
            "Project",
            "Duration",
        ):
            if key in task:
                task[key] = str(task.get(key) or "")
        if "Duration" not in task and "Start" in task and "End" in task:
            task["Duration"] = str(_calc_business_days(task.get("Start") or "", task.get("End") or ""))
    if "__source" not in task:
        task["__source"] = "local"
    return task


def _local_broker_list_overrides(repo_root: Path, project_id: int) -> list[dict[str, Any]]:
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(
            """
            SELECT project_id, task_id, sg_task_id, task_json, sync_state, last_error, source, updated_at, created_at, synced_at
            FROM local_task_overrides
            WHERE project_id = ? AND sync_state IN ('pending', 'processing', 'failed')
            ORDER BY updated_at DESC, task_id ASC
            """,
            (int(project_id),),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def _local_broker_merge_tasks(repo_root: Path, project_id: int, shotgrid_tasks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    merged_by_id: dict[str, dict[str, Any]] = {}
    for task in shotgrid_tasks:
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("Id") or "").strip()
        if not task_id:
            continue
        merged_by_id[task_id] = dict(task)

    override_rows = _local_broker_list_overrides(repo_root, int(project_id))
    pending_count = 0

    for row in override_rows:
        pending_count += 1
        task_id = str(row.get("task_id") or "").strip()
        if not task_id:
            continue

        sg_task_id = _coerce_int(row.get("sg_task_id"))
        if sg_task_id and str(sg_task_id) in merged_by_id:
            merged_by_id.pop(str(sg_task_id), None)
        merged_by_id.pop(task_id, None)

        try:
            task_payload = json.loads(str(row.get("task_json") or "{}"))
            if not isinstance(task_payload, dict):
                task_payload = {}
        except Exception:
            task_payload = {}

        if task_payload.get("__deleted") is True:
            continue

        task_payload = _local_broker_normalize_task(task_payload)
        task_payload["Id"] = task_id
        task_payload["__source"] = "local-broker"
        task_payload["__sync_state"] = str(row.get("sync_state") or "pending")
        if row.get("last_error"):
            task_payload["__sync_error"] = str(row.get("last_error"))
        merged_by_id[task_id] = task_payload

    merged = list(merged_by_id.values())
    merged.sort(
        key=lambda task: (
            str(task.get("Start") or "9999-12-31"),
            str(task.get("Link") or ""),
            str(task.get("Task Name") or ""),
            str(task.get("Id") or ""),
        )
    )
    return merged, pending_count


def _local_broker_queue_task_operation(
    repo_root: Path,
    *,
    project_id: int,
    task: dict[str, Any],
    op_type: str,
    source: str,
    auth_account_id: str | None = None,
    auth_policy: str = "script_only",
    allow_script_fallback: bool = False,
    effective_actor: str = "script",
    fallback_used: bool = False,
    sparse: bool = False,
):
    _local_broker_initialize(repo_root)
    if op_type not in ("upsert", "delete"):
        raise ValueError(f"Unsupported op_type: {op_type}")

    normalized = _local_broker_normalize_task(task, fill_defaults=not sparse)
    task_id = str(normalized.get("Id") or "").strip()
    if not task_id:
        raise ValueError("Task Id is required")
    if sparse:
        normalized["__sparse_patch"] = True

    now = _now_s()
    conn = _local_broker_connect(repo_root)
    try:
        sg_task_id = _coerce_int(task_id)
        if not sg_task_id:
            sg_task_id = _local_broker_get_linked_sg_id(conn, int(project_id), task_id)
        if sg_task_id:
            normalized["__sg_task_id"] = int(sg_task_id)

        payload_json = json.dumps(normalized, ensure_ascii=False)
        conn.execute(
            """
            INSERT INTO local_task_overrides(
                project_id, task_id, sg_task_id, auth_account_id, task_json, sync_state, last_error, source, created_at, updated_at, synced_at
            )
            VALUES(?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL)
            ON CONFLICT(project_id, task_id) DO UPDATE SET
              sg_task_id=excluded.sg_task_id,
              auth_account_id=excluded.auth_account_id,
              task_json=excluded.task_json,
              sync_state='pending',
              last_error=NULL,
              source=excluded.source,
              updated_at=excluded.updated_at
            """,
            (
                int(project_id),
                task_id,
                sg_task_id,
                str(auth_account_id or "").strip() or None,
                payload_json,
                source,
                now,
                now,
            ),
        )

        conn.execute(
            """
            DELETE FROM local_sync_queue
            WHERE project_id = ? AND task_id = ? AND status IN ('pending', 'failed')
            """,
            (int(project_id), task_id),
        )
        conn.execute(
            """
            INSERT INTO local_sync_queue(
                project_id, task_id, sg_task_id, auth_account_id, auth_policy, allow_script_fallback, effective_actor, fallback_used,
                op_type, payload_json, source, status, attempts, next_attempt_at, last_error, created_at, updated_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, NULL, ?, ?)
            """,
            (
                int(project_id),
                task_id,
                sg_task_id,
                str(auth_account_id or "").strip() or None,
                _normalize_auth_policy(auth_policy, default="script_only"),
                1 if allow_script_fallback else 0,
                str(effective_actor or "none"),
                1 if fallback_used else 0,
                op_type,
                payload_json,
                source,
                now,
                now,
            ),
        )
    finally:
        conn.close()
    _LOCAL_BROKER_WAKE_EVENT.set()


def _local_broker_build_tombstone(task_id: str) -> dict[str, Any]:
    return {
        "Id": str(task_id),
        "__deleted": True,
        "__source": "local-broker",
    }


def _local_broker_apply_operations(
    repo_root: Path,
    auth: dict[str, Any] | None,
    *,
    project_id: int,
    operations: list[dict[str, Any]],
    source: str,
    auth_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    fields = _shotgrid_fields()
    shotgrid_tasks: list[dict[str, Any]] = []
    warnings: list[str] = []

    if isinstance(auth, dict) and auth:
        try:
            shotgrid_tasks = _sg_fetch_tasks(auth, fields, int(project_id), [])
        except Exception as exc:
            warnings.append(f"ShotGrid fetch unavailable; queued operations locally only ({exc}).")
            if _debug_enabled():
                _log("[uptospeed] Local apply fallback: ShotGrid fetch unavailable")
                _log(traceback.format_exc())
    else:
        warnings.append("ShotGrid auth unavailable; queued operations locally only.")

    merged_tasks, _ = _local_broker_merge_tasks(repo_root, int(project_id), shotgrid_tasks)
    by_id: dict[str, dict[str, Any]] = {}
    for task in merged_tasks:
        task_id = str(task.get("Id") or "").strip()
        if task_id:
            by_id[task_id] = dict(task)

    applied: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    queued = 0
    queued_auth_policy = _normalize_auth_policy((auth_context or {}).get("policy"), default="script_only")
    queued_auth_account_id = str((auth_context or {}).get("account_id") or "").strip() or None
    queued_allow_script_fallback = bool((auth_context or {}).get("allow_script_fallback"))
    queued_effective_actor = str((auth_context or {}).get("effective_actor") or _build_effective_actor(auth))
    queued_fallback_used = bool((auth_context or {}).get("fallback_used"))

    for raw_op in operations:
        if not isinstance(raw_op, dict):
            errors.append({"ok": False, "error": "Operation must be an object"})
            continue

        op_type = str(raw_op.get("type") or "").strip().lower()
        if op_type not in ("update", "create", "delete", "create_entity"):
            errors.append({"ok": False, "error": f"Unsupported operation type: {op_type or '(missing)'}"})
            continue

        if op_type == "create_entity":
            normalized_entity_type = _local_broker_normalize_entity_type(raw_op.get("entityType"))
            if not normalized_entity_type:
                errors.append({"ok": False, "error": "create_entity requires entityType"})
                continue

            raw_entity = raw_op.get("entity")
            if not isinstance(raw_entity, dict):
                errors.append({"ok": False, "error": "create_entity requires entity object"})
                continue

            if_exists = str(raw_op.get("ifExists") or "return_existing").strip().lower()
            if if_exists not in ("return_existing",):
                errors.append({"ok": False, "error": f"Unsupported ifExists policy: {if_exists}"})
                continue

            try:
                normalized_entity = _local_broker_normalize_entity_payload(
                    normalized_entity_type,
                    raw_entity,
                )
            except ValueError as exc:
                errors.append({"ok": False, "error": str(exc)})
                continue

            existing = None
            if isinstance(auth, dict) and auth and if_exists == "return_existing":
                existing = _local_broker_find_existing_entity(
                    auth,
                    project_id=int(project_id),
                    entity_type=normalized_entity_type,
                    entity=normalized_entity,
                )

            if existing:
                applied.append(
                    {
                        "type": "create_entity",
                        "entityType": normalized_entity_type,
                        "ok": True,
                        "queued": False,
                        "existing": True,
                        "entity": normalized_entity,
                        "result": existing,
                    }
                )
                continue

            synthetic_task_id = _local_broker_entity_task_id(
                int(project_id),
                normalized_entity_type,
                normalized_entity,
            )
            queue_payload = {
                "type": "create_entity",
                "entityType": normalized_entity_type,
                "entity": normalized_entity,
                "ifExists": if_exists,
            }
            _local_broker_queue_entity_operation(
                repo_root,
                project_id=int(project_id),
                synthetic_task_id=synthetic_task_id,
                payload=queue_payload,
                source=source,
                auth_account_id=queued_auth_account_id,
                auth_policy=queued_auth_policy,
                allow_script_fallback=queued_allow_script_fallback,
                effective_actor=queued_effective_actor,
                fallback_used=queued_fallback_used,
            )
            queued += 1
            applied.append(
                {
                    "type": "create_entity",
                    "entityType": normalized_entity_type,
                    "ok": True,
                    "queued": True,
                    "existing": False,
                    "entity": normalized_entity,
                    "syntheticTaskId": synthetic_task_id,
                }
            )
            continue

        if op_type == "delete":
            raw_task_id = raw_op.get("taskId") or raw_op.get("task_id") or raw_op.get("Id")
            task_id = str(raw_task_id or "").strip()
            if not task_id:
                errors.append({"ok": False, "error": "Delete operation requires taskId"})
                continue

            tombstone = _local_broker_build_tombstone(task_id)
            _local_broker_queue_task_operation(
                repo_root,
                project_id=int(project_id),
                task=tombstone,
                op_type="delete",
                source=source,
                auth_account_id=queued_auth_account_id,
                auth_policy=queued_auth_policy,
                allow_script_fallback=queued_allow_script_fallback,
                effective_actor=queued_effective_actor,
                fallback_used=queued_fallback_used,
            )
            queued += 1
            by_id.pop(task_id, None)
            applied.append({"type": "delete", "taskId": task_id, "ok": True})
            if isinstance(auth, dict) and auth:
                _broadcast_stream_refresh(auth, int(project_id), reason="local_delete_queued")
            continue

        if op_type == "update":
            raw_task_id = raw_op.get("taskId") or raw_op.get("task_id") or raw_op.get("Id")
            task_id = str(raw_task_id or "").strip()
            if not task_id:
                errors.append({"ok": False, "error": "Update operation requires taskId"})
                continue
            existing = by_id.get(task_id)
            updates = raw_op.get("updates")
            if not isinstance(updates, dict):
                errors.append({"ok": False, "error": f"Update operation for {task_id} requires updates object"})
                continue

            # If we can resolve the full task locally, queue a full merged task payload.
            # Otherwise, queue a sparse patch so edits are not blocked by ShotGrid availability.
            if existing:
                merged = _local_broker_normalize_task(updates, existing=existing)
                merged["Id"] = task_id
                _local_broker_queue_task_operation(
                    repo_root,
                    project_id=int(project_id),
                    task=merged,
                    op_type="upsert",
                    source=source,
                    auth_account_id=queued_auth_account_id,
                    auth_policy=queued_auth_policy,
                    allow_script_fallback=queued_allow_script_fallback,
                    effective_actor=queued_effective_actor,
                    fallback_used=queued_fallback_used,
                )
                by_id[task_id] = merged
                applied_task = merged
            else:
                sg_task_id = _coerce_int(task_id)
                if not (sg_task_id and sg_task_id > 0):
                    errors.append(
                        {
                            "ok": False,
                            "error": (
                                f"Task {task_id} is unavailable locally and has no numeric ShotGrid id; "
                                "cannot safely queue sparse update."
                            ),
                        }
                    )
                    continue

                sparse_patch = _local_broker_normalize_task({"Id": task_id, **updates}, fill_defaults=False)
                sparse_patch["Id"] = task_id
                _local_broker_queue_task_operation(
                    repo_root,
                    project_id=int(project_id),
                    task=sparse_patch,
                    op_type="upsert",
                    source=source,
                    auth_account_id=queued_auth_account_id,
                    auth_policy=queued_auth_policy,
                    allow_script_fallback=queued_allow_script_fallback,
                    effective_actor=queued_effective_actor,
                    fallback_used=queued_fallback_used,
                    sparse=True,
                )
                # Keep optimistic local shape for immediate merged responses.
                by_id[task_id] = {**(by_id.get(task_id) or {}), **sparse_patch}
                applied_task = sparse_patch
                warnings.append(
                    f"Task {task_id} queued as sparse patch because ShotGrid snapshot was unavailable."
                )

            queued += 1
            applied.append({"type": "update", "taskId": task_id, "ok": True, "task": applied_task})
            if isinstance(auth, dict) and auth:
                _broadcast_task_updates(
                    auth,
                    int(project_id),
                    [dict(applied_task, __source="local-broker", __sync_state="pending")],
                )
            continue

        # create
        task_payload = raw_op.get("task")
        if not isinstance(task_payload, dict):
            task_payload = raw_op.get("taskData")
        if not isinstance(task_payload, dict):
            task_payload = dict(raw_op)
        normalized = _local_broker_normalize_task(task_payload)
        task_id = str(normalized.get("Id") or "").strip()
        if not task_id:
            normalized["Id"] = f"local-{int(_now_s() * 1000)}-{secrets.token_hex(4)}"
            task_id = normalized["Id"]
        if by_id.get(task_id):
            errors.append({"ok": False, "error": f"Task id {task_id} already exists"})
            continue
        _local_broker_queue_task_operation(
            repo_root,
            project_id=int(project_id),
            task=normalized,
            op_type="upsert",
            source=source,
            auth_account_id=queued_auth_account_id,
            auth_policy=queued_auth_policy,
            allow_script_fallback=queued_allow_script_fallback,
            effective_actor=queued_effective_actor,
            fallback_used=queued_fallback_used,
        )
        queued += 1
        by_id[task_id] = normalized
        applied.append({"type": "create", "taskId": task_id, "ok": True, "task": normalized})
        if isinstance(auth, dict) and auth:
            _broadcast_task_updates(auth, int(project_id), [dict(normalized, __source="local-broker", __sync_state="pending")])

    return {
        "ok": len(errors) == 0,
        "project_id": int(project_id),
        "queued": queued,
        "applied": applied,
        "errors": errors,
        "warnings": warnings,
        "auth": {
            "policy": queued_auth_policy,
            "account_id": queued_auth_account_id,
            "effective_actor": queued_effective_actor,
            "fallback_used": queued_fallback_used,
            "allow_script_fallback": queued_allow_script_fallback,
        },
    }


def _local_broker_fetch_queue_stats(repo_root: Path, project_id: int) -> dict[str, int]:
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        rows = conn.execute(
            """
            SELECT status, COUNT(*) AS c
            FROM local_sync_queue
            WHERE project_id = ?
            GROUP BY status
            """,
            (int(project_id),),
        ).fetchall()
        by_status = {str(row["status"]): int(row["c"]) for row in rows}
        pending_rows = conn.execute(
            """
            SELECT COUNT(*) AS c
            FROM local_task_overrides
            WHERE project_id = ? AND sync_state IN ('pending', 'processing', 'failed')
            """,
            (int(project_id),),
        ).fetchone()
        pending_overrides = int(pending_rows["c"]) if pending_rows else 0
        return {
            "queue_pending": int(by_status.get("pending", 0)),
            "queue_processing": int(by_status.get("processing", 0)),
            "queue_failed": int(by_status.get("failed", 0)),
            "queue_done": int(by_status.get("done", 0)),
            "pending_overrides": pending_overrides,
        }
    finally:
        conn.close()


def _sg_delete_task(auth: dict[str, Any], task_id: int):
    last_not_found: ShotGridApiError | None = None
    for prefix in ("/api/v1.1", "/api/v1"):
        try:
            _sg_api(auth, "DELETE", f"{prefix}/entity/tasks/{int(task_id)}", timeout_s=60)
            return
        except ShotGridApiError as exc:
            if exc.status == 404:
                last_not_found = exc
                continue
            raise
    if last_not_found:
        # Treat already-deleted as success.
        return


def _normalize_shotgrid_task_status(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    return _LOCAL_TO_SHOTGRID_STATUS_MAP.get(raw, raw)


def _resolve_shotgrid_step_relationship(
    auth: dict[str, Any],
    *,
    fields: dict[str, str],
    raw_step: str,
) -> dict[str, Any]:
    cleaned = str(raw_step or "").strip()
    if not cleaned:
        return {fields["step"]: {"data": None}}

    step = _sg_find_step_by_name(auth, cleaned)
    if step and step.get("id"):
        return {fields["step"]: {"data": {"type": "steps", "id": str(step["id"])}}}

    if cleaned.lower() in _PIPELINE_STEP_NONE_ALIASES:
        return {fields["step"]: {"data": None}}

    raise RuntimeError(f"Unknown pipeline step: {cleaned}")


def _local_broker_build_sg_payload(
    auth: dict[str, Any],
    fields: dict[str, str],
    *,
    project_id: int,
    task: dict[str, Any],
    include_project_rel: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    attributes: dict[str, Any] = {}
    relationships: dict[str, Any] = {}

    if include_project_rel:
        relationships[fields["project"]] = {"data": {"type": "projects", "id": str(int(project_id))}}

    task_name = str(task.get("Task Name") or "").strip()
    if task_name:
        attributes[fields["task_name"]] = task_name

    if "Status" in task:
        normalized_status = _normalize_shotgrid_task_status(task.get("Status"))
        if normalized_status:
            attributes[fields["status"]] = normalized_status
    if "Start" in task:
        attributes[fields["start"]] = task.get("Start") or None
    if "End" in task:
        attributes[fields["end"]] = task.get("End") or None

    if fields.get("dept_prod_note") and "Dept Prod Note" in task:
        attributes[fields["dept_prod_note"]] = str(task.get("Dept Prod Note") or "")
    if fields.get("target_status_summary") and "Target Status Summary" in task:
        attributes[fields["target_status_summary"]] = str(task.get("Target Status Summary") or "")
    if fields.get("task_comments") and "Task Comments" in task:
        attributes[fields["task_comments"]] = str(task.get("Task Comments") or "")

    if "Pipeline Step" in task:
        raw_step = str(task.get("Pipeline Step") or "").strip()
        relationships.update(
            _resolve_shotgrid_step_relationship(
                auth,
                fields=fields,
                raw_step=raw_step,
            )
        )

    if include_project_rel:
        raw_link = str(task.get("Link") or "").strip()
        if raw_link:
            entity = _sg_find_entity_by_name(auth, raw_link, project_id=int(project_id))
            if not entity:
                raise RuntimeError(f"Could not find Asset or Shot named '{raw_link}' in project {project_id}")
            entity_type = str(entity.get("type") or "").strip().lower() + "s"
            relationships[fields["entity"]] = {"data": {"type": entity_type, "id": str(entity.get("id"))}}

    if "Assigned To" in task:
        names = [n.strip() for n in str(task.get("Assigned To") or "").split(",") if n.strip()]
        if not names:
            relationships[fields["assignees"]] = {"data": []}
        else:
            people = []
            unresolved = []
            for name in names:
                user = _sg_find_human_user_by_name(auth, name)
                if not user or not user.get("id"):
                    unresolved.append(name)
                    continue
                people.append({"type": "human_users", "id": str(user["id"])})
            if unresolved:
                raise RuntimeError(f"Unknown assignee(s): {', '.join(unresolved)}")
            relationships[fields["assignees"]] = {"data": people}

    return attributes, relationships


def _local_broker_take_next_queue_job(repo_root: Path) -> dict[str, Any] | None:
    _local_broker_initialize(repo_root)
    now = _now_s()
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT
              id, project_id, task_id, sg_task_id, auth_account_id, auth_policy,
              allow_script_fallback, effective_actor, fallback_used,
              op_type, payload_json, source, status, attempts, next_attempt_at, created_at, updated_at
            FROM local_sync_queue
            WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
            ORDER BY id ASC
            LIMIT 1
            """,
            (now,),
        ).fetchone()
        if not row:
            conn.execute("COMMIT")
            return None

        job_id = int(row["id"])
        attempts = int(row["attempts"] or 0) + 1
        conn.execute(
            """
            UPDATE local_sync_queue
            SET status='processing', attempts=?, updated_at=?, last_error=NULL
            WHERE id=?
            """,
            (attempts, now, job_id),
        )
        conn.execute("COMMIT")
        job = dict(row)
        job["attempts"] = attempts
        return job
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()


def _local_broker_requested_actor(job: dict[str, Any]) -> str:
    policy = _normalize_auth_policy(job.get("auth_policy"), default="script_only")
    return "script" if policy == "script_only" else "user"


def _local_broker_write_audit(
    repo_root: Path,
    *,
    queue_job_id: int | None,
    requested_actor: str,
    effective_actor: str,
    operation_type: str,
    target_id: str,
    status: str,
    error: str | None = None,
):
    _local_broker_initialize(repo_root)
    now = _now_s()
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            """
            INSERT INTO local_sync_audit(
                queue_job_id, requested_actor, effective_actor, operation_type, target_id, status, error, created_at, finished_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(queue_job_id) if queue_job_id is not None else None,
                str(requested_actor or "unknown"),
                str(effective_actor or "unknown"),
                str(operation_type or "unknown"),
                str(target_id or ""),
                str(status or "unknown"),
                str(error or "") if error else None,
                now,
                now,
            ),
        )
    finally:
        conn.close()


def _local_broker_mark_job_failed(repo_root: Path, job: dict[str, Any], error: str):
    _local_broker_initialize(repo_root)
    attempts = int(job.get("attempts") or 1)
    retry_after = min(_LOCAL_BROKER_RETRY_MAX_SECONDS, _LOCAL_BROKER_RETRY_BASE_SECONDS * (2 ** min(6, max(0, attempts - 1))))
    next_attempt_at = _now_s() + retry_after
    now = _now_s()
    job_id = int(job["id"])
    project_id = int(job["project_id"])
    task_id = str(job["task_id"])
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            """
            UPDATE local_sync_queue
            SET status='failed', next_attempt_at=?, updated_at=?, last_error=?
            WHERE id=?
            """,
            (next_attempt_at, now, error, job_id),
        )
        conn.execute(
            """
            UPDATE local_task_overrides
            SET sync_state='failed', last_error=?, updated_at=?
            WHERE project_id=? AND task_id=?
            """,
            (error, now, project_id, task_id),
        )
    finally:
        conn.close()
    _local_broker_write_audit(
        repo_root,
        queue_job_id=job_id,
        requested_actor=_local_broker_requested_actor(job),
        effective_actor=str(job.get("effective_actor") or "none"),
        operation_type=str(job.get("op_type") or "unknown"),
        target_id=task_id,
        status="failed",
        error=error,
    )


def _local_broker_mark_job_done(
    repo_root: Path,
    job: dict[str, Any],
    *,
    remove_override: bool = True,
    delete_link: bool = False,
):
    _local_broker_initialize(repo_root)
    now = _now_s()
    job_id = int(job["id"])
    project_id = int(job["project_id"])
    task_id = str(job["task_id"])
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            """
            UPDATE local_sync_queue
            SET status='done', next_attempt_at=0, updated_at=?, last_error=NULL
            WHERE id=?
            """,
            (now, job_id),
        )
        if remove_override:
            conn.execute(
                "DELETE FROM local_task_overrides WHERE project_id=? AND task_id=?",
                (project_id, task_id),
            )
        else:
            conn.execute(
                """
                UPDATE local_task_overrides
                SET sync_state='synced', last_error=NULL, synced_at=?, updated_at=?
                WHERE project_id=? AND task_id=?
                """,
                (now, now, project_id, task_id),
            )
        if delete_link:
            _local_broker_delete_link(conn, project_id, task_id)
    finally:
        conn.close()
    _local_broker_write_audit(
        repo_root,
        queue_job_id=job_id,
        requested_actor=_local_broker_requested_actor(job),
        effective_actor=str(job.get("effective_actor") or "unknown"),
        operation_type=str(job.get("op_type") or "unknown"),
        target_id=task_id,
        status="done",
    )


def _local_broker_resolve_sg_task_id(conn: sqlite3.Connection, project_id: int, task_id: str, explicit_sg_task_id: Any = None) -> int | None:
    from_payload = _coerce_int(explicit_sg_task_id)
    if from_payload and from_payload > 0:
        return int(from_payload)
    from_numeric_id = _coerce_int(task_id)
    if from_numeric_id and from_numeric_id > 0:
        return int(from_numeric_id)
    linked = _local_broker_get_linked_sg_id(conn, int(project_id), str(task_id))
    if linked and linked > 0:
        return int(linked)
    return None


def _broadcast_stream_refresh(auth: dict[str, Any], project_id: int, reason: str = "local_sync"):
    key = _task_stream_key(auth, int(project_id))
    with _TASK_STREAMS_LOCK:
        stream = _TASK_STREAMS.get(key)
    if not stream:
        return
    stream._broadcast(  # pylint: disable=protected-access
        "refresh",
        {
            "ok": True,
            "reason": reason,
            "ts": datetime.utcnow().isoformat() + "Z",
        },
        event_id=str(int(time.time() * 1000)),
    )


def _local_broker_process_entity_create_job(
    repo_root: Path,
    auth: dict[str, Any],
    *,
    project_id: int,
    job: dict[str, Any],
    payload: dict[str, Any],
):
    normalized_entity_type = _local_broker_normalize_entity_type(payload.get("entityType"))
    if not normalized_entity_type:
        raise RuntimeError("Queued entity_create job is missing entityType")

    raw_entity = payload.get("entity")
    if not isinstance(raw_entity, dict):
        raise RuntimeError("Queued entity_create job is missing entity payload")

    normalized_entity = _local_broker_normalize_entity_payload(normalized_entity_type, raw_entity)
    if_exists = str(payload.get("ifExists") or "return_existing").strip().lower()
    existing = None
    if if_exists == "return_existing":
        existing = _local_broker_find_existing_entity(
            auth,
            project_id=int(project_id),
            entity_type=normalized_entity_type,
            entity=normalized_entity,
        )
    if existing:
        _local_broker_mark_job_done(repo_root, job, remove_override=True)
        return

    jsonapi_type, attributes, relationships = _local_broker_build_entity_create_payload(
        auth,
        project_id=int(project_id),
        entity_type=normalized_entity_type,
        entity=normalized_entity,
    )
    result = _sg_create_entity(
        auth,
        entity_type=jsonapi_type,
        attributes=attributes,
        relationships=relationships,
    )
    created_data = result.get("data") if isinstance(result.get("data"), dict) else result
    created_id = _coerce_int(created_data.get("id") if isinstance(created_data, dict) else None)
    if not created_id or created_id <= 0:
        raise RuntimeError("Entity create succeeded but returned no ID")
    _local_broker_mark_job_done(repo_root, job, remove_override=True)


def _local_broker_update_job_actor(repo_root: Path, job_id: int, *, effective_actor: str, fallback_used: bool):
    _local_broker_initialize(repo_root)
    conn = _local_broker_connect(repo_root)
    try:
        conn.execute(
            """
            UPDATE local_sync_queue
            SET effective_actor=?, fallback_used=?, updated_at=?
            WHERE id=?
            """,
            (str(effective_actor or "none"), 1 if fallback_used else 0, _now_s(), int(job_id)),
        )
    finally:
        conn.close()


def _local_broker_resolve_job_auth(repo_root: Path, job: dict[str, Any]) -> tuple[dict[str, Any], str, bool]:
    policy = _normalize_auth_policy(job.get("auth_policy"), default="script_only")
    account_id = str(job.get("auth_account_id") or "").strip() or None
    allow_script_fallback = _parse_bool(str(job.get("allow_script_fallback") or "0"))

    script_auth = _script_auth_from_env()
    if policy == "script_only":
        if not script_auth:
            raise RuntimeError("ShotGrid script auth is not configured for local auto-sync")
        _ensure_access_token(script_auth)
        return script_auth, "script", False

    user_auth: dict[str, Any] | None = None
    user_error: Exception | None = None
    if account_id:
        account_record = _auth_accounts_get(repo_root, account_id)
        user_auth = _auth_from_account_record(repo_root, account_record or {})
    if user_auth:
        try:
            _ensure_access_token(user_auth)
            return user_auth, "user", False
        except Exception as exc:  # noqa: PERF203
            user_error = exc
    else:
        user_error = RuntimeError("No remembered user account is available for queued operation.")

    if policy == "hybrid_explicit" and allow_script_fallback:
        if not script_auth:
            raise RuntimeError("Script fallback requested, but script auth is not configured.")
        _ensure_access_token(script_auth)
        return script_auth, "script", True

    if _is_reauth_required_error(user_error):
        raise RuntimeError(f"reauth_required: {user_error}")
    raise RuntimeError(str(user_error))


def _local_broker_process_queue_job(repo_root: Path, job: dict[str, Any]):
    auth, effective_actor, fallback_used = _local_broker_resolve_job_auth(repo_root, job)
    job["effective_actor"] = effective_actor
    job["fallback_used"] = 1 if fallback_used else 0
    _local_broker_update_job_actor(
        repo_root,
        int(job["id"]),
        effective_actor=effective_actor,
        fallback_used=fallback_used,
    )

    fields = _shotgrid_fields()
    project_id = int(job["project_id"])
    task_id = str(job["task_id"])
    op_type = str(job.get("op_type") or "")
    payload_json = str(job.get("payload_json") or "{}")
    try:
        payload = json.loads(payload_json)
        if not isinstance(payload, dict):
            payload = {}
    except Exception:
        payload = {}

    if op_type == "entity_create":
        _local_broker_process_entity_create_job(
            repo_root,
            auth,
            project_id=project_id,
            job=job,
            payload=payload,
        )
        _local_broker_set_last_project(repo_root, _local_broker_auth_key(auth), project_id)
        return

    conn = _local_broker_connect(repo_root)
    try:
        sg_task_id = _local_broker_resolve_sg_task_id(
            conn,
            project_id,
            task_id,
            explicit_sg_task_id=job.get("sg_task_id") or payload.get("__sg_task_id"),
        )

        if op_type == "delete" or payload.get("__deleted") is True:
            if sg_task_id:
                _sg_delete_task(auth, int(sg_task_id))
            _local_broker_mark_job_done(repo_root, job, remove_override=True, delete_link=not _is_int_like(task_id))
            _TASKS_CACHE.clear()
            with _DISK_CACHE_LOCK:
                _DISK_CACHE.clear()
            _save_disk_cache()
            _broadcast_stream_refresh(auth, project_id, reason="local_delete")
            return

        is_sparse_patch = payload.get("__sparse_patch") is True
        normalized = _local_broker_normalize_task(payload, fill_defaults=not is_sparse_patch)
        if sg_task_id and sg_task_id > 0:
            attrs, rels = _local_broker_build_sg_payload(
                auth,
                fields,
                project_id=project_id,
                task=normalized,
                include_project_rel=False,
            )
            if attrs or rels:
                _sg_update_task(auth, int(sg_task_id), attributes=attrs, relationships=(rels or None))
            _local_broker_mark_job_done(repo_root, job, remove_override=True)
            broadcast_task = dict(normalized)
            broadcast_task["Id"] = str(int(sg_task_id))
            broadcast_task["__source"] = "shotgrid"
            _broadcast_task_updates(auth, project_id, [broadcast_task])
        else:
            attrs, rels = _local_broker_build_sg_payload(
                auth,
                fields,
                project_id=project_id,
                task=normalized,
                include_project_rel=True,
            )
            if fields["task_name"] not in attrs:
                raise RuntimeError("Task Name is required to create a ShotGrid task")
            result = _sg_create_task(auth, attributes=attrs, relationships=rels or None)
            created_data = result.get("data") if isinstance(result.get("data"), dict) else result
            created_id = _coerce_int(created_data.get("id") if isinstance(created_data, dict) else None)
            if not created_id or created_id <= 0:
                raise RuntimeError("ShotGrid create succeeded but returned no task ID")
            _local_broker_set_linked_sg_id(conn, project_id, task_id, int(created_id))
            _local_broker_mark_job_done(repo_root, job, remove_override=True)
            broadcast_task = dict(normalized)
            broadcast_task["Id"] = str(int(created_id))
            broadcast_task["__source"] = "shotgrid"
            _broadcast_task_updates(auth, project_id, [broadcast_task])

        _TASKS_CACHE.clear()
        with _DISK_CACHE_LOCK:
            _DISK_CACHE.clear()
        _save_disk_cache()
        _local_broker_set_last_project(repo_root, _local_broker_auth_key(auth), project_id)
    finally:
        conn.close()


def _local_broker_worker_loop(repo_root: Path):
    _log("[uptospeed] Local sync broker worker started")
    while not _LOCAL_BROKER_STOP_EVENT.is_set():
        did_work = False
        while not _LOCAL_BROKER_STOP_EVENT.is_set():
            job = _local_broker_take_next_queue_job(repo_root)
            if not job:
                break
            did_work = True
            try:
                _local_broker_process_queue_job(repo_root, job)
            except Exception as exc:
                _local_broker_mark_job_failed(repo_root, job, str(exc))
                if _debug_enabled():
                    _log("[uptospeed] Local sync broker job failed:")
                    _log(traceback.format_exc())
        if not did_work:
            _LOCAL_BROKER_WAKE_EVENT.wait(timeout=2.0)
            _LOCAL_BROKER_WAKE_EVENT.clear()
    _log("[uptospeed] Local sync broker worker stopped")


def _local_broker_start_worker(repo_root: Path):
    global _LOCAL_BROKER_WORKER_THREAD
    _local_broker_initialize(repo_root)
    if _LOCAL_BROKER_WORKER_THREAD and _LOCAL_BROKER_WORKER_THREAD.is_alive():
        return
    _LOCAL_BROKER_STOP_EVENT.clear()
    _LOCAL_BROKER_WAKE_EVENT.clear()
    _LOCAL_BROKER_WORKER_THREAD = threading.Thread(
        target=_local_broker_worker_loop,
        args=(repo_root,),
        name="local-sync-broker-worker",
        daemon=True,
    )
    _LOCAL_BROKER_WORKER_THREAD.start()


def _local_broker_stop_worker():
    global _LOCAL_BROKER_WORKER_THREAD
    _LOCAL_BROKER_STOP_EVENT.set()
    _LOCAL_BROKER_WAKE_EVENT.set()
    thread = _LOCAL_BROKER_WORKER_THREAD
    if thread and thread.is_alive():
        thread.join(timeout=3.0)
    _LOCAL_BROKER_WORKER_THREAD = None


class ShotGridKanbanHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/agents/"):
            return self._handle_agents_get(parsed)
        if parsed.path.startswith("/api/shotgrid/"):
            return self._handle_shotgrid_get(parsed)
        if parsed.path.startswith("/api/local/"):
            return self._handle_local_get(parsed)
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/agents/"):
            return self._handle_agents_post(parsed)
        if parsed.path.startswith("/api/shotgrid/"):
            return self._handle_shotgrid_post(parsed)
        if parsed.path.startswith("/api/local/"):
            return self._handle_local_post(parsed)
        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/agents/"):
            return self._handle_agents_delete(parsed)
        if parsed.path.startswith("/api/shotgrid/"):
            return self._handle_shotgrid_delete(parsed)
        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")

    def _agent_request_user_id(self, body: dict[str, Any] | None = None, query: dict[str, list[str]] | None = None) -> str:
        headers = self.headers
        body = body if isinstance(body, dict) else {}
        query = query if isinstance(query, dict) else {}
        candidate = (
            body.get("user_id")
            or body.get("userId")
            or body.get("local_user_id")
            or body.get("localUserId")
            or query.get("user_id", [None])[0]
            or query.get("userId", [None])[0]
            or headers.get("x-uts-user-id")
        )
        return _agent_normalize_user_id(candidate)

    def _agent_request_project_scope(self, body: dict[str, Any] | None = None, query: dict[str, list[str]] | None = None) -> str:
        body = body if isinstance(body, dict) else {}
        query = query if isinstance(query, dict) else {}
        candidate = (
            body.get("project_scope")
            or body.get("projectScope")
            or body.get("project_id")
            or body.get("projectId")
            or query.get("project_scope", [None])[0]
            or query.get("projectScope", [None])[0]
            or query.get("project_id", [None])[0]
            or query.get("projectId", [None])[0]
        )
        return _agent_normalize_project_scope(candidate)

    def _handle_agents_get(self, parsed):
        repo_root = Path(str(self.directory or ".")).resolve()
        query = parse_qs(parsed.query)

        if parsed.path == "/api/agents/health":
            _agent_reconcile_stale_runs(repo_root)
            gateway_health = _agent_gateway_health()
            gateway_manifest = _agent_gateway_manifest()
            gateway_payload = gateway_health.get("payload") if isinstance(gateway_health.get("payload"), dict) else {}
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "local_server_required": True,
                    "launcher_command": _AGENT_RUNTIME_LAUNCHER_COMMAND,
                    "gateway": {
                        "ok": gateway_health.get("ok") is True,
                        "status": gateway_health.get("status"),
                        "error": gateway_health.get("error"),
                        "manifest_ok": gateway_manifest.get("ok") is True,
                        "tool_count": len(gateway_manifest.get("tools") or []),
                        "session": gateway_payload.get("session") if isinstance(gateway_payload.get("session"), dict) else {},
                    },
                    "providers": sorted(_AGENT_PROVIDER_VALUES),
                    "timestamp": _agent_now_iso(),
                },
            )

        if parsed.path == "/api/agents/catalog":
            config = _agent_get_config(repo_root)
            catalog = _agent_catalog_payload(repo_root, config)
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "catalog": catalog,
                },
            )

        if parsed.path == "/api/agents/config":
            config = _agent_get_config(repo_root)
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "config": config,
                },
            )

        if parsed.path == "/api/agents/connections":
            connections = _agent_list_connections(repo_root)
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "connections": connections,
                },
            )

        if parsed.path == "/api/agents/profiles":
            provider_id = _agent_normalize_provider(query.get("provider_id", [None])[0] or query.get("providerId", [None])[0] or "")
            active_only = str(query.get("active_only", ["0"])[0]).strip().lower() in {"1", "true", "yes", "on"}
            profiles = _agent_list_profiles(repo_root, active_only=active_only, provider_id=provider_id or None)
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "profiles": profiles,
                    "count": len(profiles),
                },
            )

        if parsed.path == "/api/agents/runs":
            user_id = self._agent_request_user_id(query=query)
            project_scope = self._agent_request_project_scope(query=query)
            try:
                limit = int(query.get("limit", [100])[0])
            except Exception:
                limit = 100
            try:
                offset = int(query.get("offset", [0])[0])
            except Exception:
                offset = 0
            runs = _agent_list_runs(repo_root, user_id=user_id, project_scope=project_scope, limit=limit, offset=offset)
            payload = [_agent_compact_run_payload(run) for run in runs]
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "runs": payload,
                    "count": len(payload),
                },
            )

        if parsed.path == "/api/agents/threads":
            user_id = self._agent_request_user_id(query=query)
            project_scope = self._agent_request_project_scope(query=query)
            include_messages = str(query.get("include_messages", ["1"])[0]).strip().lower() not in {"0", "false", "no", "off"}
            try:
                limit = int(query.get("limit", [100])[0])
            except Exception:
                limit = 100
            try:
                offset = int(query.get("offset", [0])[0])
            except Exception:
                offset = 0
            threads = _agent_list_threads(
                repo_root,
                user_id=user_id,
                project_scope=project_scope,
                limit=limit,
                offset=offset,
            )
            payload = []
            for thread in threads:
                messages = None
                if include_messages:
                    messages = _agent_list_messages(
                        repo_root,
                        thread_id=str(thread.get("id") or ""),
                        limit=500,
                        offset=0,
                    )
                payload.append(_agent_compact_thread_payload(thread, messages=messages))
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "threads": payload,
                    "count": len(payload),
                },
            )

        if parsed.path == "/api/agents/runs/stream":
            run_id = str(query.get("run_id", [None])[0] or "").strip()
            if not run_id:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "run_id is required"})
            run = _agent_get_run(repo_root, run_id)
            if not run:
                return _respond_json(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "run not found"})

            # Subscribe before sending the initial snapshot so state transitions
            # that happen during stream setup are not lost.
            subscriber = _agent_subscribe_run_stream(run_id)
            _respond_sse_headers(self)
            try:
                _sse_send(
                    self,
                    "hello",
                    {
                        "ok": True,
                        "run_id": run_id,
                        "timestamp": _agent_now_iso(),
                    },
                )
                run = _agent_get_run(repo_root, run_id) or run
                _sse_send(self, "run.status", _agent_compact_run_payload(run), event_id=f"run-{run_id}-snapshot")
                thread = _agent_get_thread(repo_root, str(run.get("thread_id") or ""))
                if thread:
                    snapshot_messages = _agent_list_messages(
                        repo_root,
                        thread_id=str(thread.get("id") or ""),
                        limit=500,
                        offset=0,
                    )
                    _sse_send(
                        self,
                        "thread.snapshot",
                        {
                            "ok": True,
                            "run_id": run_id,
                            "thread": _agent_compact_thread_payload(thread, messages=snapshot_messages),
                        },
                        event_id=f"run-{run_id}-thread-snapshot",
                    )
                snapshot_actions = _agent_list_actions(repo_root, run_id=run_id, limit=200, offset=0)
                if snapshot_actions:
                    _sse_send(
                        self,
                        "actions.snapshot",
                        {
                            "ok": True,
                            "run_id": run_id,
                            "actions": [_agent_compact_action_payload(action) for action in snapshot_actions],
                        },
                        event_id=f"run-{run_id}-actions-snapshot",
                    )
                while True:
                    try:
                        event, payload, event_id = subscriber.get(timeout=15.0)
                        _sse_send(self, event, payload, event_id=event_id)
                    except queue.Empty:
                        _sse_comment(self, "ping")
            except (BrokenPipeError, ConnectionResetError):
                return
            finally:
                _agent_unsubscribe_run_stream(run_id, subscriber)

        if parsed.path == "/api/agents/actions":
            user_id = self._agent_request_user_id(query=query)
            project_scope = self._agent_request_project_scope(query=query)
            run_id = str(query.get("run_id", [None])[0] or "").strip() or None
            status = str(query.get("status", [None])[0] or "").strip() or None
            try:
                limit = int(query.get("limit", [200])[0])
            except Exception:
                limit = 200
            try:
                offset = int(query.get("offset", [0])[0])
            except Exception:
                offset = 0
            rows = _agent_list_actions(
                repo_root,
                run_id=run_id,
                status=status,
                user_id=user_id,
                project_scope=project_scope,
                limit=limit,
                offset=offset,
            )
            payload = [_agent_compact_action_payload(row) for row in rows]
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "actions": payload,
                    "count": len(payload),
                },
            )

        if parsed.path == "/api/agents/tool-permissions":
            user_id = self._agent_request_user_id(query=query)
            project_scope = self._agent_request_project_scope(query=query)
            agent_profile_id = str(query.get("agent_profile_id", [None])[0] or query.get("agentProfileId", [None])[0] or "").strip() or None
            rows = _agent_list_tool_permissions(
                repo_root,
                user_id=user_id,
                project_scope=project_scope,
                active_only=True,
            )
            if agent_profile_id:
                rows = [
                    row
                    for row in rows
                    if str(row.get("agent_profile_id") or "").strip() in {"", agent_profile_id}
                ]
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "permissions": rows,
                    "count": len(rows),
                },
            )

        if parsed.path == "/api/agents/trust-rules":
            user_id = self._agent_request_user_id(query=query)
            project_scope = self._agent_request_project_scope(query=query)
            agent_profile_id = str(query.get("agent_profile_id", [None])[0] or query.get("agentProfileId", [None])[0] or "").strip() or None
            show_all = str(query.get("all", ["0"])[0]).strip().lower() in {"1", "true", "yes", "on"}
            rows = _agent_list_trust_rules(
                repo_root,
                user_id=user_id if not show_all else None,
                project_scope=project_scope if not show_all else None,
                active_only=True,
            )
            if agent_profile_id:
                rows = [
                    row
                    for row in rows
                    if str(row.get("agent_profile_id") or "").strip() in {"", agent_profile_id}
                ]
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "trust_rules": rows,
                    "count": len(rows),
                },
            )

        return _respond_json(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint"})

    def _handle_agents_post(self, parsed):
        repo_root = Path(str(self.directory or ".")).resolve()
        try:
            body = _parse_json_body(self) or {}
        except ValueError as exc:
            return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
        if not isinstance(body, dict):
            body = {}
        query = parse_qs(parsed.query)

        if parsed.path == "/api/agents/config":
            config = _agent_set_config(repo_root, body.get("config") if isinstance(body.get("config"), dict) else body)
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "config": config,
                },
            )

        if parsed.path == "/api/agents/provider-auth":
            provider_id = _agent_normalize_provider(body.get("provider_id") or body.get("providerId") or body.get("provider"))
            action = str(body.get("action") or "").strip().lower()
            if provider_id != "codex":
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Unsupported provider auth action."})
            if action == "start_oauth":
                ok_cli, cli_message = _agent_codex_cli_available()
                if not ok_cli:
                    _agent_upsert_connection(
                        repo_root,
                        provider="codex",
                        auth_mode="codex_cli",
                        status="error",
                        metadata={"error": cli_message, "verified_at": _agent_now_iso()},
                        tested=False,
                    )
                    return _respond_json(
                        self,
                        HTTPStatus.BAD_REQUEST,
                        {"ok": False, "error": cli_message, "provider_id": "codex"},
                    )
                snapshot = _agent_codex_start_device_auth(repo_root)
                logged_in = snapshot.get("logged_in") is True
                oauth_payload = {
                    "logged_in": logged_in,
                    "running": snapshot.get("running") is True,
                    "verification_url": str(snapshot.get("url") or "").strip(),
                    "user_code": str(snapshot.get("code") or "").strip(),
                    "error": str(snapshot.get("error") or "").strip(),
                    "status_output": str(snapshot.get("status_output") or "").strip(),
                }
                metadata = {
                    "started_at": str(snapshot.get("started_at") or _agent_now_iso()),
                    "verified_at": _agent_now_iso() if logged_in else "",
                    "running": oauth_payload["running"],
                    "url": oauth_payload["verification_url"],
                    "code": oauth_payload["user_code"],
                    "error": oauth_payload["error"],
                    "status_output": oauth_payload["status_output"],
                    "exit_code": snapshot.get("exit_code"),
                    "cli_path": cli_message,
                }
                connection = _agent_upsert_connection(
                    repo_root,
                    provider="codex",
                    auth_mode="codex_cli",
                    status="connected" if logged_in else "pending",
                    metadata=metadata,
                    secret="" if logged_in else None,
                    tested=logged_in,
                )
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "provider_id": "codex",
                        "connection": connection,
                        "oauth": oauth_payload,
                        "message": (
                            "Codex OAuth is connected."
                            if logged_in
                            else "Codex OAuth started. Open the verification URL, finish login, then click Verify."
                        ),
                    },
                )
            if action == "verify_oauth":
                ok_cli, cli_message = _agent_codex_cli_available()
                login_status = _agent_codex_login_status() if ok_cli else {
                    "logged_in": False,
                    "error": cli_message,
                    "output": "",
                    "cli_path": "",
                }
                if login_status.get("logged_in") is True:
                    connection = _agent_upsert_connection(
                        repo_root,
                        provider="codex",
                        auth_mode="codex_cli",
                        status="connected",
                        metadata={
                            "verified_at": _agent_now_iso(),
                            "status_output": str(login_status.get("output") or ""),
                            "cli_path": str(login_status.get("cli_path") or ""),
                        },
                        secret="",
                        tested=True,
                    )
                    return _respond_json(
                        self,
                        HTTPStatus.OK,
                        {
                            "ok": True,
                            "provider_id": "codex",
                            "connection": connection,
                            "oauth": {
                                "logged_in": True,
                                "running": False,
                                "verification_url": "",
                                "user_code": "",
                                "error": "",
                                "status_output": str(login_status.get("output") or ""),
                            },
                            "message": "Codex OAuth verified.",
                        },
                    )
                snapshot = _agent_codex_login_snapshot()
                if ok_cli and snapshot.get("running") is not True:
                    snapshot = _agent_codex_start_device_auth(repo_root)
                connection = _agent_upsert_connection(
                    repo_root,
                    provider="codex",
                    auth_mode="codex_cli",
                    status="pending" if ok_cli else "error",
                    metadata={
                        "started_at": str(snapshot.get("started_at") or _agent_now_iso()),
                        "running": snapshot.get("running") is True,
                        "url": str(snapshot.get("url") or ""),
                        "code": str(snapshot.get("code") or ""),
                        "error": str(snapshot.get("error") or login_status.get("error") or ""),
                        "status_output": str(snapshot.get("status_output") or login_status.get("output") or ""),
                        "exit_code": snapshot.get("exit_code"),
                        "cli_path": str(login_status.get("cli_path") or cli_message),
                    },
                    tested=False,
                )
                return _respond_json(
                    self,
                    HTTPStatus.OK if ok_cli else HTTPStatus.BAD_REQUEST,
                    {
                        "ok": ok_cli,
                        "provider_id": "codex",
                        "connection": connection,
                        "oauth": {
                            "logged_in": False,
                            "running": snapshot.get("running") is True,
                            "verification_url": str(snapshot.get("url") or ""),
                            "user_code": str(snapshot.get("code") or ""),
                            "error": str(snapshot.get("error") or login_status.get("error") or ""),
                            "status_output": str(login_status.get("output") or ""),
                        },
                        "message": "Codex OAuth is still pending. Complete login and verify again." if ok_cli else cli_message,
                    },
                )
            return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Unknown provider auth action."})

        if parsed.path in {"/api/agents/connections", "/api/agents/connections/test"}:
            provider_id = _agent_normalize_provider(body.get("provider_id") or body.get("providerId") or body.get("provider"))
            auth_mode = str(body.get("auth_mode") or body.get("authMode") or "").strip()
            secret = str(
                body.get("apiKey")
                or body.get("secret")
                or body.get("token")
                or body.get("openaiApiKey")
                or body.get("anthropicApiKey")
                or body.get("geminiApiKey")
                or ""
            ).strip()
            credential_ref = str(body.get("credential_ref") or body.get("credentialRef") or "").strip() or None
            profile_label = str(body.get("profile_label") or body.get("profileLabel") or "").strip() or None
            ok, message, connection = _agent_test_and_store_connection(
                repo_root,
                provider_id=provider_id,
                auth_mode=auth_mode,
                secret=secret,
                credential_ref=credential_ref,
                profile_label=profile_label,
            )
            status_code = HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST
            return _respond_json(
                self,
                status_code,
                {
                    "ok": ok,
                    "provider_id": provider_id,
                    "connection": connection,
                    "message": message,
                    "error": "" if ok else message,
                },
            )

        if parsed.path == "/api/agents/profiles":
            profile_payload = body.get("profile") if isinstance(body.get("profile"), dict) else body
            try:
                profile = _agent_save_profile(repo_root, profile_payload if isinstance(profile_payload, dict) else {})
                profiles = _agent_list_profiles(repo_root, active_only=False)
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "profile": profile,
                        "profiles": profiles,
                    },
                )
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/agents/connections/codex/auth/start":
            ok_cli, cli_message = _agent_codex_cli_available()
            if not ok_cli:
                _agent_upsert_connection(
                    repo_root,
                    provider="codex",
                    auth_mode="codex_cli",
                    status="error",
                    metadata={"error": cli_message, "verified_at": _agent_now_iso()},
                    tested=False,
                )
                return _respond_json(
                    self,
                    HTTPStatus.BAD_REQUEST,
                    {"ok": False, "error": cli_message, "provider_id": "codex"},
                )
            snapshot = _agent_codex_start_device_auth(repo_root)
            logged_in = snapshot.get("logged_in") is True
            oauth_payload = {
                "logged_in": logged_in,
                "running": snapshot.get("running") is True,
                "verification_url": str(snapshot.get("url") or "").strip(),
                "user_code": str(snapshot.get("code") or "").strip(),
                "error": str(snapshot.get("error") or "").strip(),
                "status_output": str(snapshot.get("status_output") or "").strip(),
            }
            metadata = {
                "started_at": str(snapshot.get("started_at") or _agent_now_iso()),
                "verified_at": _agent_now_iso() if logged_in else "",
                "running": oauth_payload["running"],
                "url": oauth_payload["verification_url"],
                "code": oauth_payload["user_code"],
                "error": oauth_payload["error"],
                "status_output": oauth_payload["status_output"],
                "exit_code": snapshot.get("exit_code"),
                "cli_path": cli_message,
            }
            connection = _agent_upsert_connection(
                repo_root,
                provider="codex",
                auth_mode="codex_cli",
                status="connected" if logged_in else "pending",
                metadata=metadata,
                secret="" if logged_in else None,
                tested=logged_in,
            )
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "provider_id": "codex",
                    "connection": connection,
                    "oauth": oauth_payload,
                    "message": (
                        "Codex OAuth is connected."
                        if logged_in
                        else "Codex OAuth started. Open the verification URL, finish login, then click Verify."
                    ),
                },
            )

        if parsed.path == "/api/agents/connections/codex/auth/verify":
            ok_cli, cli_message = _agent_codex_cli_available()
            login_status = _agent_codex_login_status() if ok_cli else {
                "logged_in": False,
                "error": cli_message,
                "output": "",
                "cli_path": "",
            }
            if login_status.get("logged_in") is True:
                connection = _agent_upsert_connection(
                    repo_root,
                    provider="codex",
                    auth_mode="codex_cli",
                    status="connected",
                    metadata={
                        "verified_at": _agent_now_iso(),
                        "status_output": str(login_status.get("output") or ""),
                        "cli_path": str(login_status.get("cli_path") or ""),
                    },
                    secret="",
                    tested=True,
                )
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "provider_id": "codex",
                        "connection": connection,
                        "oauth": {
                            "logged_in": True,
                            "running": False,
                            "verification_url": "",
                            "user_code": "",
                            "error": "",
                            "status_output": str(login_status.get("output") or ""),
                        },
                        "message": "Codex OAuth verified.",
                    },
                )
            snapshot = _agent_codex_login_snapshot()
            if ok_cli and snapshot.get("running") is not True:
                snapshot = _agent_codex_start_device_auth(repo_root)
            connection = _agent_upsert_connection(
                repo_root,
                provider="codex",
                auth_mode="codex_cli",
                status="pending" if ok_cli else "error",
                metadata={
                    "started_at": str(snapshot.get("started_at") or _agent_now_iso()),
                    "running": snapshot.get("running") is True,
                    "url": str(snapshot.get("url") or ""),
                    "code": str(snapshot.get("code") or ""),
                    "error": str(snapshot.get("error") or login_status.get("error") or ""),
                    "status_output": str(snapshot.get("status_output") or login_status.get("output") or ""),
                    "exit_code": snapshot.get("exit_code"),
                    "cli_path": str(login_status.get("cli_path") or cli_message),
                },
                tested=False,
            )
            return _respond_json(
                self,
                HTTPStatus.OK if ok_cli else HTTPStatus.BAD_REQUEST,
                {
                    "ok": ok_cli,
                    "provider_id": "codex",
                    "connection": connection,
                    "oauth": {
                        "logged_in": False,
                        "running": snapshot.get("running") is True,
                        "verification_url": str(snapshot.get("url") or ""),
                        "user_code": str(snapshot.get("code") or ""),
                        "error": str(snapshot.get("error") or login_status.get("error") or ""),
                        "status_output": str(login_status.get("output") or ""),
                    },
                    "message": "Codex OAuth is still pending. Complete login and verify again." if ok_cli else cli_message,
                },
            )

        if parsed.path == "/api/agents/connections/openai-key/test":
            ok, message, connection = _agent_test_and_store_connection(
                repo_root,
                provider_id="openai",
                auth_mode="openai_key",
                secret=str(body.get("apiKey") or body.get("openaiApiKey") or body.get("openai_key") or _env("OPENAI_API_KEY", default="") or "").strip(),
            )
            return _respond_json(
                self,
                HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST,
                {"ok": ok, "provider_id": "openai", "connection": connection, "message": message, "error": "" if ok else message},
            )

        if parsed.path == "/api/agents/connections/anthropic-key/test":
            ok, message, connection = _agent_test_and_store_connection(
                repo_root,
                provider_id="anthropic",
                auth_mode="anthropic_key",
                secret=str(body.get("apiKey") or body.get("anthropicApiKey") or body.get("anthropic_key") or _env("ANTHROPIC_API_KEY", default="") or "").strip(),
            )
            return _respond_json(
                self,
                HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST,
                {"ok": ok, "provider_id": "anthropic", "connection": connection, "message": message, "error": "" if ok else message},
            )

        if parsed.path == "/api/agents/connections/gemini-key/test":
            ok, message, connection = _agent_test_and_store_connection(
                repo_root,
                provider_id="gemini",
                auth_mode="gemini_key",
                secret=str(body.get("apiKey") or body.get("geminiApiKey") or body.get("gemini_key") or _env("GEMINI_API_KEY", default="") or "").strip(),
            )
            return _respond_json(
                self,
                HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST,
                {"ok": ok, "provider_id": "gemini", "connection": connection, "message": message, "error": "" if ok else message},
            )

        if parsed.path == "/api/agents/runs":
            prompt = str(body.get("prompt") or "").strip()
            if not prompt:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "prompt is required"})
            provider_input = body.get("provider")
            provider = _agent_normalize_provider(provider_input)
            requested_model_ref = _agent_normalize_model_ref(body.get("model_ref") or body.get("modelRef"))
            requested_agent_profile_id = str(body.get("agent_profile_id") or body.get("agentProfileId") or "").strip() or None
            project_scope = self._agent_request_project_scope(body=body, query=query)
            user_id = self._agent_request_user_id(body=body, query=query)
            config = _agent_get_config(repo_root)
            resolved_model_ref, _ = _agent_resolve_model_selection(
                config,
                requested_model_ref=requested_model_ref,
                provider_hint=provider,
                project_scope=project_scope,
            )
            provider = _agent_normalize_provider(provider or _agent_split_model_ref(resolved_model_ref)[0]) or "codex"
            resolved_profile = _agent_resolve_run_profile(
                repo_root,
                requested_profile_id=requested_agent_profile_id,
                provider_id=provider,
                model_ref=resolved_model_ref,
                project_scope=project_scope,
            )
            agent_profile_id = str(resolved_profile.get("id") or "").strip() or None
            provider = _agent_normalize_provider(resolved_profile.get("provider_id") or provider) or provider
            resolved_model_ref = _agent_normalize_model_ref(
                requested_model_ref or resolved_model_ref or resolved_profile.get("default_model_ref"),
                fallback_provider=provider,
            )

            source = str(body.get("source") or "chat").strip() or "chat"
            context = body.get("context") if isinstance(body.get("context"), dict) else {}
            reasoning_effort = str(body.get("reasoning_effort") or body.get("reasoningEffort") or "").strip()
            if reasoning_effort and "reasoning_effort" not in context:
                context["reasoning_effort"] = reasoning_effort
            task_id = str(body.get("task_id") or body.get("taskId") or context.get("taskId") or "").strip() or None
            thread_id = str(body.get("thread_id") or body.get("threadId") or "").strip()
            auth_profile_id = str(body.get("auth_profile_id") or body.get("authProfileId") or "").strip() or None
            title = str(body.get("title") or "").strip()
            if not title:
                title = prompt[:120]

            thread = _agent_get_thread(repo_root, thread_id) if thread_id else None
            existing_thread_id = str(thread.get("id") or thread_id or "").strip() if isinstance(thread, dict) else str(thread_id or "").strip()
            thread = _agent_create_thread(
                repo_root,
                user_id=user_id,
                project_scope=project_scope,
                source=source,
                task_id=task_id,
                title=title,
                provider_id=provider,
                model_ref=resolved_model_ref,
                context=context,
                thread_id=existing_thread_id or None,
            )

            user_message = _agent_append_message(
                repo_root,
                thread_id=str(thread.get("id") or ""),
                role="user",
                content=prompt,
                run_id=None,
                provider=provider,
                metadata={"source": source, "model_ref": resolved_model_ref, "provider_id": provider},
            )
            run = _agent_create_run(
                repo_root,
                thread_id=str(thread.get("id") or ""),
                user_id=user_id,
                project_scope=project_scope,
                source=source,
                provider=provider,
                provider_id=provider,
                model_ref=resolved_model_ref,
                agent_profile_id=agent_profile_id,
                auth_profile_id=auth_profile_id,
                prompt=prompt,
                context=context,
            )
            _agent_insert_audit(
                repo_root,
                user_id=user_id,
                run_id=str(run.get("id") or ""),
                action_id=None,
                event_type="run.created",
                payload={
                    "provider_id": provider,
                    "model_ref": resolved_model_ref,
                    "agent_profile_id": agent_profile_id,
                    "source": source,
                },
            )
            _agent_emit_run_event(
                str(run.get("id") or ""),
                "run.status",
                _agent_compact_run_payload(run),
                event_id=f"run-{run.get('id')}-queued",
            )
            _agent_start_run_worker(repo_root, str(run.get("id") or ""))
            return _respond_json(
                self,
                HTTPStatus.CREATED,
                {
                    "ok": True,
                    "thread": thread,
                    "message": {
                        "id": str(user_message.get("id") or ""),
                        "content": str(user_message.get("content") or ""),
                        "created_at": user_message.get("created_at"),
                    },
                    "run": _agent_compact_run_payload(run),
                },
            )

        if parsed.path == "/api/agents/actions/decision":
            action_id = str(body.get("action_id") or body.get("actionId") or "").strip()
            decision = str(body.get("decision") or "").strip().lower()
            if not action_id:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "action_id is required"})
            if decision not in {"approve", "reject", "trust"}:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "decision must be approve, reject, or trust"})
            user_id = self._agent_request_user_id(body=body, query=query)
            project_scope = self._agent_request_project_scope(body=body, query=query)
            try:
                result = _agent_decide_action(
                    repo_root,
                    action_id=action_id,
                    decision=decision,
                    decision_by=user_id,
                    user_id=user_id,
                    project_scope=project_scope,
                )
                status = HTTPStatus.OK if result.get("ok") is True else HTTPStatus.CONFLICT
                return _respond_json(self, status, result)
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/agents/runs/cancel":
            run_id = str(body.get("run_id") or body.get("runId") or "").strip()
            if not run_id:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "run_id is required"})
            user_id = self._agent_request_user_id(body=body, query=query)
            project_scope = self._agent_request_project_scope(body=body, query=query)
            try:
                result = _agent_cancel_run(
                    repo_root,
                    run_id=run_id,
                    user_id=user_id,
                    project_scope=project_scope,
                )
                status = HTTPStatus.OK if result.get("ok") is True else HTTPStatus.CONFLICT
                return _respond_json(self, status, result)
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/agents/runs/resume":
            run_id = str(body.get("run_id") or body.get("runId") or "").strip()
            if not run_id:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "run_id is required"})
            resumed = _agent_resume_run(repo_root, run_id, allowed_statuses={"interrupted"})
            if not resumed:
                return _respond_json(self, HTTPStatus.CONFLICT, {"ok": False, "error": "Run is not resumable."})
            return _respond_json(self, HTTPStatus.OK, {"ok": True, "run": _agent_compact_run_payload(resumed)})

        if parsed.path == "/api/agents/runs/retry":
            run_id = str(body.get("run_id") or body.get("runId") or "").strip()
            if not run_id:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "run_id is required"})
            resumed = _agent_retry_run_from_last_safe_point(repo_root, run_id)
            if not resumed:
                return _respond_json(self, HTTPStatus.CONFLICT, {"ok": False, "error": "Run is not retryable."})
            return _respond_json(self, HTTPStatus.OK, {"ok": True, "run": _agent_compact_run_payload(resumed)})

        if parsed.path == "/api/agents/tool-permissions":
            tool_name = str(body.get("tool_name") or body.get("toolName") or "").strip()
            permission = str(body.get("permission") or "").strip().lower() or "ask"
            user_id = self._agent_request_user_id(body=body, query=query)
            project_scope = self._agent_request_project_scope(body=body, query=query)
            agent_profile_id = str(body.get("agent_profile_id") or body.get("agentProfileId") or "").strip() or None
            field_signature = str(body.get("field_signature") or body.get("fieldSignature") or "*").strip() or "*"
            target_scope = str(body.get("target_scope") or body.get("targetScope") or "*").strip() or "*"
            if not tool_name:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "tool_name is required"})
            if permission not in {"ask", "allow", "deny", "trust"}:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "permission must be ask, allow, deny, or trust"})
            try:
                payload = None
                if permission == "ask":
                    revoked = _agent_revoke_trust_rule(
                        repo_root,
                        user_id=user_id,
                        project_scope=project_scope,
                        tool_name=tool_name,
                        agent_profile_id=agent_profile_id,
                        field_signature=field_signature,
                        target_scope=target_scope,
                    )
                else:
                    payload = _agent_set_tool_permission(
                        repo_root,
                        user_id=user_id,
                        project_scope=project_scope,
                        tool_name=tool_name,
                        permission=permission,
                        agent_profile_id=agent_profile_id,
                        field_signature=field_signature,
                        target_scope=target_scope,
                    )
                    revoked = 0
                rows = _agent_list_tool_permissions(
                    repo_root,
                    user_id=user_id,
                    project_scope=project_scope,
                    active_only=True,
                )
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "permission": payload,
                        "revoked": revoked,
                        "permissions": rows,
                    },
                )
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/agents/trust-rules/revoke":
            affected = _agent_revoke_trust_rule(
                repo_root,
                rule_id=body.get("rule_id") or body.get("ruleId"),
                user_id=body.get("user_id") or body.get("userId"),
                project_scope=body.get("project_scope") or body.get("projectScope"),
                tool_name=body.get("tool_name") or body.get("toolName"),
                agent_profile_id=body.get("agent_profile_id") or body.get("agentProfileId"),
                field_signature=body.get("field_signature") or body.get("fieldSignature"),
                target_scope=body.get("target_scope") or body.get("targetScope"),
            )
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "revoked": affected,
                },
            )

        return _respond_json(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint"})

    def _handle_local_get(self, parsed):
        repo_root = Path(str(self.directory or ".")).resolve()
        query = parse_qs(parsed.query)

        if parsed.path == "/api/local/health":
            _local_broker_initialize(repo_root)
            db_path = _local_broker_db_path(repo_root)
            worker_alive = bool(_LOCAL_BROKER_WORKER_THREAD and _LOCAL_BROKER_WORKER_THREAD.is_alive())
            encryption = _local_broker_encryption_status()
            app_root = _runtime_app_root(repo_root)
            data_dir = _runtime_data_root(repo_root)
            config_dir = _runtime_config_root(repo_root)
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "app_root": str(app_root),
                    "data_dir": str(data_dir),
                    "config_dir": str(config_dir),
                    "db_path": str(db_path),
                    "worker_alive": worker_alive,
                    "encryption": encryption,
                },
            )

        if parsed.path == "/api/local/tasks":
            try:
                auth = _select_auth(self)
                include_shotgrid = not (
                    query.get("include_shotgrid")
                    and str(query.get("include_shotgrid", ["1"])[0]).strip() in ("0", "false", "no", "off")
                )

                if include_shotgrid and not auth:
                    return _respond_json(self, HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "Not authenticated"})

                project_id = _local_broker_resolve_project_id(
                    repo_root,
                    auth or {},
                    body={},
                    query=query,
                )

                shotgrid_tasks: list[dict[str, Any]] = []
                if include_shotgrid:
                    fields = _shotgrid_fields()
                    shotgrid_tasks = _sg_fetch_tasks(auth, fields, int(project_id), [])

                merged_tasks, pending_count = _local_broker_merge_tasks(repo_root, int(project_id), shotgrid_tasks)
                queue_stats = _local_broker_fetch_queue_stats(repo_root, int(project_id))

                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "project_id": int(project_id),
                        "tasks": merged_tasks,
                        "count": len(merged_tasks),
                        "pending_overrides": int(pending_count),
                        "queue": queue_stats,
                    },
                )
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                payload: dict[str, Any] = {"ok": False, "error": str(exc), "upstream_status": int(exc.status)}
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/local/status":
            try:
                auth = _select_auth(self)
                project_id = _local_broker_resolve_project_id(
                    repo_root,
                    auth or {},
                    body={},
                    query=query,
                )
                stats = _local_broker_fetch_queue_stats(repo_root, int(project_id))
                worker_alive = bool(_LOCAL_BROKER_WORKER_THREAD and _LOCAL_BROKER_WORKER_THREAD.is_alive())
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "project_id": int(project_id),
                        "worker_alive": worker_alive,
                        **stats,
                    },
                )
            except Exception as exc:
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        return _respond_json(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint"})

    def _handle_agents_delete(self, parsed):
        repo_root = Path(str(self.directory or ".")).resolve()
        query = parse_qs(parsed.query)
        if parsed.path == "/api/agents/profiles":
            profile_id = str(query.get("profile_id", [None])[0] or query.get("profileId", [None])[0] or "").strip()
            if not profile_id:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "profile_id is required"})
            try:
                deleted = _agent_delete_profile(repo_root, profile_id)
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "deleted": deleted,
                        "profiles": _agent_list_profiles(repo_root, active_only=False),
                    },
                )
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
        return _respond_json(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint"})

    def _handle_local_post(self, parsed):
        repo_root = Path(str(self.directory or ".")).resolve()
        query = parse_qs(parsed.query)

        if parsed.path == "/api/local/apply":
            try:
                body = _parse_json_body(self) or {}
                if not isinstance(body, dict):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must be a JSON object"})
                auth_ctx = _resolve_request_auth(self, repo_root, body=body)
                auth = auth_ctx.get("auth") if isinstance(auth_ctx, dict) else None
                if auth_ctx.get("legacy") is False and not auth:
                    payload: dict[str, Any] = {
                        "ok": False,
                        "error": str(auth_ctx.get("error") or "Not authenticated"),
                        "reauth_required": bool(auth_ctx.get("reauth_required")),
                    }
                    _inject_auth_metadata(payload, auth_ctx)
                    status = HTTPStatus.UNAUTHORIZED if bool(auth_ctx.get("reauth_required")) else HTTPStatus.BAD_REQUEST
                    return _respond_json(self, status, payload)

                operations = body.get("operations")
                if not isinstance(operations, list):
                    operations = []

                # Backward-compatible single-operation shape.
                if not operations:
                    if isinstance(body.get("operation"), dict):
                        operations = [body["operation"]]
                    elif body.get("taskId") and isinstance(body.get("updates"), dict):
                        operations = [{"type": "update", "taskId": body.get("taskId"), "updates": body.get("updates")}]
                    elif isinstance(body.get("task"), dict) or isinstance(body.get("taskData"), dict):
                        operations = [{"type": "create", "task": body.get("task") or body.get("taskData")}]

                if not operations:
                    return _respond_json(
                        self,
                        HTTPStatus.BAD_REQUEST,
                        {"ok": False, "error": "Body must include operations: [...]"},
                    )

                project_id = _local_broker_resolve_project_id(
                    repo_root,
                    auth,
                    body=body,
                    query=query,
                )

                source = str(body.get("source") or "api")
                result = _local_broker_apply_operations(
                    repo_root,
                    auth,
                    project_id=int(project_id),
                    operations=operations,
                    source=source,
                    auth_context=auth_ctx,
                )
                _inject_auth_metadata(result, auth_ctx)
                _local_broker_set_last_project(repo_root, _local_broker_auth_key(auth if isinstance(auth, dict) else {}), int(project_id))
                status = HTTPStatus.OK if result.get("ok", False) else HTTPStatus.CONFLICT
                return _respond_json(self, status, result)
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                payload: dict[str, Any] = {"ok": False, "error": str(exc), "upstream_status": int(exc.status)}
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/local/sync-now":
            try:
                body = _parse_json_body(self) or {}
                if not isinstance(body, dict):
                    body = {}
                auth_ctx = _resolve_request_auth(self, repo_root, body=body)
                auth = auth_ctx.get("auth") if isinstance(auth_ctx, dict) else None
                if auth_ctx.get("legacy") is False and not auth:
                    payload: dict[str, Any] = {
                        "ok": False,
                        "error": str(auth_ctx.get("error") or "Not authenticated"),
                        "reauth_required": bool(auth_ctx.get("reauth_required")),
                    }
                    _inject_auth_metadata(payload, auth_ctx)
                    status = HTTPStatus.UNAUTHORIZED if bool(auth_ctx.get("reauth_required")) else HTTPStatus.BAD_REQUEST
                    return _respond_json(self, status, payload)
                wait_for_completion = _parse_bool(str(body.get("wait"))) if body else False
                max_wait_s = float(body.get("max_wait_s") or 5.0)
                max_wait_s = max(0.1, min(30.0, max_wait_s))

                processed = 0
                failed = 0
                _LOCAL_BROKER_WAKE_EVENT.set()

                if wait_for_completion:
                    deadline = _now_s() + max_wait_s
                    while _now_s() < deadline:
                        job = _local_broker_take_next_queue_job(repo_root)
                        if not job:
                            break
                        processed += 1
                        try:
                            _local_broker_process_queue_job(repo_root, job)
                        except Exception as exc:
                            failed += 1
                            _local_broker_mark_job_failed(repo_root, job, str(exc))
                            if _debug_enabled():
                                _log(traceback.format_exc())

                project_id = _local_broker_resolve_project_id(repo_root, auth or {}, body=body, query=query)
                stats = _local_broker_fetch_queue_stats(repo_root, int(project_id))
                payload = {
                    "ok": True,
                    "project_id": int(project_id),
                    "processed": processed,
                    "failed": failed,
                    "worker_alive": bool(_LOCAL_BROKER_WORKER_THREAD and _LOCAL_BROKER_WORKER_THREAD.is_alive()),
                    **stats,
                }
                _inject_auth_metadata(payload, auth_ctx)
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    payload,
                )
            except Exception as exc:
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        return _respond_json(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint"})

    def _handle_shotgrid_get(self, parsed):
        repo_root = Path(str(self.directory or ".")).resolve()
        if parsed.path == "/api/shotgrid/health":
            session = _session_auth(_get_session(self))
            script = _script_auth_from_env()
            mode = "user" if session else ("script" if script else "none")
            env_base = _env("SHOTGRID_URL", "SG_URL")
            default_site_url = _normalize_base_url(env_base) if env_base else ""
            base_url = ""
            if session and session.get("base_url"):
                base_url = str(session.get("base_url") or "")
            elif script and script.get("base_url"):
                base_url = str(script.get("base_url") or "")

            ok = False
            authenticated = False
            error = ""
            effective_actor = "none"
            reauth_required = bool(session.get("reauth_required")) if isinstance(session, dict) else False
            auth_policy = (
                _normalize_auth_policy(session.get("auth_policy"), default="user_only")
                if isinstance(session, dict)
                else "script_only"
            )
            fallback_allowed = bool(session.get("allow_script_fallback")) if isinstance(session, dict) else False
            fallback_used = bool(session.get("fallback_used_last")) if isinstance(session, dict) else False
            try:
                if session:
                    authenticated = True
                    _ensure_access_token(session)
                    ok = True
                    effective_actor = "user"
                    reauth_required = False
                    session["reauth_required"] = False
                elif script:
                    _ensure_access_token(script)
                    ok = True
                    effective_actor = "script"
                else:
                    ok = False
                    error = "Not authenticated. Configure SHOTGRID_* script credentials or sign in with your ShotGrid account."
            except Exception as exc:
                ok = False
                authenticated = False
                error = str(exc)
                reauth_required = _is_reauth_required_error(exc)
                if session is not None:
                    session["reauth_required"] = reauth_required
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": ok,
                    "mode": mode,
                    "authenticated": authenticated,
                    "script_configured": script is not None,
                    "base_url": base_url,
                    "default_site_url": default_site_url,
                    "shotgun_api3_installed": False,
                    "project_id": _env_int("SHOTGRID_PROJECT_ID", "SG_PROJECT_ID"),
                    "account": _session_account_public(session),
                    "auth_policy": auth_policy,
                    "fallback_allowed": fallback_allowed,
                    "effective_actor": effective_actor,
                    "fallback_used": fallback_used,
                    "reauth_required": reauth_required,
                    "error": error,
                },
            )

        if parsed.path == "/api/shotgrid/auth/status":
            session = _session_auth(_get_session(self))
            script = _script_auth_from_env()
            mode = "user" if session else ("script" if script else "none")
            auth = session or script
            authenticated = False
            base_url = str(auth.get("base_url") or "") if isinstance(auth, dict) else ""
            error = ""
            effective_actor = "none"
            reauth_required = bool(session.get("reauth_required")) if isinstance(session, dict) else False
            auth_policy = (
                _normalize_auth_policy(session.get("auth_policy"), default="user_only")
                if isinstance(session, dict)
                else "script_only"
            )
            fallback_allowed = bool(session.get("allow_script_fallback")) if isinstance(session, dict) else False
            fallback_used = bool(session.get("fallback_used_last")) if isinstance(session, dict) else False
            if auth:
                try:
                    _ensure_access_token(auth)
                    authenticated = True
                    effective_actor = "user" if mode == "user" else "script"
                    reauth_required = False
                    if session is not None:
                        session["reauth_required"] = False
                except Exception as exc:
                    authenticated = False
                    error = str(exc)
                    reauth_required = _is_reauth_required_error(exc)
                    if session is not None:
                        session["reauth_required"] = reauth_required
            return _respond_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "authenticated": authenticated,
                    "mode": mode,
                    "base_url": base_url,
                    "script_configured": script is not None,
                    "account": _session_account_public(session),
                    "auth_policy": auth_policy,
                    "fallback_allowed": fallback_allowed,
                    "effective_actor": effective_actor,
                    "fallback_used": fallback_used,
                    "reauth_required": reauth_required,
                    "error": error,
                },
            )

        if parsed.path == "/api/shotgrid/projects":
            try:
                auth = _select_auth(self)
                if not auth:
                    return _respond_json(self, HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "Not authenticated"})
                projects = _sg_list_projects(auth)
                return _respond_json(self, HTTPStatus.OK, {"ok": True, "projects": projects})
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                _log(f"[uptospeed] ShotGrid API error {exc.status} on {parsed.path}: {exc}")
                payload: dict[str, Any] = {
                    "ok": False,
                    "error": str(exc),
                    "upstream_status": int(exc.status),
                }
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                _log(f"[uptospeed] Internal error on {parsed.path}: {exc}")
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/shotgrid/task-notes":
            try:
                auth = _select_auth(self)
                if not auth:
                    return _respond_json(self, HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "Not authenticated"})

                query = parse_qs(parsed.query)
                raw_task_id = query.get("task_id", [None])[0]
                task_id = _coerce_int(raw_task_id)
                if not task_id or task_id <= 0:
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "task_id is required"})
                include_replies = _parse_bool(query.get("include_replies", ["1"])[0])

                threads = _sg_task_notes_threads(auth, int(task_id), include_replies=include_replies)
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "task_id": str(task_id),
                        "threads": threads,
                    },
                )
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                _log(f"[uptospeed] ShotGrid API error {exc.status} on {parsed.path}: {exc}")
                payload: dict[str, Any] = {
                    "ok": False,
                    "error": str(exc),
                    "upstream_status": int(exc.status),
                }
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                _log(f"[uptospeed] Internal error on {parsed.path}: {exc}")
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/shotgrid/stream":
            return self._handle_shotgrid_stream(parsed)

        if parsed.path == "/api/shotgrid/tasks":
            try:
                auth = _select_auth(self)
                if not auth:
                    return _respond_json(self, HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "Not authenticated"})
                fields = _shotgrid_fields()
                project_id = _env_int("SHOTGRID_PROJECT_ID", "SG_PROJECT_ID")
                query = parse_qs(parsed.query)
                if query.get("project_id"):
                    project_id = int(query["project_id"][0])
                force = _parse_bool(query.get("force", [None])[0])

                if not project_id:
                    return _respond_json(
                        self,
                        HTTPStatus.BAD_REQUEST,
                        {"ok": False, "error": "Missing project id. Set SHOTGRID_PROJECT_ID or pass ?project_id=..."},
                    )

                def apply_local_overlay(base_payload: dict[str, Any]) -> dict[str, Any]:
                    payload_with_local = dict(base_payload or {})
                    tasks = payload_with_local.get("tasks")
                    if not isinstance(tasks, list):
                        return payload_with_local
                    merged_tasks, pending_count = _local_broker_merge_tasks(repo_root, int(project_id), tasks)
                    payload_with_local["tasks"] = merged_tasks
                    payload_with_local["count"] = len(merged_tasks)
                    payload_with_local["local_pending_overrides"] = int(pending_count)
                    return payload_with_local

                filters = [["project", "is", {"type": "Project", "id": project_id}]]

                # Optional: filter by status codes (?status=ip,sch)
                status_values: list[str] = []
                if query.get("status"):
                    status_values = [s.strip() for s in ",".join(query.get("status", [])).split(",") if s.strip()]
                    if status_values:
                        filters.append([fields["status"], "in", status_values])

                ttl = _cache_ttl_seconds()
                auth_key = "script"
                if auth.get("mode") == "user" and auth.get("id"):
                    auth_key = f"user:{auth.get('id')}"
                cache_key = f"auth:{auth_key}|project:{project_id}|status:{','.join(status_values)}"
                now = time.time()
                if not force:
                    cached = _TASKS_CACHE.get(cache_key)
                    if cached and cached.get("payload"):
                        expires_at = float(cached.get("expires_at", 0) or 0)
                        payload = apply_local_overlay(cached["payload"])
                        payload["cached"] = True
                        if ttl > 0 and expires_at > now:
                            remaining = max(0, int(expires_at - now))
                            payload["stale"] = False
                            return _respond_json(
                                self,
                                HTTPStatus.OK,
                                payload,
                                extra_headers={
                                    "Cache-Control": f"private, max-age={remaining}",
                                    "X-Cache": "HIT",
                                },
                            )
                        payload["stale"] = True
                        return _respond_json(
                            self,
                            HTTPStatus.OK,
                            payload,
                            extra_headers={
                                "Cache-Control": "no-store",
                                "X-Cache": "STALE",
                            },
                        )

                    with _DISK_CACHE_LOCK:
                        disk_entry = _DISK_CACHE.get(cache_key)
                    if disk_entry and disk_entry.get("payload"):
                        base_payload = disk_entry["payload"]
                        fetched_at = disk_entry.get("fetched_at")
                        remaining = 0
                        fresh = False
                        if ttl > 0 and isinstance(fetched_at, str):
                            try:
                                dt = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
                                age = now - dt.timestamp()
                                if age < ttl:
                                    remaining = max(0, int(ttl - age))
                                    fresh = True
                            except Exception:
                                fresh = False

                        payload = apply_local_overlay(base_payload)
                        payload["cached"] = True
                        payload["stale"] = not fresh

                        if fresh:
                            _TASKS_CACHE[cache_key] = {"expires_at": now + remaining, "payload": base_payload}
                            return _respond_json(
                                self,
                                HTTPStatus.OK,
                                payload,
                                extra_headers={
                                    "Cache-Control": f"private, max-age={remaining}",
                                    "X-Cache": "HIT",
                                },
                            )

                        # Prime in-memory cache as stale to avoid repeated disk reads.
                        _TASKS_CACHE[cache_key] = {"expires_at": 0, "payload": base_payload}
                        return _respond_json(
                            self,
                            HTTPStatus.OK,
                            payload,
                            extra_headers={
                                "Cache-Control": "no-store",
                                "X-Cache": "STALE",
                            },
                        )

                mapped = _sg_fetch_tasks(auth, fields, project_id, status_values)
                base_payload = {"ok": True, "tasks": mapped, "count": len(mapped)}
                if ttl > 0:
                    _TASKS_CACHE[cache_key] = {"expires_at": now + ttl, "payload": base_payload}
                with _DISK_CACHE_LOCK:
                    _DISK_CACHE[cache_key] = {
                        "payload": base_payload,
                        "fetched_at": datetime.utcnow().isoformat() + "Z",
                    }
                _save_disk_cache()
                payload = apply_local_overlay(base_payload)
                payload["cached"] = False
                payload["stale"] = False
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    payload,
                    extra_headers={
                        "Cache-Control": f"private, max-age={ttl}",
                        "X-Cache": "MISS",
                    }
                    if ttl > 0
                    else {"Cache-Control": "no-store"},
                )
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                _log(f"[uptospeed] ShotGrid API error {exc.status} on {parsed.path}: {exc}")
                payload: dict[str, Any] = {
                    "ok": False,
                    "error": str(exc),
                    "upstream_status": int(exc.status),
                }
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                _log(f"[uptospeed] Internal error on {parsed.path}: {exc}")
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        return _respond_json(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint"})

    def _handle_shotgrid_stream(self, parsed):
        # Streams task updates as Server-Sent Events (SSE).
        try:
            auth = _select_auth(self)
            fields = _shotgrid_fields()
            query = parse_qs(parsed.query)

            if not auth:
                _respond_sse_headers(self)
                _sse_send(self, "sg_error", {"ok": False, "error": "Not authenticated"})
                return

            project_id = _env_int("SHOTGRID_PROJECT_ID", "SG_PROJECT_ID")
            if query.get("project_id"):
                project_id = int(query["project_id"][0])

            if not project_id:
                _respond_sse_headers(self)
                _sse_send(
                    self,
                    "sg_error",
                    {"ok": False, "error": "Missing project id. Set SHOTGRID_PROJECT_ID or pass ?project_id=..."},
                )
                return

            interval = 5.0
            if query.get("interval"):
                try:
                    interval = float(query["interval"][0])
                except Exception:
                    interval = 5.0
            interval = min(60.0, max(1.0, interval))

            max_updates = 200
            if query.get("max_updates"):
                try:
                    max_updates = int(query["max_updates"][0])
                except Exception:
                    max_updates = 200
            max_updates = min(2000, max(10, max_updates))

            since = _parse_iso_datetime(query.get("since", [None])[0]) or datetime.utcnow()

            sg_fields = [
                fields["task_name"],
                fields["entity"],
                fields["project"],
                fields["status"],
                fields["start"],
                fields["end"],
                fields["assignees"],
                fields["step"],
                "updated_at",
            ]
            if fields.get("dept_prod_note"):
                sg_fields.append(fields["dept_prod_note"])
            if fields.get("target_status_summary"):
                sg_fields.append(fields["target_status_summary"])
            if fields.get("task_comments"):
                sg_fields.append(fields["task_comments"])

            _respond_sse_headers(self)
            _sse_send(
                self,
                "hello",
                {
                    "ok": True,
                    "project_id": project_id,
                    "interval": interval,
                    "now": datetime.utcnow().isoformat() + "Z",
                },
            )

            # Best-effort catch-up for callers resuming from an earlier "since" timestamp.
            try:
                poll_since = since - timedelta(seconds=1)
                poll_since_utc = poll_since.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
                filters = [
                    ["project", "is", {"type": "Project", "id": project_id}],
                    ["updated_at", "greater_than", poll_since_utc],
                ]
                tasks = _sg_search_records(auth, "tasks", filters, sg_fields, page_size=500, max_pages=2) or []
                changed: list[dict[str, Any]] = []
                for task in tasks:
                    if not isinstance(task, dict):
                        continue
                    attrs = task.get("attributes") if isinstance(task.get("attributes"), dict) else {}
                    updated_at_raw = attrs.get("updated_at")
                    mapped = _task_record_to_uptospeed(task, fields)
                    mapped["__updated_at"] = _iso_datetime(updated_at_raw)
                    changed.append(mapped)
                if len(changed) > max_updates:
                    _sse_send(
                        self,
                        "refresh",
                        {
                            "ok": True,
                            "reason": "catchup_too_many_updates",
                            "count": len(changed),
                            "ts": datetime.utcnow().isoformat() + "Z",
                        },
                    )
                elif changed:
                    _sse_send(
                        self,
                        "task_updates",
                        {"ok": True, "count": len(changed), "updates": changed, "ts": datetime.utcnow().isoformat() + "Z"},
                        event_id=str(int(time.time() * 1000)),
                    )
            except Exception as exc:
                _sse_send(self, "sg_error", {"ok": False, "error": str(exc), "ts": datetime.utcnow().isoformat() + "Z"})

            stream, subscriber = _subscribe_task_stream(
                auth=auth,
                fields=fields,
                project_id=int(project_id),
                interval=interval,
                max_updates=max_updates,
            )

            last_write = time.time()
            try:
                while True:
                    try:
                        event, payload, event_id = subscriber.queue.get(timeout=15)
                        _sse_send(self, event, payload, event_id=event_id)
                        last_write = time.time()
                    except queue.Empty:
                        if time.time() - last_write > 15:
                            _sse_comment(self, "ping")
                            last_write = time.time()
            finally:
                _unsubscribe_task_stream(stream, subscriber)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            return

    def _handle_shotgrid_post(self, parsed):
        repo_root = Path(str(self.directory or ".")).resolve()
        if parsed.path == "/api/shotgrid/auth/logout":
            try:
                body = _parse_json_body(self) or {}
                if not isinstance(body, dict):
                    body = {}
                forget_account = _parse_bool(str(body.get("forget_account") or body.get("forgetAccount") or "0"))
                session = _get_session(self)
                account_id = str(session.get("account_id") or "").strip() if isinstance(session, dict) else ""
                forgot = False
                if forget_account and account_id:
                    forgot = _auth_accounts_delete(repo_root, account_id)
                header = _clear_session(self)
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "forgot_account": bool(forgot),
                        "account_id": account_id or None,
                    },
                    extra_headers={"Set-Cookie": header},
                )
            except Exception as exc:
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/shotgrid/auth/resume":
            try:
                body = _parse_json_body(self) or {}
                if not isinstance(body, dict):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must be a JSON object"})

                account_id = str(body.get("account_id") or body.get("accountId") or "").strip()
                if not account_id:
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "account_id is required"})

                account_record = _auth_accounts_get(repo_root, account_id)
                if not account_record:
                    return _respond_json(
                        self,
                        HTTPStatus.NOT_FOUND,
                        {"ok": False, "error": "account_not_found", "account_id": account_id},
                    )

                auth = _auth_from_account_record(repo_root, account_record)
                if not auth:
                    return _respond_json(
                        self,
                        HTTPStatus.NOT_FOUND,
                        {"ok": False, "error": "account_not_found", "account_id": account_id},
                    )

                try:
                    _ensure_access_token(auth)
                except Exception as exc:
                    if _is_reauth_required_error(exc):
                        payload = {
                            "ok": False,
                            "error": "reauth_required",
                            "reauth_required": True,
                            "account": _account_public_dict(account_record),
                        }
                        return _respond_json(self, HTTPStatus.UNAUTHORIZED, payload)
                    raise

                policy = _normalize_auth_policy(
                    body.get("auth_policy") or body.get("authPolicy") or body.get("policy"),
                    default="user_only",
                )
                if policy == "script_only":
                    policy = "user_only"
                allow_script_fallback = _parse_bool(
                    str(body.get("allow_script_fallback") or body.get("allowScriptFallback") or "0")
                )

                session, set_cookie = _get_or_create_session(self)
                for key in (
                    "access_token",
                    "refresh_token",
                    "access_expires_at",
                    "refresh_expires_at",
                    "base_url",
                    "mode",
                    "account_id",
                    "auth_policy",
                    "allow_script_fallback",
                    "fallback_used_last",
                    "remembered",
                    "grant_type",
                    "login",
                    "name",
                    "sg_user_id",
                    "repo_root",
                    "reauth_required",
                ):
                    session.pop(key, None)
                session["mode"] = "user"
                session["repo_root"] = str(repo_root)
                session["base_url"] = str(auth.get("base_url") or "")
                session["grant_type"] = str(auth.get("grant_type") or "")
                session["account_id"] = account_id
                session["auth_policy"] = policy
                session["allow_script_fallback"] = allow_script_fallback
                session["fallback_used_last"] = False
                session["remembered"] = True
                session["reauth_required"] = False
                session["login"] = str(account_record.get("login") or "").strip()
                session["name"] = str(account_record.get("display_name") or "").strip()
                session["sg_user_id"] = _coerce_int(account_record.get("sg_user_id"))
                session["access_token"] = str(auth.get("access_token") or "")
                session["refresh_token"] = str(auth.get("refresh_token") or "")
                session["access_expires_at"] = float(auth.get("access_expires_at") or 0)
                session["refresh_expires_at"] = float(auth.get("refresh_expires_at") or 0)
                _persist_auth_account_if_needed(session)

                headers: dict[str, str] = {}
                if set_cookie:
                    headers["Set-Cookie"] = set_cookie
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "mode": "user",
                        "base_url": str(session.get("base_url") or ""),
                        "account": _session_account_public(session),
                        "remembered": True,
                        "effective_actor": "user",
                        "fallback_used": False,
                    },
                    extra_headers=headers or None,
                )
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            except ShotGridAuthError as exc:
                upstream_status = int(exc.status)
                status = HTTPStatus.UNAUTHORIZED if upstream_status in (400, 401) else _coerce_http_error_status(upstream_status, fallback=HTTPStatus.UNAUTHORIZED)
                payload: dict[str, Any] = {"ok": False, "error": str(exc), "upstream_status": upstream_status}
                hint = _shotgrid_hint(upstream_status, str(exc))
                if hint:
                    payload["hint"] = hint
                return _respond_json(self, status, payload)
            except Exception as exc:
                _log(f"[uptospeed] Internal error on {parsed.path}: {exc}")
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/shotgrid/auth/login":
            try:
                body = _parse_json_body(self)
                if not isinstance(body, dict):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must be a JSON object"})

                raw_base_url = (
                    body.get("base_url")
                    or body.get("site_url")
                    or body.get("shotgrid_url")
                    or body.get("url")
                    or _env("SHOTGRID_URL", "SG_URL")
                )
                base_url = _validate_base_url(str(raw_base_url) if raw_base_url is not None else None)
                remember_me = True
                if "remember_me" in body or "rememberMe" in body:
                    remember_me = _parse_bool(str(body.get("remember_me") if "remember_me" in body else body.get("rememberMe")))
                requested_policy = _normalize_auth_policy(
                    body.get("auth_policy") or body.get("authPolicy") or body.get("policy"),
                    default="user_only",
                )
                if requested_policy == "script_only":
                    requested_policy = "user_only"
                allow_script_fallback = _parse_bool(
                    str(body.get("allow_script_fallback") or body.get("allowScriptFallback") or "0")
                )
                requested_account_id = str(body.get("account_id") or body.get("accountId") or "").strip() or None

                raw_grant = str(body.get("grant_type") or "").strip()
                if raw_grant:
                    grant_type = raw_grant
                elif body.get("session_token") or body.get("sessionToken"):
                    grant_type = "session_token"
                else:
                    grant_type = "password"

                token_payload: dict[str, Any]
                login_hint = ""
                if grant_type == "password":
                    username = body.get("username") or body.get("user") or body.get("login")
                    password = body.get("password") or body.get("passphrase") or body.get("token")
                    if not username or not password:
                        return _respond_json(
                            self,
                            HTTPStatus.BAD_REQUEST,
                            {"ok": False, "error": "Missing username/password. Use your ShotGrid API passphrase (not your Autodesk password)."},
                        )
                    form: dict[str, str] = {
                        "grant_type": "password",
                        "username": str(username).strip(),
                        "password": str(password).strip(),
                    }
                    login_hint = str(username).strip()
                    auth_token = body.get("auth_token") or body.get("otp") or body.get("two_factor") or body.get("mfa")
                    if auth_token and str(auth_token).strip():
                        form["auth_token"] = str(auth_token).strip()
                    token_payload = _sg_request_token(base_url, form)
                elif grant_type == "session_token":
                    session_token = body.get("session_token") or body.get("sessionToken")
                    if not session_token or not str(session_token).strip():
                        return _respond_json(
                            self,
                            HTTPStatus.BAD_REQUEST,
                            {"ok": False, "error": "Missing session_token."},
                        )
                    token_payload = _sg_request_token(
                        base_url,
                        {
                            "grant_type": "session_token",
                            "session_token": str(session_token).strip(),
                        },
                    )
                else:
                    return _respond_json(
                        self,
                        HTTPStatus.BAD_REQUEST,
                        {"ok": False, "error": f"Unsupported grant_type: {grant_type}"},
                    )

                session, set_cookie = _get_or_create_session(self)
                for key in (
                    "access_token",
                    "refresh_token",
                    "access_expires_at",
                    "refresh_expires_at",
                    "base_url",
                    "mode",
                    "account_id",
                    "auth_policy",
                    "allow_script_fallback",
                    "fallback_used_last",
                    "remembered",
                    "grant_type",
                    "login",
                    "name",
                    "sg_user_id",
                    "repo_root",
                    "reauth_required",
                ):
                    session.pop(key, None)
                session["mode"] = "user"
                session["repo_root"] = str(repo_root)
                session["base_url"] = base_url
                session["grant_type"] = grant_type
                session["remembered"] = bool(remember_me)
                session["auth_policy"] = requested_policy
                session["allow_script_fallback"] = allow_script_fallback
                session["fallback_used_last"] = False
                session["reauth_required"] = False
                _store_oauth_tokens(session, token_payload)

                identity = _sg_lookup_identity_for_login(session, login_hint)
                if identity:
                    session["login"] = str(identity.get("login") or login_hint or "").strip()
                    session["name"] = str(identity.get("name") or "").strip()
                    session["sg_user_id"] = _coerce_int(identity.get("id"))
                elif login_hint:
                    session["login"] = login_hint
                    session["name"] = str(session.get("name") or "").strip()
                    session["sg_user_id"] = _coerce_int(session.get("sg_user_id"))

                account_id = requested_account_id
                if not account_id:
                    existing_account = _auth_accounts_find(
                        repo_root,
                        base_url=base_url,
                        login=str(session.get("login") or "").strip(),
                        sg_user_id=_coerce_int(session.get("sg_user_id")),
                    )
                    if existing_account:
                        account_id = str(existing_account.get("account_id") or "").strip() or None
                if not account_id:
                    account_id = _new_account_id()
                session["account_id"] = account_id
                _persist_auth_account_if_needed(session)

                headers: dict[str, str] = {}
                if set_cookie:
                    headers["Set-Cookie"] = set_cookie
                return _respond_json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "mode": "user",
                        "base_url": str(session.get("base_url") or ""),
                        "account": _session_account_public(session),
                        "remembered": bool(session.get("remembered")),
                        "effective_actor": "user",
                        "fallback_used": False,
                    },
                    extra_headers=headers or None,
                )
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            except ShotGridAuthError as exc:
                upstream_status = int(exc.status)
                status = HTTPStatus.UNAUTHORIZED if upstream_status in (400, 401) else _coerce_http_error_status(upstream_status, fallback=HTTPStatus.UNAUTHORIZED)
                _log(f"[uptospeed] ShotGrid auth error {exc.status} on {parsed.path}: {exc}")
                payload: dict[str, Any] = {"ok": False, "error": str(exc), "upstream_status": upstream_status}
                hint = _shotgrid_hint(upstream_status, str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                extra = f" ({exc.url})" if getattr(exc, "url", "") else ""
                _log(f"[uptospeed] ShotGrid API error {exc.status} on {parsed.path}{extra}: {exc}")
                payload: dict[str, Any] = {"ok": False, "error": str(exc), "upstream_status": int(exc.status)}
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                _log(f"[uptospeed] Internal error on {parsed.path}: {exc}")
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/shotgrid/task-notes":
            try:
                body = _parse_json_body(self) or {}
                if not isinstance(body, dict):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must be a JSON object"})
                auth_ctx = _resolve_request_auth(self, repo_root, body=body)
                auth = auth_ctx.get("auth")
                if not auth:
                    payload: dict[str, Any] = {
                        "ok": False,
                        "error": str(auth_ctx.get("error") or "Not authenticated"),
                        "reauth_required": bool(auth_ctx.get("reauth_required")),
                    }
                    _inject_auth_metadata(payload, auth_ctx)
                    return _respond_json(self, HTTPStatus.UNAUTHORIZED, payload)

                task_id = _coerce_int(body.get("task_id") or body.get("taskId"))
                if not task_id or task_id <= 0:
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "task_id is required"})

                content = str(body.get("content") or "").strip()
                if not content:
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "content is required"})

                client_op_id = str(body.get("client_op_id") or body.get("clientOpId") or "").strip()
                subject = body.get("subject")
                reply_to_note_id = _coerce_int(body.get("reply_to_note_id") or body.get("replyToNoteId"))

                if reply_to_note_id and reply_to_note_id > 0:
                    if not _sg_task_has_note(auth, int(task_id), int(reply_to_note_id)):
                        return _respond_json(
                            self,
                            HTTPStatus.BAD_REQUEST,
                            {"ok": False, "error": "reply_to_note_id must reference a note linked to task_id"},
                        )
                    result = _sg_create_reply_for_note(auth, note_id=int(reply_to_note_id), content=content)
                    created = result.get("data") if isinstance(result.get("data"), dict) else result
                    created_id = _coerce_int(created.get("id") if isinstance(created, dict) else None)
                    payload = {
                        "ok": True,
                        "client_op_id": client_op_id,
                        "created": {
                            "entity_type": "Reply",
                            "sg_reply_id": created_id,
                            "sg_entity_id": created_id,
                            "reply_to_note_id": int(reply_to_note_id),
                        },
                    }
                    _inject_auth_metadata(payload, auth_ctx)
                    return _respond_json(
                        self,
                        HTTPStatus.CREATED,
                        payload,
                    )

                result = _sg_create_note_for_task(
                    auth,
                    task_id=int(task_id),
                    content=content,
                    subject=str(subject).strip() if subject is not None else None,
                )
                created = result.get("data") if isinstance(result.get("data"), dict) else result
                created_id = _coerce_int(created.get("id") if isinstance(created, dict) else None)
                payload = {
                    "ok": True,
                    "client_op_id": client_op_id,
                    "created": {
                        "entity_type": "Note",
                        "sg_note_id": created_id,
                        "sg_entity_id": created_id,
                        "task_id": str(task_id),
                    },
                }
                _inject_auth_metadata(payload, auth_ctx)
                return _respond_json(
                    self,
                    HTTPStatus.CREATED,
                    payload,
                )
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                _log(f"[uptospeed] ShotGrid API error {exc.status} on {parsed.path}: {exc}")
                payload: dict[str, Any] = {"ok": False, "error": str(exc), "upstream_status": int(exc.status)}
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                _log(f"[uptospeed] Internal error on {parsed.path}: {exc}")
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/shotgrid/entities/create":
            try:
                body = _parse_json_body(self) or {}
                if not isinstance(body, dict):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must be a JSON object"})
                auth_ctx = _resolve_request_auth(self, repo_root, body=body)
                auth = auth_ctx.get("auth")
                if not auth:
                    payload: dict[str, Any] = {
                        "ok": False,
                        "error": str(auth_ctx.get("error") or "Not authenticated"),
                        "reauth_required": bool(auth_ctx.get("reauth_required")),
                    }
                    _inject_auth_metadata(payload, auth_ctx)
                    return _respond_json(self, HTTPStatus.UNAUTHORIZED, payload)

                raw_entity_type = body.get("entityType") or body.get("entity_type") or body.get("type")
                entity_type = _local_broker_normalize_entity_type(raw_entity_type)
                if not entity_type:
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Unsupported or missing entityType"})

                raw_entity = body.get("entity")
                if not isinstance(raw_entity, dict):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must include entity: {...}"})

                raw_project_id = body.get("project_id") or body.get("projectId") or body.get("project")
                project_id = None
                if raw_project_id is not None and str(raw_project_id).strip() != "":
                    try:
                        project_id = int(raw_project_id)
                    except Exception:
                        return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid project_id"})
                if not project_id:
                    project_id = _env_int("SHOTGRID_PROJECT_ID", "SG_PROJECT_ID")
                if not project_id:
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Missing project_id"})

                if_exists = str(body.get("ifExists") or body.get("if_exists") or "return_existing").strip().lower()
                if if_exists not in ("return_existing",):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"Unsupported ifExists policy: {if_exists}"})

                normalized_entity = _local_broker_normalize_entity_payload(entity_type, raw_entity)
                existing = None
                if if_exists == "return_existing":
                    existing = _local_broker_find_existing_entity(
                        auth,
                        project_id=int(project_id),
                        entity_type=entity_type,
                        entity=normalized_entity,
                    )

                if existing:
                    payload = {"ok": True, "entityType": entity_type, "existing": True, "entity": existing}
                    _inject_auth_metadata(payload, auth_ctx)
                    return _respond_json(
                        self,
                        HTTPStatus.OK,
                        payload,
                    )

                jsonapi_type, attributes, relationships = _local_broker_build_entity_create_payload(
                    auth,
                    project_id=int(project_id),
                    entity_type=entity_type,
                    entity=normalized_entity,
                )
                result = _sg_create_entity(
                    auth,
                    entity_type=jsonapi_type,
                    attributes=attributes,
                    relationships=relationships,
                )
                created = result.get("data") if isinstance(result.get("data"), dict) else result
                if not isinstance(created, dict):
                    return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "Entity created but no payload returned"})
                payload = {"ok": True, "entityType": entity_type, "existing": False, "entity": created}
                _inject_auth_metadata(payload, auth_ctx)
                return _respond_json(
                    self,
                    HTTPStatus.CREATED,
                    payload,
                )
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                _log(f"[uptospeed] ShotGrid API error {exc.status} on {parsed.path}: {exc}")
                payload: dict[str, Any] = {"ok": False, "error": str(exc), "upstream_status": int(exc.status)}
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                _log(f"[uptospeed] Internal error on {parsed.path}: {exc}")
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/shotgrid/tasks/create":
            try:
                body = _parse_json_body(self) or {}
                if not isinstance(body, dict):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must be a JSON object"})
                auth_ctx = _resolve_request_auth(self, repo_root, body=body)
                auth = auth_ctx.get("auth")
                if not auth:
                    payload: dict[str, Any] = {
                        "ok": False,
                        "error": str(auth_ctx.get("error") or "Not authenticated"),
                        "reauth_required": bool(auth_ctx.get("reauth_required")),
                    }
                    _inject_auth_metadata(payload, auth_ctx)
                    return _respond_json(self, HTTPStatus.UNAUTHORIZED, payload)
                fields = _shotgrid_fields()

                # Resolve project_id
                raw_project_id = body.get("project_id") or body.get("projectId") or body.get("project")
                project_id = None
                if raw_project_id is not None and str(raw_project_id).strip() != "":
                    try:
                        project_id = int(raw_project_id)
                    except Exception:
                        return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid project_id"})
                if not project_id:
                    project_id = _env_int("SHOTGRID_PROJECT_ID", "SG_PROJECT_ID")
                if not project_id:
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Missing project_id"})

                task_data = body.get("task") if isinstance(body, dict) else None
                if not isinstance(task_data, dict):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must include {task: {...}}"})

                task_name = str(task_data.get("Task Name") or "").strip()
                if not task_name:
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Task Name is required"})

                attributes: dict[str, Any] = {fields["task_name"]: task_name}
                relationships: dict[str, Any] = {
                    fields["project"]: {"data": {"type": "projects", "id": str(project_id)}}
                }

                # Status
                if task_data.get("Status"):
                    normalized_status = _normalize_shotgrid_task_status(task_data.get("Status"))
                    if normalized_status:
                        attributes[fields["status"]] = normalized_status

                # Start / End dates
                if task_data.get("Start"):
                    attributes[fields["start"]] = task_data["Start"]
                if task_data.get("End"):
                    attributes[fields["end"]] = task_data["End"]

                # Pipeline Step (department)
                raw_step = str(task_data.get("Pipeline Step") or "").strip()
                if raw_step:
                    try:
                        relationships.update(
                            _resolve_shotgrid_step_relationship(
                                auth,
                                fields=fields,
                                raw_step=raw_step,
                            )
                        )
                    except RuntimeError:
                        return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"Unknown pipeline step: {raw_step}"})

                # Entity link (Asset or Shot)
                raw_link = str(task_data.get("Link") or "").strip()
                if raw_link:
                    entity = _sg_find_entity_by_name(auth, raw_link, project_id=project_id)
                    if not entity:
                        return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"Could not find Asset or Shot named '{raw_link}' in ShotGrid"})
                    sg_type = entity["type"].lower() + "s"  # "Asset" -> "assets"
                    relationships[fields["entity"]] = {"data": {"type": sg_type, "id": str(entity["id"])}}

                # Assignees
                raw_assignees = str(task_data.get("Assigned To") or "").strip()
                if raw_assignees:
                    names = [n.strip() for n in raw_assignees.split(",") if n.strip()]
                    people = []
                    for name in names:
                        user = _sg_find_human_user_by_name(auth, name)
                        if user and user.get("id"):
                            people.append({"type": "human_users", "id": str(user["id"])})
                    if people:
                        relationships[fields["assignees"]] = {"data": people}

                # Optional custom fields
                if fields.get("dept_prod_note") and task_data.get("Dept Prod Note"):
                    attributes[fields["dept_prod_note"]] = task_data["Dept Prod Note"]
                if fields.get("target_status_summary") and task_data.get("Target Status Summary"):
                    attributes[fields["target_status_summary"]] = task_data["Target Status Summary"]
                if fields.get("task_comments") and task_data.get("Task Comments"):
                    attributes[fields["task_comments"]] = task_data["Task Comments"]

                result = _sg_create_task(auth, attributes=attributes, relationships=relationships)

                # Extract the created task ID from the response.
                # JSON:API format nests under "data", flat format returns directly.
                sg_task_id = None
                if isinstance(result, dict):
                    created_data = result.get("data") if isinstance(result.get("data"), dict) else result
                    sg_task_id = created_data.get("id")

                if not sg_task_id:
                    return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "Task created but no ID returned"})

                # Re-fetch the created task so we return the full mapped record
                mapped_task = None
                try:
                    fetched = _sg_fetch_tasks(auth, fields, project_id, [])
                    mapped_task = next((t for t in fetched if str(t.get("Id")) == str(sg_task_id)), None)
                except Exception:
                    pass

                if not mapped_task:
                    # Build a minimal mapped task from what we know
                    mapped_task = {
                        "Id": str(sg_task_id),
                        "Task Name": task_name,
                        "Link": raw_link,
                        "Pipeline Step": raw_step,
                        "Status": task_data.get("Status") or "",
                        "Assigned To": raw_assignees,
                        "Start": task_data.get("Start") or "",
                        "End": task_data.get("End") or "",
                        "Duration": str(_calc_business_days(task_data.get("Start") or "", task_data.get("End") or "")),
                        "Project": "",
                        "__source": "shotgrid",
                    }

                # Invalidate cache
                _TASKS_CACHE.clear()

                payload = {"ok": True, "task": mapped_task, "sg_task_id": str(sg_task_id)}
                _inject_auth_metadata(payload, auth_ctx)
                return _respond_json(self, HTTPStatus.CREATED, payload)
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                _log(f"[uptospeed] ShotGrid API error {exc.status} on {parsed.path}: {exc}")
                payload: dict[str, Any] = {"ok": False, "error": str(exc), "upstream_status": int(exc.status)}
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                _log(f"[uptospeed] Internal error on {parsed.path}: {exc}")
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        if parsed.path == "/api/shotgrid/tasks/push":
            try:
                body = _parse_json_body(self) or {}
                if not isinstance(body, dict):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must be a JSON object"})
                auth_ctx = _resolve_request_auth(self, repo_root, body=body)
                auth = auth_ctx.get("auth")
                if not auth:
                    payload: dict[str, Any] = {
                        "ok": False,
                        "error": str(auth_ctx.get("error") or "Not authenticated"),
                        "reauth_required": bool(auth_ctx.get("reauth_required")),
                    }
                    _inject_auth_metadata(payload, auth_ctx)
                    return _respond_json(self, HTTPStatus.UNAUTHORIZED, payload)
                fields = _shotgrid_fields()

                project_id = None
                raw_project_id = body.get("project_id") or body.get("projectId") or body.get("project")
                if raw_project_id is not None and str(raw_project_id).strip() != "":
                    try:
                        project_id = int(raw_project_id)
                    except Exception:
                        return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid project_id"})

                updates = body.get("updates")
                if not isinstance(updates, list):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must be {updates: [...]}"})

                dry_run = _parse_bool(str(body.get("dry_run")))

                results = []
                did_write = False
                for item in updates:
                    if not isinstance(item, dict):
                        continue
                    raw_id = item.get("Id")
                    if not raw_id:
                        continue
                    try:
                        task_id = int(raw_id)
                    except Exception:
                        results.append({"Id": raw_id, "ok": False, "error": "Invalid task id"})
                        continue

                    attributes: dict[str, Any] = {}
                    relationships: dict[str, Any] = {}
                    if "Task Name" in item:
                        attributes[fields["task_name"]] = item.get("Task Name") or ""
                    if "Status" in item:
                        normalized_status = _normalize_shotgrid_task_status(item.get("Status"))
                        if normalized_status:
                            attributes[fields["status"]] = normalized_status
                    if "Start" in item:
                        attributes[fields["start"]] = item.get("Start") or None
                    if "End" in item:
                        attributes[fields["end"]] = item.get("End") or None

                    # Pipeline Step (relationship)
                    if "Pipeline Step" in item:
                        raw_step = str(item.get("Pipeline Step") or "").strip()
                        try:
                            relationships.update(
                                _resolve_shotgrid_step_relationship(
                                    auth,
                                    fields=fields,
                                    raw_step=raw_step,
                                )
                            )
                        except RuntimeError:
                            results.append({"Id": str(task_id), "ok": False, "error": f"Unknown pipeline step: {raw_step}"})
                            continue

                    # Optional/custom field pushes if configured.
                    if fields.get("dept_prod_note") and "Dept Prod Note" in item:
                        attributes[fields["dept_prod_note"]] = item.get("Dept Prod Note") or ""
                    if fields.get("target_status_summary") and "Target Status Summary" in item:
                        attributes[fields["target_status_summary"]] = item.get("Target Status Summary") or ""
                    if fields.get("task_comments") and "Task Comments" in item:
                        attributes[fields["task_comments"]] = item.get("Task Comments") or ""

                    # Resolve assignees by display name (comma-separated).
                    if "Assigned To" in item:
                        names = [n.strip() for n in str(item.get("Assigned To") or "").split(",") if n.strip()]
                        if not names:
                            relationships[fields["assignees"]] = {"data": []}
                        else:
                            people = []
                            unresolved = []
                            for name in names:
                                user = _sg_find_human_user_by_name(auth, name)
                                if not user or not user.get("id"):
                                    unresolved.append(name)
                                    continue
                                people.append({"type": "human_users", "id": str(user["id"])})
                            if unresolved:
                                results.append({"Id": str(task_id), "ok": False, "error": f"Unknown assignee(s): {', '.join(unresolved)}"})
                                continue
                            relationships[fields["assignees"]] = {"data": people}

                    if not attributes and not relationships:
                        results.append({"Id": str(task_id), "ok": True, "skipped": True})
                        continue

                    if dry_run:
                        results.append(
                            {
                                "Id": str(task_id),
                                "ok": True,
                                "dry_run": True,
                                "attributes": attributes,
                                "relationships": relationships,
                            }
                        )
                        continue

                    _sg_update_task(auth, task_id, attributes=attributes, relationships=(relationships or None))
                    did_write = True
                    results.append({"Id": str(task_id), "ok": True})

                if did_write:
                    ok_ids = {str(r.get("Id")) for r in results if r and r.get("ok") is True and not r.get("skipped")}
                    applied_updates = [u for u in updates if isinstance(u, dict) and str(u.get("Id")) in ok_ids]
                    _TASKS_CACHE.clear()
                    if applied_updates:
                        with _DISK_CACHE_LOCK:
                            for entry in _DISK_CACHE.values():
                                payload = entry.get("payload")
                                if isinstance(payload, dict):
                                    _apply_updates_to_cached_payload(payload, applied_updates)
                        _save_disk_cache()
                        if project_id:
                            _broadcast_task_updates(auth, int(project_id), applied_updates)
                payload = {"ok": True, "results": results}
                _inject_auth_metadata(payload, auth_ctx)
                return _respond_json(self, HTTPStatus.OK, payload)
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                _log(f"[uptospeed] ShotGrid API error {exc.status} on {parsed.path} (url={exc.url!r}): {exc}")
                payload: dict[str, Any] = {"ok": False, "error": str(exc), "upstream_status": int(exc.status)}
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                _log(f"[uptospeed] Internal error on {parsed.path}: {exc}")
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        return _respond_json(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint"})

    def _handle_shotgrid_delete(self, parsed):
        repo_root = Path(str(self.directory or ".")).resolve()
        if parsed.path == "/api/shotgrid/task-notes":
            try:
                body = _parse_json_body(self) or {}
                if not isinstance(body, dict):
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Body must be a JSON object"})
                auth_ctx = _resolve_request_auth(self, repo_root, body=body)
                auth = auth_ctx.get("auth")
                if not auth:
                    payload: dict[str, Any] = {
                        "ok": False,
                        "error": str(auth_ctx.get("error") or "Not authenticated"),
                        "reauth_required": bool(auth_ctx.get("reauth_required")),
                    }
                    _inject_auth_metadata(payload, auth_ctx)
                    return _respond_json(self, HTTPStatus.UNAUTHORIZED, payload)

                raw_entity_type = str(body.get("entity_type") or body.get("entityType") or "").strip().lower()
                if raw_entity_type in ("note", "notes"):
                    entity_type = "notes"
                elif raw_entity_type in ("reply", "replies"):
                    entity_type = "replies"
                else:
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "entity_type must be Note or Reply"})

                entity_id = _coerce_int(body.get("entity_id") or body.get("entityId"))
                if not entity_id or entity_id <= 0:
                    return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": "entity_id is required"})

                client_op_id = str(body.get("client_op_id") or body.get("clientOpId") or "").strip()
                _sg_delete_entity(auth, entity_type=entity_type, entity_id=int(entity_id))
                payload = {"ok": True, "client_op_id": client_op_id}
                _inject_auth_metadata(payload, auth_ctx)
                return _respond_json(self, HTTPStatus.OK, payload)
            except ValueError as exc:
                return _respond_json(self, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            except ShotGridApiError as exc:
                status = _coerce_http_error_status(exc.status)
                _log(f"[uptospeed] ShotGrid API error {exc.status} on {parsed.path}: {exc}")
                payload: dict[str, Any] = {"ok": False, "error": str(exc), "upstream_status": int(exc.status)}
                hint = _shotgrid_hint(int(exc.status), str(exc))
                if hint:
                    payload["hint"] = hint
                if _debug_enabled():
                    payload["upstream_url"] = exc.url
                    payload["upstream_payload"] = exc.payload
                return _respond_json(self, status, payload)
            except Exception as exc:
                _log(f"[uptospeed] Internal error on {parsed.path}: {exc}")
                if _debug_enabled():
                    _log(traceback.format_exc())
                return _respond_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

        return _respond_json(self, HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint"})


def main() -> int:
    repo_root = _runtime_app_root(Path(__file__).resolve().parents[1])
    _load_dotenv(repo_root)
    _load_disk_cache(repo_root)
    _local_broker_initialize(repo_root)
    _agent_reconcile_stale_runs(repo_root)
    _local_broker_start_worker(repo_root)
    encryption = _local_broker_encryption_status()
    port = int(_env("PORT", "SHOTGRID_PROXY_PORT", default="7331") or "7331")
    host = _env("HOST", default="127.0.0.1") or "127.0.0.1"

    class QuietThreadingHTTPServer(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            _, exc, _ = sys.exc_info()
            if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
                return
            return super().handle_error(request, client_address)

    handler_cls = lambda *args, **kwargs: ShotGridKanbanHandler(*args, directory=str(repo_root), **kwargs)  # type: ignore
    httpd = QuietThreadingHTTPServer((host, port), handler_cls)

    print(f"[uptospeed] Serving UI on http://{host}:{port}")
    print(f"[uptospeed] API health: http://{host}:{port}/api/shotgrid/health")
    if encryption["enabled"]:
        print(f"[uptospeed] Local broker DB encryption: SQLCipher (key source: {encryption['key_source']})")
    else:
        print("[uptospeed] Local broker DB encryption: disabled (plaintext)")
    print("[uptospeed] Press Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[uptospeed] Shutting down...")
        _local_broker_stop_worker()
        return 0
    finally:
        _local_broker_stop_worker()


if __name__ == "__main__":
    raise SystemExit(main())
