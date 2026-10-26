"""Reusable pieces of the page: the dictionary panel and the review table."""
from __future__ import annotations

import logging
from collections import Counter

import streamlit as st

from ..config import DICT_CACHE_TTL
from ..core.dictionary_source import DictionarySource
from .secrets import Secrets

log = logging.getLogger("romanize.ui")


@st.cache_data(show_spinner=False, ttl=DICT_CACHE_TTL)
def fetch_dictionary(url: str):
    """Download a dictionary doc, cached for DICT_CACHE_TTL.

    Caching lives here rather than in DictionarySource so the core stays free of
    Streamlit. Because the timestamp is produced inside the cached call, it reports
    when the bytes were actually fetched, not when they were last read.
    """
    return DictionarySource.fetch(url)


class DictionaryPanel:
    """Loads the selected language's dictionary, with Reload and upload override."""

    def __init__(self):
        self.source = DictionarySource(secret_lookup=Secrets.get)

    def render(self, language: str):
        """Render the dictionary row and return its bytes, or None if unavailable."""
        head, btn = st.columns([6, 1])
        head.markdown(f"**📚 {language} Dictionary** — loaded automatically from the "
                      "shared Google Doc, so it's always the experts' latest version.")
        if btn.button("🔄 Reload", key="reload_dict", use_container_width=True,
                      help="Fetch the newest version of the doc right now"):
            fetch_dictionary.clear()
            st.rerun()

        # Filled in after the override widget below is created, so the status line
        # renders above the override expander regardless of which source wins.
        slot = st.empty()
        with st.expander("⚙️ Override — use a different dictionary file instead"):
            override = st.file_uploader("Dictionary (.docx)", type=["docx"],
                                        key="srt_dict_override")

        if override is not None:
            slot.info(f"📎 Using your uploaded file `{override.name}` "
                      f"instead of the shared {language} doc.")
            return override.getvalue()

        # No doc mapped for this language yet — say so plainly instead of quietly
        # falling back to another language's dictionary, which would corrupt output.
        url = self.source.url_for(language)
        if not url:
            slot.warning(
                f"📭 No dictionary is configured for **{language}**. Set "
                f"`{self.source.env_var_for(language)}` to its Google Doc link — in "
                "`.env` locally, or **Settings → Secrets** on Streamlit Cloud — or "
                "upload one via **Override** above. Romanization still works without "
                "it; you just lose the pre-substitution and the correction pass.")
            return None

        try:
            with st.spinner(f"Loading the latest {language} dictionary…"):
                data, fetched_at = fetch_dictionary(url)
            slot.success(f"✅ {language} dictionary loaded ({len(data) // 1024} KB, "
                         f"fetched {fetched_at}).")
            return data
        except Exception as e:
            log.exception("Dictionary auto-load failed for %s", language)
            slot.error(
                f"❌ Couldn't load the {language} dictionary: "
                f"{e}  Open the **Override** section above and upload a copy "
                "to continue.")
            return None


class ReviewTable:
    """The tick-what-you-want correction review."""

    @staticmethod
    def _render_readonly_tier(title, items, color, note):
        """Exact dictionary fixes — always applied, shown for reference (no checkbox)."""
        if not items:
            return
        st.markdown(f"#### {title}")
        if note:
            st.caption(note)
        counts = Counter((c["orig"], c["repl"]) for c in items)
        for (orig, corr), cnt in sorted(counts.items(), key=lambda x: -x[1]):
            c1, c2, c3 = st.columns([3, 3, 1])
            c1.markdown(f"<span style='color:red;font-weight:bold'>{orig}</span>",
                        unsafe_allow_html=True)
            c2.markdown(f"<span style='background:{color};padding:2px 10px;"
                        f"border-radius:4px;font-weight:bold'>{corr}</span>",
                        unsafe_allow_html=True)
            c3.markdown(f"×**{cnt}**")

    @staticmethod
    def _render_checkbox_tier(title, items, color, tier, scan_id):
        """Render an engine tier with a tick column. Returns the accepted (orig, repl) set.

        Keys include scan_id so a fresh scan starts every box unticked instead of
        inheriting stale state mapped to different rows.
        """
        sel = set()
        if not items:
            return sel
        st.markdown(f"#### {title}")
        counts = Counter((c["orig"], c["repl"]) for c in items)
        confs = {(c["orig"], c["repl"]): c["conf"] for c in items}
        rows = sorted(counts.items(), key=lambda x: -x[1])

        all_on = st.checkbox(f"Accept all {len(rows)}", key=f"selall_{scan_id}_{tier}")

        h0, h1, h2, h3, h4 = st.columns([0.7, 3, 3, 1, 1])
        h0.markdown("<b>Use</b>", unsafe_allow_html=True)
        h1.markdown("<b>Wrong (in file)</b>", unsafe_allow_html=True)
        h2.markdown("<b>Correction</b>", unsafe_allow_html=True)
        h3.markdown("<b>Conf.</b>", unsafe_allow_html=True)
        h4.markdown("<b>Count</b>", unsafe_allow_html=True)
        for i, ((orig, corr), cnt) in enumerate(rows):
            c0, c1, c2, c3, c4 = st.columns([0.7, 3, 3, 1, 1])
            checked = c0.checkbox("keep", key=f"sel_{scan_id}_{tier}_{i}",
                                  disabled=all_on, label_visibility="collapsed")
            c1.markdown(f"<span style='color:red;font-weight:bold'>{orig}</span>",
                        unsafe_allow_html=True)
            c2.markdown(f"<span style='background:{color};padding:2px 10px;"
                        f"border-radius:4px;font-weight:bold'>{corr}</span>",
                        unsafe_allow_html=True)
            c3.markdown(f"{confs[(orig, corr)]*100:.0f}%")
            c4.markdown(f"**{cnt}**")
            if all_on or checked:
                sel.add((orig, corr))
        return sel

    @classmethod
    def render(cls, all_changes, n_pairs, scan_id):
        """Metrics + always-applied exact tier + tickable engine tiers. Returns the
        set of accepted engine (orig, repl) pairs."""
        by_tier = {"exact": [], "fix": [], "suggest": []}
        for ch in all_changes:
            by_tier[ch["tier"]].append(ch)

        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Dictionary Pairs", n_pairs)
        m2.metric("✅ Dictionary Fixes", len(by_tier["exact"]))
        m3.metric("🟢 Engine Fixes", len(by_tier["fix"]))
        m4.metric("🔵 Engine Guesses", len(by_tier["suggest"]))

        cls._render_readonly_tier("✅ Confirmed Dictionary Fixes (always applied)",
                                  by_tier["exact"], "yellow",
                                  "Exact matches from your dictionary — always applied.")
        sel = set()
        sel |= cls._render_checkbox_tier("🟢 Engine Fixes — tick to keep", by_tier["fix"],
                                         "#9bffb0", "fix", scan_id)
        sel |= cls._render_checkbox_tier("🔵 Engine Guesses — tick to keep",
                                         by_tier["suggest"], "#9bf6ff", "suggest", scan_id)
        if not by_tier["fix"] and not by_tier["suggest"]:
            st.caption("No engine suggestions to review (engine off, or none found).")
        return sel
