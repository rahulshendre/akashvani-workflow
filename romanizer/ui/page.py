"""The staged page: romanize first, then correct, then download."""
from __future__ import annotations

import logging
import time

import streamlit as st

from ..config import LANGUAGES
from ..core.dictionary import Dictionary
from ..core.consistency import ConsistencyChecker
from ..core.presubstitute import PreSubstitutor
from ..core.punctuation import PunctuationNormalizer
from ..core.romanizer import Romanizer, anthropic_available
from ..core.srt import SrtDocument
from ..core.usage import UsageLog
from ..corrections.corrector import DocumentCorrector
from ..corrections.outputs import OutputBuilder
from .components import DictionaryPanel, ReviewTable
from .errors import ApiErrorFormatter
from .notify import DesktopNotifier
from .secrets import Secrets

log = logging.getLogger("romanize.page")

STATE_KEY = "srt_result"


class RomanizerPage:
    """Renders the whole flow and owns the session state it depends on."""

    def __init__(self, enable_engine: bool):
        self.enable_engine = enable_engine
        self.dictionary_panel = DictionaryPanel()

    # ── state ────────────────────────────────────────────────────────────────
    @property
    def result(self):
        return st.session_state.get(STATE_KEY)

    @result.setter
    def result(self, value):
        st.session_state[STATE_KEY] = value

    # ── the page ─────────────────────────────────────────────────────────────
    def render(self):
        st.markdown(
            "Pick the language, upload the native-script subtitle, and it is romanized "
            "with **Claude** — then corrected against the Universal Dictionary, which "
            "loads itself from the experts' shared Google Doc so it is always current."
        )

        has_key = bool(Secrets.api_key())
        if not anthropic_available():
            st.error("The `anthropic` package isn't installed. Run "
                     "`pip install -r requirements.txt`.")
        elif not has_key:
            st.warning("⚠️ No `ANTHROPIC_API_KEY` found. Add it to a `.env` file (local) or "
                       "to **Secrets** (Streamlit Cloud), e.g. `ANTHROPIC_API_KEY = sk-ant-...`.")

        language, srt_file, dict_bytes = self._step_one_inputs()
        self._step_one_romanize(language, srt_file, dict_bytes, has_key)

        if not srt_file:
            st.info("👆 Upload a native-script `.srt` and choose its language.")

        res = self.result
        if not res:
            return

        self._show_romanized(res)
        self._step_two_corrections(res, dict_bytes)

        if not res.get("scanned"):
            return

        selected = self._review(res)
        self._build(res, selected)

        built = res.get("built")
        if not built:
            st.info("Tick the corrections you want, then click **Build files** above. "
                    "(Re-build after changing any tick.)")
            return
        self._downloads(res, built)

    # ── ① inputs ─────────────────────────────────────────────────────────────
    def _step_one_inputs(self):
        st.subheader("① Choose language & upload subtitle")
        c1, c2 = st.columns([2, 5])
        with c1:
            language = st.selectbox("Source language", list(LANGUAGES.keys()), key="srt_lang")
        with c2:
            srt_file = st.file_uploader("Native-script subtitle (.srt)", type=["srt"],
                                        key="srt_input")

        dict_bytes = self.dictionary_panel.render(language)
        st.caption("If the dictionary has the **native-script word** column, those words are "
                   "replaced with their PlanetRead English spelling *before* the AI call — and "
                   "locked, so no later correction can change them.")
        return language, srt_file, dict_bytes

    # ── ① romanize ───────────────────────────────────────────────────────────
    def _step_one_romanize(self, language, srt_file, dict_bytes, has_key):
        can_romanize = bool(srt_file) and has_key and anthropic_available()
        if not (srt_file and st.button("🌐 Romanize SRT", type="primary",
                                       use_container_width=True, key="run_romanize",
                                       disabled=not can_romanize)):
            return

        progress = st.progress(0.0, text="Contacting Anthropic…")
        status = st.empty()
        t_ui = time.perf_counter()

        def on_progress(done, total):
            frac = min(1.0, done / total) if total else 0.0
            progress.progress(frac, text=f"Romanizing lines… {done}/{total}")
            status.caption(f"⏱️ {time.perf_counter() - t_ui:.1f}s")

        try:
            src_text = SrtDocument.decode(srt_file.getvalue())

            # Guideline 8: danda -> period, verse numbers and stand-in colons
            # removed. Done here so the model never has to decide, and so the
            # rule holds even when no dictionary is configured.
            src_text, punct = PunctuationNormalizer().normalize_source(src_text)

            # Pre-pass: dictionary native column -> PlanetRead English, in place.
            protected, n_pre = set(), 0
            if dict_bytes:
                native_map = Dictionary.from_docx(dict_bytes, language).native_map
                if native_map:
                    src_text, protected, n_pre = PreSubstitutor(native_map).apply(src_text)

            romanized_text, stats = Romanizer(language).romanize(
                src_text.encode("utf-8"), progress_cb=on_progress)
            progress.progress(1.0, text="Romanization done!")
            UsageLog().record(language, srt_file.name, stats)

            # Tell the operator even if they switched windows — a run takes
            # minutes, so nobody sits and watches the progress bar.
            summary = f"{stats['lines']} lines romanized"
            if stats.get("refused"):
                summary += f" · {stats['refused']} need a manual fix"
            if stats.get("cached"):
                summary += " · loaded from cache"
            DesktopNotifier.queue(
                f"✅ {srt_file.name} is ready", summary)

            # A fresh romanization invalidates any earlier scan/build.
            self.result = {
                "base": srt_file.name.rsplit(".srt", 1)[0],
                "romanized_text": romanized_text,
                "stats": stats,
                "protected": protected,
                "n_pre": n_pre,
                "punct": punct,
                "dict_bytes_len": len(dict_bytes) if dict_bytes else 0,
            }
        except Exception as e:
            log.exception("SRT romanization failed")
            DesktopNotifier.queue(f"❌ {srt_file.name} failed",
                                  "Romanization did not finish — open the app for details.")
            st.session_state.pop(STATE_KEY, None)
            friendly = ApiErrorFormatter.friendly(e)
            if friendly:
                st.error(friendly)
            else:
                st.error(f"Something went wrong: {e}")
                st.exception(e)

    # ── romanized output ─────────────────────────────────────────────────────
    def _show_romanized(self, res):
        stats = res["stats"]
        msg = f"✅ Romanized {stats['lines']} line(s) across {stats['blocks']} block(s)."
        if res.get("n_pre"):
            msg += (f" 🔒 {res['n_pre']} native word occurrence(s) pre-replaced from the "
                    f"dictionary ({len(res.get('protected') or set())} unique words, protected).")
        if stats.get("missing"):
            msg += f" ⚠️ {stats['missing']} line(s) kept as-is (model didn't return them)."
        if stats.get("cached"):
            msg += " ♻️ Loaded from cache — no Anthropic call."
        st.success(msg)

        # A safety refusal leaves those lines in the ORIGINAL script. That must never
        # be a quiet footnote — the file looks finished but ships un-romanized text.
        if stats.get("refused"):
            nums = stats.get("refused_subtitles") or []
            shown = ", ".join(nums[:40]) + (" …" if len(nums) > 40 else "")
            st.error(
                f"🛑 **{stats['refused']} line(s) could not be romanized** and are still "
                "in the original script. Either the API declined them on safety "
                "grounds (common with plot dialogue about killings or conspiracies), "
                "or it handed them back unchanged. Everything else romanized "
                "normally." + chr(10) * 2 +
                f"**Fix these subtitle(s) by hand:** {shown}")

        self._guideline_report(res)

        st.download_button(
            f"⬇️ {res['base']}_romanized.srt",
            data=res["romanized_text"].encode("utf-8"),
            file_name=f"{res['base']}_romanized.srt", mime="application/x-subrip",
            use_container_width=True, key="dl_srt_romanized",
        )

    # ── guideline report ─────────────────────────────────────────────────────
    def _guideline_report(self, res):
        """What the deterministic guideline passes did, and what still needs a
        human. Kept visible rather than logged, because a silent quality report
        is one nobody reads."""
        punct = res.get("punct") or {}
        if sum(punct.values()):
            done = ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in punct.items() if v)
            st.caption(f"✍️ Punctuation normalised: {done}.")

        keep = lambda l: "-->" not in l and not l.strip().isdigit()
        body = chr(10).join(l for l in res["romanized_text"].split(chr(10)) if keep(l))

        issues = PunctuationNormalizer().check_output(body)
        # devanagari_left is already reported above, in detail, with subtitle numbers
        issues = [i for i in issues if i[0] != "devanagari_left"]
        for code, n, examples, note in issues:
            st.warning(f"⚠️ **{code.replace('_', ' ')}** on {n} line(s) — {note}."
                       + chr(10) * 2 + ("  " + chr(10)).join("`%s`" % e[:70] for e in examples))

        rows = ConsistencyChecker(res.get("replacements") or {}).summary(body)
        if rows:
            with st.expander(f"🔤 {len(rows)} word(s) spelled inconsistently "
                             "(guideline 2) — review before delivery"):
                st.caption("Each row is one word appearing in more than one spelling "
                           "in this file. Where the dictionary has an approved form it "
                           "is named; otherwise the most frequent spelling is proposed.")
                for r in rows:
                    st.markdown("- " + r)

    # ── ② corrections ────────────────────────────────────────────────────────
    def _step_two_corrections(self, res, dict_bytes):
        st.divider()
        st.subheader("② Apply the dictionary")

        if dict_bytes and st.button("🔍 Find corrections", type="primary",
                                    use_container_width=True, key="run_dict"):
            try:
                with st.spinner("Scanning for dictionary + engine corrections…"):
                    rom_docx = SrtDocument.to_docx_bytes(res["romanized_text"])
                    # We only need the candidate list + the exact dictionary here; the
                    # outputs are built later from the user's ticked selection.
                    # Pre-substituted (protected) words are skipped entirely.
                    corrector = DocumentCorrector(Dictionary.from_docx(dict_bytes),
                                                  enable_engine=self.enable_engine)
                    _doc, replacements, all_changes = corrector.run(
                        rom_docx, protected=res.get("protected") or frozenset())
                scan_id = st.session_state.get("_scan_seq", 0) + 1
                st.session_state["_scan_seq"] = scan_id
                res.update({
                    "replacements": replacements,
                    "all_changes": all_changes,
                    "n_pairs": len(replacements),
                    "scan_id": scan_id,
                    "scanned": True,
                })
                res.pop("built", None)   # a new scan invalidates previously built files
                self.result = res
            except Exception as e:
                log.exception("Dictionary scan failed")
                st.error(f"Something went wrong: {e}")
                st.exception(e)

        if not dict_bytes:
            st.info("👆 The dictionary couldn't be loaded — fix that in step ①, "
                    "then click **Find corrections**.")

    # ── review + build ───────────────────────────────────────────────────────
    def _review(self, res):
        st.divider()
        st.markdown("### 🔤 Review corrections")
        st.caption("Yellow dictionary fixes are always applied. Tick the engine "
                   "fixes/guesses you want — only ticked ones go into the files below.")
        return ReviewTable.render(res["all_changes"], res["n_pairs"], res["scan_id"])

    def _build(self, res, selected):
        st.markdown("<br>", unsafe_allow_html=True)
        if st.button("📦 Build files with the ticked corrections", type="primary",
                     use_container_width=True, key="build_outputs"):
            with st.spinner("Building files…"):
                res["built"] = OutputBuilder().build(
                    res["romanized_text"], res["replacements"], res["all_changes"],
                    selected, protected=res.get("protected") or frozenset(),
                )
            self.result = res

    # ── ③ downloads ──────────────────────────────────────────────────────────
    def _downloads(self, res, built):
        base = res["base"]
        d1, d2, d3 = st.columns(3)
        with d1:
            st.markdown("#### 🎞️ Final SRT")
            st.download_button(
                f"⬇️ {base}_romanized_fixed.srt", data=built["srt_final"],
                file_name=f"{base}_romanized_fixed.srt", mime="application/x-subrip",
                use_container_width=True, type="primary", key="dl_srt_final",
            )
            st.caption(f"Romanized + {built['n_fixes']} applied correction(s) "
                       f"({built['n_engine_applied']} ticked engine), "
                       f"{built['n_codes']} timecodes kept.")
        with d2:
            st.markdown("#### 📥 Review Word File")
            st.download_button(
                f"⬇️ {base}_review.docx", data=built["review_docx"],
                file_name=f"{base}_review.docx",
                mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                use_container_width=True, key="dl_srt_review",
            )
            st.caption("Shows only the applied corrections (yellow + the ticked green/cyan).")
        with d3:
            st.markdown("#### 🔁 Grow the Dictionary")
            st.download_button(
                f"⬇️ Ticked engine pairs ({built['n_new']})",
                data=built["engine_pairs"], file_name="engine_found_pairs.docx",
                mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                use_container_width=True, disabled=(built["n_new"] == 0), key="dl_srt_pairs",
            )
            st.caption("Only the engine pairs you ticked. Paste into the master dictionary.")
