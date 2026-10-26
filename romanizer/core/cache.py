"""On-disk cache: the same file + language never costs a second API call."""
from __future__ import annotations

import hashlib
import json
import logging
import os

from ..config import CACHE_DIR, CACHE_VERSION

log = logging.getLogger("romanize.cache")


class RomanizationCache:
    """Stores a finished romanization keyed by the EXACT source bytes.

    Keying on bytes (not filename) means an edited subtitle is automatically a
    different key, so a stale result can never be served for changed input.
    """

    def __init__(self, directory: str = CACHE_DIR, version: str = CACHE_VERSION):
        self.directory = directory
        self.version = version

    def key(self, data: bytes, language: str) -> str:
        h = hashlib.sha256()
        h.update(self.version.encode("utf-8"))
        h.update(b"\x00")
        h.update(language.encode("utf-8"))
        h.update(b"\x00")
        h.update(data)        # exact file bytes — any edit is a different key
        return h.hexdigest()

    def load(self, key: str):
        try:
            with open(os.path.join(self.directory, key + ".json"), "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def store(self, key: str, romanized_text: str, stats: dict) -> None:
        try:
            os.makedirs(self.directory, exist_ok=True)
            path = os.path.join(self.directory, key + ".json")
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"romanized_text": romanized_text, "stats": stats},
                          f, ensure_ascii=False)
            os.replace(tmp, path)   # atomic — never leaves a half-written cache file
        except OSError as e:
            log.warning("Could not write romanization cache: %s", e)

    def clear(self) -> int:
        """Delete all cached romanizations. Returns how many were removed."""
        n = 0
        try:
            for name in os.listdir(self.directory):
                if name.endswith(".json"):
                    os.remove(os.path.join(self.directory, name))
                    n += 1
        except OSError:
            pass
        return n
