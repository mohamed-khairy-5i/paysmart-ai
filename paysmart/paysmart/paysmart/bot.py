"""Telegram bot (long polling, standard library only).

Flow: customer opens t.me/<bot>?start=ORD_1001 -> sends a receipt photo ->
the photo goes to the extractor -> check_receipt decides -> bot replies.
"""
import json
import os
import urllib.request

from .db import connect
from .extractor import GeminiExtractor
from .verify import check_receipt


class Telegram:
    def __init__(self, token):
        self.base = f"https://api.telegram.org/bot{token}"
        self.file_base = f"https://api.telegram.org/file/bot{token}"

    def call(self, method, **params):
        req = urllib.request.Request(f"{self.base}/{method}", json.dumps(params).encode(),
                                     {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)["result"]

    def download(self, file_id):
        info = self.call("getFile", file_id=file_id)
        with urllib.request.urlopen(f"{self.file_base}/{info['file_path']}", timeout=30) as r:
            return r.read()


def handle_update(tg, conn, extractor, update, sessions):
    msg = update.get("message") or {}
    chat = msg.get("chat", {}).get("id")
    if not chat:
        return
    text = msg.get("text", "")
    if text.startswith("/start"):
        parts = text.split()
        if len(parts) == 2:
            sessions[chat] = parts[1]
            tg.call("sendMessage", chat_id=chat, text=f"أهلاً. طلبك {parts[1]}. ابعت صورة إيصال التحويل.")
        else:
            tg.call("sendMessage", chat_id=chat, text="افتح الرابط من المتجر عشان أعرف رقم طلبك.")
        return
    if msg.get("photo"):
        order_id = sessions.get(chat)
        if not order_id:
            tg.call("sendMessage", chat_id=chat, text="مش عارف رقم طلبك. افتح الرابط من المتجر الأول.")
            return
        image = tg.download(msg["photo"][-1]["file_id"])
        try:
            extracted = extractor.extract(image)
        except Exception:
            extracted = {}
        result = check_receipt(conn, order_id, extracted)
        tg.call("sendMessage", chat_id=chat, text=result.message)


def main():
    tg = Telegram(os.environ["TELEGRAM_BOT_TOKEN"])
    conn = connect(os.environ.get("PAYSMART_DB", "paysmart.db"))
    extractor = GeminiExtractor()
    sessions, offset = {}, 0
    while True:
        for u in tg.call("getUpdates", offset=offset, timeout=30):
            offset = u["update_id"] + 1
            handle_update(tg, conn, extractor, u, sessions)


if __name__ == "__main__":
    main()
