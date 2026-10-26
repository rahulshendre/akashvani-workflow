"""The usage and cost report: tokens and dollars per language, per week."""
from __future__ import annotations

import streamlit as st

from ..config import (PRICE_INPUT_PER_MTOK, PRICE_OUTPUT_PER_MTOK,
                      USAGE_LOG_PATH)
from ..core.usage import UsageLog


class UsageView:
    """Renders the weekly per-language spend table."""

    @staticmethod
    def render() -> None:
        usage_log = UsageLog()
        rows = usage_log.weekly_by_language()
        totals = usage_log.totals()

        label = "📊 Usage & cost"
        if totals["runs"]:
            label += f" — ${totals['cost_usd']:,.2f} across {totals['runs']} run(s)"

        with st.expander(label):
            if not rows:
                st.caption(
                    "No usage recorded yet. Each romanization appends one row "
                    "with the tokens the API actually reported — cache hits are "
                    "skipped, since they cost nothing and would drag the "
                    "per-episode average down."
                )
                return

            c1, c2, c3, c4 = st.columns(4)
            c1.metric("Total cost", f"${totals['cost_usd']:,.2f}")
            c2.metric("Runs", f"{totals['runs']:,}")
            c3.metric("Input tokens", f"{totals['input_tokens']:,}")
            c4.metric("Output tokens", f"{totals['output_tokens']:,}")

            st.dataframe(rows, use_container_width=True, hide_index=True)

            st.caption(
                f"Priced at ${PRICE_INPUT_PER_MTOK:.2f}/M input and "
                f"${PRICE_OUTPUT_PER_MTOK:.2f}/M output, with cached tokens at "
                "their reduced rates. Output usually dominates the bill, because "
                "transliteration returns about as much text as it receives and "
                "output costs five times more per token."
            )

            st.download_button(
                "⬇️ Download the full log (CSV)",
                data=usage_log.as_csv(),
                file_name="romanizer_usage.csv",
                mime="text/csv",
                use_container_width=True,
                key="dl_usage_csv",
                help="One row per run — re-group it however you like in a spreadsheet",
            )
            st.caption(
                f"Stored at `{USAGE_LOG_PATH}`. On Streamlit Community Cloud this "
                "path is wiped on every restart, so set `ROMANIZE_USAGE_LOG` to "
                "persistent storage, or download the CSV regularly, if the history "
                "needs to survive."
            )
