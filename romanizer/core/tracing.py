"""Optional LangSmith tracing + cost tracking.

Everything here is a no-op unless the `langsmith` package is installed AND
LANGSMITH_TRACING is truthy. LangSmith reads the rest of its config itself from
the LANGSMITH_API_KEY / LANGSMITH_ENDPOINT / LANGSMITH_PROJECT env vars.
"""
from __future__ import annotations

import logging
import os

log = logging.getLogger("romanize.tracing")

try:
    from langsmith import traceable
except Exception:  # langsmith not installed — make @traceable(...) a passthrough
    def traceable(*d_args, **d_kwargs):
        if len(d_args) == 1 and callable(d_args[0]) and not d_kwargs:
            return d_args[0]            # used bare:  @traceable
        return lambda fn: fn            # used with args:  @traceable(...)


def tracing_enabled() -> bool:
    """True if LangSmith tracing is switched on via the LANGSMITH_TRACING env var."""
    return os.getenv("LANGSMITH_TRACING", "").strip().lower() in ("1", "true", "yes", "on")


def wrap_client(client):
    """Wrap an Anthropic client so every call logs its token usage, which LangSmith
    turns into a $ cost. Returns the plain client if tracing is off or wrapping
    fails for any reason — observability must never break romanization."""
    if not tracing_enabled():
        return client
    try:
        from langsmith.wrappers import wrap_anthropic
        wrapped = wrap_anthropic(client)
        log.info("LangSmith tracing enabled (project=%s)",
                 os.getenv("LANGSMITH_PROJECT") or "default")
        return wrapped
    except Exception as e:
        log.warning("LANGSMITH_TRACING is on but tracing couldn't start: %s", e)
        return client


def trace_inputs(inputs: dict) -> dict:
    """What a romanization run logs as its trace inputs — deliberately NOT the raw
    file bytes and NEVER the api_key, just enough to identify the run."""
    return {
        "language": inputs.get("language"),
        "source_bytes": len(inputs.get("data") or b""),
        "use_cache": inputs.get("use_cache", True),
    }


def trace_outputs(out) -> dict:
    try:
        _text, stats = out
        return {"stats": stats}
    except Exception:
        return {}
