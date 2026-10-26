"""Reading configuration from .env locally and Streamlit Secrets in the cloud."""
from __future__ import annotations

import os

import streamlit as st


class Secrets:
    """Config lookup that works both locally and on Streamlit Community Cloud."""

    @staticmethod
    def paths():
        """The secrets locations Streamlit ITSELF will read. Asking Streamlit rather
        than hardcoding matters on Streamlit Community Cloud, where the dashboard's
        secrets land in a path this module has no business guessing — a wrong guess
        would make a correctly-configured secret look missing."""
        try:
            from streamlit import config
            paths = config.get_option("secrets.files")
            if paths:
                return list(paths)
        except Exception:
            pass
        return [os.path.join(os.getcwd(), ".streamlit", "secrets.toml"),
                os.path.join(os.path.expanduser("~"), ".streamlit", "secrets.toml")]

    @classmethod
    def get(cls, name: str):
        """Value of a Streamlit secret, or None if unset / no secrets file exists.

        Touching `st.secrets` when no secrets.toml exists paints a red "No secrets
        found" box on the page — even inside a try/except — so check that a secrets
        file is actually present first. Locally there never is one; on Streamlit
        Cloud there always is.
        """
        if not any(os.path.exists(p) for p in cls.paths()):
            return None
        try:
            return st.secrets.get(name)
        except Exception:
            return None

    @classmethod
    def api_key(cls):
        """Find the Anthropic key from the environment (.env locally) or from
        Streamlit Secrets (the cloud path), and export it so the Anthropic client
        picks it up."""
        key = os.getenv("ANTHROPIC_API_KEY")
        if not key:
            key = cls.get("ANTHROPIC_API_KEY")
            if key:
                os.environ["ANTHROPIC_API_KEY"] = key
        return (key or "").strip() or None
