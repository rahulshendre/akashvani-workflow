"""Turning raw API exceptions into something a subtitle editor can act on."""
from __future__ import annotations


class ApiErrorFormatter:
    """Classifies Anthropic errors into short, actionable messages."""

    @staticmethod
    def friendly(exc):
        """Return a short, actionable message — or None if we can't classify it
        (the caller falls back to showing the raw error). The biggest one to catch
        is an out-of-credits key, which the API reports as a 400 with a
        'credit balance is too low' message rather than a billing-specific code."""
        status = getattr(exc, "status_code", None)
        body = getattr(exc, "body", None)
        text = str(exc).lower()
        if isinstance(body, dict):
            err = body.get("error")
            text += " " + str((err or {}).get("message", "")
                              if isinstance(err, dict) else err).lower()

        if "credit balance" in text or "billing" in text or "purchase credits" in text:
            return ("💳 Your Anthropic API key has run out of credits. Add credits at "
                    "console.anthropic.com → **Plan & Billing**, then try again. "
                    "(Nothing was charged and no file was changed.)")
        if status == 401 or "authentication" in text or "invalid x-api-key" in text:
            return ("🔑 The Anthropic API key is invalid or expired. Check the "
                    "`ANTHROPIC_API_KEY` in your `.env` / Streamlit Secrets.")
        if status == 403 or "permission" in text:
            return ("🚫 This API key isn't allowed to use this model. Check your "
                    "Anthropic workspace's model access.")
        if status == 429 or "rate limit" in text:
            return ("⏳ Hit Anthropic's rate limit. Wait a minute and try again, or "
                    "lower the request volume.")
        if status == 529 or "overloaded" in text:
            return ("🌐 Anthropic is overloaded right now (we already retried several "
                    "times). Please wait a bit and run it again.")
        return None
