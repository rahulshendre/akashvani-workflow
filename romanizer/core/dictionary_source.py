"""Where a language's dictionary comes from, and how it is fetched.

The language experts maintain ONE dictionary doc PER LANGUAGE in Google Docs and
edit them frequently, so the app pulls the live copy for whichever language is
selected rather than asking for an upload. That also removes a correctness trap:
a committed or emailed copy silently drifts out of sync with the doc the experts
are actually editing.
"""
from __future__ import annotations

import logging
import os
import re
import time

from ..config import LANGUAGES

log = logging.getLogger("romanize.dictionary")


class DictionarySource:
    """Resolves and downloads the dictionary document for one language."""

    _GDOC_ID_RE = re.compile(r'/d/([A-Za-z0-9_-]{20,})')

    def __init__(self, secret_lookup=None):
        """`secret_lookup(name)` reads a Streamlit secret; injected so this module
        never imports streamlit and stays unit-testable."""
        self._secret = secret_lookup or (lambda name: None)

    @staticmethod
    def env_var_for(language: str) -> str:
        """The configuration key holding this language's doc URL, e.g.
        "Hindi" -> DICTIONARY_DOC_URL_HINDI."""
        return "DICTIONARY_DOC_URL_" + re.sub(r'[^A-Z0-9]', '_', language.upper())

    def url_for(self, language: str) -> str:
        """The dictionary doc for `language`, or "" if none is configured.

        Resolution order:
          1. DICTIONARY_DOC_URL_<LANGUAGE>  — env var, then Streamlit secret
          2. DICTIONARY_DOC_URL             — one doc for every language; a
             testing escape hatch, not for production

        There is no hard-coded fallback on purpose: a share link is a credential,
        so it must never live in the repository.
        """
        key = self.env_var_for(language)
        url = (os.getenv(key) or self._secret(key)
               or os.getenv("DICTIONARY_DOC_URL") or self._secret("DICTIONARY_DOC_URL"))
        return (url or "").strip()

    def configured_languages(self):
        """Which languages currently have a dictionary configured — used to show
        the operator what this deployment actually has, without printing URLs."""
        return [lang for lang in LANGUAGES if self.url_for(lang)]

    @classmethod
    def docx_export_url(cls, url: str) -> str:
        """Turn a Google Docs / Drive share link into a direct .docx download URL.
        A native Google Doc exports via /export?format=docx; a Drive-hosted file (an
        uploaded .docx) downloads via /uc. Any other URL is passed through unchanged,
        so a plain https://…/dictionary.docx link also works."""
        m = cls._GDOC_ID_RE.search(url)
        if not m:
            return url
        doc_id = m.group(1)
        if "docs.google.com/document" in url:
            return f"https://docs.google.com/document/d/{doc_id}/export?format=docx"
        return f"https://drive.google.com/uc?export=download&id={doc_id}"

    @classmethod
    def fetch(cls, url: str):
        """Download the dictionary .docx. Returns (bytes, fetched_at_clock_time).

        Caching is the caller's job (the UI wraps this in st.cache_data), so this
        stays a plain function that always really downloads.
        """
        import requests
        r = requests.get(cls.docx_export_url(url), timeout=60)

        # Google's status codes are specific and each means something different to
        # whoever has to fix it, so translate them instead of surfacing a bare
        # "401 Client Error" that reads like a bug in the app.
        if r.status_code in (401, 403):
            raise RuntimeError(
                "the document is not shared publicly (Google returned "
                f"{r.status_code}). The app has no Google login, so open the doc → "
                "**Share** → set **General access** to **Anyone with the link → "
                "Viewer**. Sharing it with individual people is not enough.")
        if r.status_code == 404:
            raise RuntimeError(
                "no document exists at that link (404). Check the URL set in "
                "this language's DICTIONARY_DOC_URL_* setting.")
        if r.status_code == 410:
            raise RuntimeError(
                "the document has been deleted or moved to the trash (410). "
                "Restore it, or point this language's DICTIONARY_DOC_URL_* "
                "setting at its replacement.")
        r.raise_for_status()
        data = r.content
        # A doc that isn't link-shared returns Google's HTML sign-in page with HTTP
        # 200, so verify the payload really is a .docx (zip magic) rather than
        # trusting the status code — otherwise the failure surfaces much later as a
        # confusing python-docx parse error.
        if not data.startswith(b"PK"):
            raise RuntimeError(
                "the link didn't return a .docx file. Make sure the Google Doc is "
                "shared as **Anyone with the link → Viewer**.")
        log.info("Fetched dictionary from %s (%d KB)", url, len(data) // 1024)
        return data, time.strftime("%H:%M:%S")
