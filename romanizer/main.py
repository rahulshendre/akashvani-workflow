"""Entry point: page chrome, sidebar, and the staged flow.

Run with:  streamlit run app.py
"""
from __future__ import annotations

import logging
import os

import streamlit as st

# Load ANTHROPIC_API_KEY (and friends) from a local .env if present. python-dotenv
# strips the whitespace around `KEY = value`, so the existing .env format works.
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:  # pragma: no cover - optional dependency
    pass

from .config import DICT_CACHE_TTL
from .core.cache import RomanizationCache
from .core.dictionary_source import DictionarySource
from .core.tracing import tracing_enabled
from .ui.page import RomanizerPage, STATE_KEY
from .ui.notify import DesktopNotifier
from .ui.secrets import Secrets
from .ui.usage_view import UsageView

# Logging — shows in the terminal where you ran `streamlit run app.py`
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-5s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("romanize.app")


def render_header():
    st.markdown("""
    <h1 style='color:#E05C00;'>📖 PlanetRead – Romanizer</h1>
    <p style='font-size:14px;'>
      <span style='background:yellow;padding:2px 8px;border-radius:4px;'>yellow</span>
      = confirmed dictionary fix &nbsp;·&nbsp;
      <span style='background:#9bffb0;padding:2px 8px;border-radius:4px;'>green</span>
      = engine fix (please confirm) &nbsp;·&nbsp;
      <span style='background:#9bf6ff;padding:2px 8px;border-radius:4px;'>cyan</span>
      = engine guess (review carefully)
    </p>
    <hr>
""", unsafe_allow_html=True)


def render_sidebar() -> bool:
    """Draw the sidebar. Returns whether the pattern engine is enabled."""
    enable_engine = st.sidebar.checkbox("🧠 Enable AI pattern engine", value=True)
    st.sidebar.caption(
        "Learns spelling-correction patterns from your dictionary and applies them to "
        "words **not** in the table. Offline, no internet. ~75–80% precise on novel words, "
        "so its fixes are flagged for your review, never silently applied."
    )

    st.sidebar.divider()
    DesktopNotifier.permission_control()

    st.sidebar.divider()
    # Show WHICH languages this deployment can actually correct. Without it the
    # only way to find out is to select each language in turn and read the error.
    configured = DictionarySource(secret_lookup=Secrets.get).configured_languages()
    if configured:
        st.sidebar.caption(f"📚 Dictionaries configured: **{', '.join(configured)}**.")
    else:
        st.sidebar.caption("📚 **No dictionaries configured.** Romanization works, but "
                           "no corrections will be applied.")
    st.sidebar.caption(
        f"Each is pulled from its shared Google Doc and re-checked every "
        f"{DICT_CACHE_TTL // 60} min — use **🔄 Reload** in step ① to pick up an "
        "expert's edit immediately. Doc links are configuration "
        "(`DICTIONARY_DOC_URL_<LANGUAGE>`), never stored in the code."
    )

    st.sidebar.divider()
    st.sidebar.caption(
        "Romanized SRTs are cached on disk by file + language, so re-running the same "
        "file never calls Anthropic again."
    )
    if st.sidebar.button("🧹 Clear romanization cache"):
        n = RomanizationCache().clear()
        st.session_state.pop(STATE_KEY, None)
        st.sidebar.success(f"Cleared {n} cached romanization(s).")

    st.sidebar.divider()
    if tracing_enabled():
        project = os.getenv("LANGSMITH_PROJECT") or "default"
        st.sidebar.caption(
            f"📊 **LangSmith tracing ON** → project `{project}`. Each romanized file is "
            "one trace; token usage & cost show up at smith.langchain.com. "
            "(Cached files make no API call, so they cost nothing.)"
        )
    else:
        st.sidebar.caption(
            "📊 LangSmith tracing is OFF. Set `LANGSMITH_TRACING=true` (and "
            "`LANGSMITH_API_KEY`) in your `.env` / Secrets to track cost & traces."
        )
    return enable_engine


def render_footer():
    st.markdown("<br><hr><p style='text-align:center; color:#aaa; font-size:13px;'>"
                "PlanetRead · Romanized Shabdkosh Tool</p>", unsafe_allow_html=True)


def main():
    st.set_page_config(page_title="PlanetRead – Romanizer", page_icon="📖", layout="wide")
    render_header()
    enable_engine = render_sidebar()
    RomanizerPage(enable_engine).render()
    UsageView.render()
    # Last, so it fires only after the page (and its result) has been drawn.
    DesktopNotifier.render()
    render_footer()
