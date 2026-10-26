"""Desktop notifications when a long romanization finishes.

Delivered through the BROWSER, not the Python process. That is deliberate: a
Python-side toast (plyer, win10toast) fires on whatever machine runs the server,
which is the operator's desktop only when they run locally — on Streamlit Cloud
it would pop up in a datacenter and nobody would ever see it. A browser
notification always reaches whoever is actually watching the app.

This works because Streamlit renders embedded HTML in an iframe whose sandbox
includes `allow-same-origin`, so the script shares the page's origin and may use
the Notification API. The page also has to be a secure context, which both
https (Streamlit Cloud) and http://localhost (local runs) satisfy.
"""
from __future__ import annotations

import json
import logging
import uuid

import streamlit as st
import streamlit.components.v1 as components

log = logging.getLogger("romanize.notify")

PENDING_KEY = "_pending_notification"


class DesktopNotifier:
    """Queues a notification on one run and fires it exactly once."""

    @staticmethod
    def queue(title: str, body: str) -> None:
        """Ask for a notification to be shown on this rerun.

        Queued rather than fired directly because Streamlit re-executes the whole
        script on every interaction; emitting the script inline would re-fire the
        notification on every later rerun. `render()` consumes the queue, so each
        completion notifies once.
        """
        st.session_state[PENDING_KEY] = {
            "title": title,
            "body": body,
            "id": uuid.uuid4().hex,     # forces a fresh iframe each time
        }

    @staticmethod
    def render() -> None:
        """Emit the notification queued by `queue()`, if any, and clear it."""
        payload = st.session_state.pop(PENDING_KEY, None)
        if not payload:
            return
        components.html(DesktopNotifier._script(
            payload["title"], payload["body"], payload["id"]), height=46)

    @staticmethod
    def permission_control() -> None:
        """Render the enable-notifications control inside the component iframe.

        This must be a real HTML button, NOT a Streamlit button. Chrome only
        honours Notification.requestPermission() while a user gesture is still
        active, and a Streamlit button spends that activation on the round trip:
        click -> websocket -> Python rerun -> new iframe -> requestPermission().
        By then the activation is gone and Chrome ignores the call silently, so
        the prompt never appears and every notification quietly becomes a beep.
        Handling the click inside the iframe keeps the gesture intact.
        """
        with st.sidebar:
            components.html(DesktopNotifier._permission_widget(), height=108)

    # ── the scripts ──────────────────────────────────────────────────────────
    @staticmethod
    def _permission_widget() -> str:
        """Button + live permission state, all inside the iframe.

        Showing the state matters: "blocked" and "not asked yet" both produce a
        beep instead of a notification, and only one of them can be fixed by
        clicking the button — the other needs Chrome's site settings.
        """
        return """
<div style="font-family:'Source Sans Pro',system-ui,sans-serif;font-size:14px">
  <button id="prBtn" style="width:100%;padding:0.5rem 0.75rem;border-radius:0.5rem;
      border:1px solid rgba(49,51,63,0.2);background:#fff;cursor:pointer;
      font-size:14px;font-family:inherit">🔔 Enable desktop notifications</button>
  <div id="prMsg" style="margin-top:0.4rem;color:rgba(49,51,63,0.6);font-size:12.5px;
      line-height:1.35"></div>
</div>
<script>
(function () {
  var btn = document.getElementById("prBtn");
  var msg = document.getElementById("prMsg");

  function paint() {
    if (!("Notification" in window)) {
      btn.style.display = "none";
      msg.textContent = "This browser cannot show desktop notifications.";
      return;
    }
    var p = Notification.permission;
    if (p === "granted") {
      btn.style.display = "none";
      msg.textContent = "🔔 Notifications are on. You'll be alerted when a run finishes.";
    } else if (p === "denied") {
      btn.style.display = "none";
      msg.innerHTML = "🚫 Notifications are blocked for this site. Click the icon " +
        "left of the address bar \\u2192 Notifications \\u2192 Allow, then reload.";
    } else {
      btn.style.display = "";
      msg.textContent = "Runs take a few minutes — turn this on to be told when one ends.";
    }
  }

  btn.addEventListener("click", function () {
    // Called straight from the click handler so the user gesture is still live.
    try {
      var r = Notification.requestPermission();
      if (r && typeof r.then === "function") {
        r.then(function (res) {
          paint();
          if (res === "granted") {
            new Notification("🔔 Notifications enabled", {
              body: "You'll get an alert here when a romanization finishes.",
              tag: "planetread-romanizer"
            });
          }
        });
      } else {
        setTimeout(paint, 300);   // very old callback-style API
      }
    } catch (e) {
      msg.textContent = "Could not request permission: " + e;
    }
  });

  paint();
})();
</script>"""

    @staticmethod
    def _script(title: str, body: str, nonce: str) -> str:
        """Show a notification, falling back to a sound when it can't.

        Three ways this can fail and what happens for each:
          - permission not granted  -> beep instead (cannot prompt without a click)
          - API missing / insecure  -> beep instead
          - audio blocked too       -> silent; the on-page result is still there
        None of them raise, because a missing notification must never take the
        app down with it.
        """
        t, b = json.dumps(title), json.dumps(body)
        return f"""
<div id="nMsg" style="font-family:'Source Sans Pro',system-ui,sans-serif;
     font-size:12.5px;color:rgba(49,51,63,0.6);line-height:1.35"></div>
<script>
(function () {{
  var TITLE = {t}, BODY = {b};

  function beep() {{
    try {{
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; osc.type = "sine";
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
      osc.start(); osc.stop(ctx.currentTime + 0.5);
    }} catch (e) {{}}
  }}

  // Mark the TAB too. An OS toast is easy to miss when the operator is simply
  // in another Chrome tab on the same screen, and it disappears after a few
  // seconds; a changed tab title waits there until they come back. Works even
  // when notification permission was never granted.
  function badgeTab() {{
    try {{
      var doc = window.parent.document;
      if (!doc.hidden) return;              // they're already looking at it
      var original = doc.title;
      doc.title = "✅ Done — " + original;
      var restore = function () {{
        if (doc.hidden) return;
        doc.title = original;
        doc.removeEventListener("visibilitychange", restore);
      }};
      doc.addEventListener("visibilitychange", restore);
    }} catch (e) {{}}
  }}

  // One line saying what actually happened. Without it the only feedback is a
  // beep, and the beep is identical whether the notification displayed, was
  // blocked by permission, or was swallowed by the OS — so there is no way to
  // tell a working setup from a broken one.
  function say(text) {{
    try {{ document.getElementById("nMsg").textContent = text; }} catch (e) {{}}
  }}

  badgeTab();

  try {{
    if (!("Notification" in window)) {{
      say("This browser cannot show desktop notifications — played a sound instead.");
      beep();
      return;
    }}
    if (Notification.permission !== "granted") {{
      say("Notification permission is \\"" + Notification.permission +
          "\\" — played a sound instead. Enable notifications in the sidebar.");
      beep();
      return;
    }}

    var n = new Notification(TITLE, {{
      body: BODY,
      // same tag => a second finish replaces the first rather than stacking
      tag: "planetread-romanizer",
      requireInteraction: true    // stay on screen until dismissed; the operator
                                  // is away from the machine, which is the point
    }});

    // onshow proves the OS actually displayed it. Permission can be "granted"
    // while Windows Focus Assist / Do not disturb silently swallows it, and that
    // looks exactly like a code bug from the outside.
    var shown = false;
    n.onshow = function () {{ shown = true; say("🔔 Desktop notification sent."); }};
    n.onerror = function () {{ say("The browser rejected the notification — played a sound instead."); beep(); }};
    n.onclick = function () {{ try {{ window.parent.focus(); n.close(); }} catch (e) {{}} }};

    setTimeout(function () {{
      if (!shown) {{
        say("Permission is granted but Windows did not display the notification. " +
            "Check Focus assist / Do not disturb, and Settings \\u2192 System \\u2192 " +
            "Notifications \\u2192 Google Chrome.");
        beep();
      }}
    }}, 1200);
  }} catch (e) {{
    say("Notification failed (" + e + ") — played a sound instead.");
    beep();
  }}
}})();
</script>"""
