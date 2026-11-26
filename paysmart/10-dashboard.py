"""Cashier / kitchen screen: a plain HTML page that refreshes itself every 3 seconds."""
import html
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

from .db import connect, list_orders

LABELS = {"pending": "في انتظار الدفع", "partial": "دفع جزئي", "paid": "مدفوع",
          "overpaid": "مدفوع (زيادة)", "review": "مراجعة يدوية"}


def render(conn):
    rows = []
    for o in list_orders(conn):
        rows.append(
            f"<tr class='{o['status']}'><td>{html.escape(o['order_id'])}</td>"
            f"<td>{html.escape(o['customer'] or '')}</td><td>{o['expected']:.2f}</td>"
            f"<td>{o['paid_total']:.2f}</td><td>{LABELS.get(o['status'], o['status'])}</td></tr>")
    return f"""<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="3"><title>PaySmart AI</title>
<style>body{{font-family:sans-serif;margin:24px}}table{{border-collapse:collapse;width:100%}}
td,th{{border:1px solid #ccc;padding:8px;text-align:center}}
.paid,.overpaid{{background:#e6f6e9}}.partial{{background:#fff4d6}}.review{{background:#fde4e4}}</style></head>
<body><h1>PaySmart AI: لوحة الكاشير</h1><table>
<tr><th>الطلب</th><th>العميل</th><th>المطلوب</th><th>المدفوع</th><th>الحالة</th></tr>
{''.join(rows)}</table></body></html>"""


def make_handler(conn):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            body = render(conn).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass
    return H


def main():
    conn = connect(os.environ.get("PAYSMART_DB", "paysmart.db"))
    HTTPServer(("127.0.0.1", 8080), make_handler(conn)).serve_forever()


if __name__ == "__main__":
    main()
