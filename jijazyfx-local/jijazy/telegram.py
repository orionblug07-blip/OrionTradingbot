"""
Send-only Telegram messages (same bot token and chat id as before).
No webhook or server is needed just to send messages.
"""
import json
import os
import urllib.request

LIMIT = 4000


def configured():
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID"))


def send(text, log=print):
    """Send plain text to the admin chat. Never raises: a failed alert must not
    stop the trading run."""
    if not configured() or not text:
        return False
    token, chat = os.environ["TELEGRAM_BOT_TOKEN"], os.environ["TELEGRAM_CHAT_ID"]
    ok = True
    for i in range(0, len(text), LIMIT):
        body = json.dumps({"chat_id": chat, "text": text[i:i + LIMIT], "disable_web_page_preview": True}).encode()
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=body,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                ok = ok and json.load(r).get("ok", False)
        except Exception as err:  # noqa: BLE001
            log(f"[telegram] couldn't send: {err}")
            ok = False
    return ok
