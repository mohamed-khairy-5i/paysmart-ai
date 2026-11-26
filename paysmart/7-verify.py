"""Core receipt logic. No network: takes the fields the vision model extracted."""
from dataclasses import dataclass
import sqlite3

TOLERANCE = 0.01  # EGP


@dataclass
class Result:
    code: str      # accepted | partial | overpaid | duplicate | unknown_order | already_paid | needs_review
    message: str
    remaining: float = 0.0
    refund_due: float = 0.0


def _clean_amount(v):
    try:
        a = float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return a if a > 0 else None


def check_receipt(conn, order_id, extracted):
    """extracted: dict with amount, transaction_id, sender (any may be missing)."""
    order = conn.execute("SELECT * FROM orders WHERE order_id=?", (order_id,)).fetchone()
    if order is None:
        return Result("unknown_order", "رقم الطلب غير موجود.")
    if order["status"] in ("paid", "overpaid"):
        return Result("already_paid", "الطلب ده مدفوع بالفعل.")

    amount = _clean_amount(extracted.get("amount"))
    tx = (str(extracted.get("transaction_id") or "")).strip()
    if amount is None or not tx:
        conn.execute("UPDATE orders SET status='review' WHERE order_id=?", (order_id,))
        conn.commit()
        return Result("needs_review", "مقدرتش أقرأ المبلغ أو رقم العملية بوضوح. الكاشير هيراجعها يدويًا.")

    try:
        conn.execute("INSERT INTO receipts(transaction_id, order_id, amount, sender) VALUES (?,?,?,?)",
                     (tx, order_id, amount, extracted.get("sender")))
    except sqlite3.IntegrityError:
        return Result("duplicate", "رقم العملية ده اتستخدم قبل كده. الإيصال مرفوض.")

    total = order["paid_total"] + amount
    expected = order["expected"]
    if abs(total - expected) <= TOLERANCE:
        status, res = "paid", Result("accepted", "تم تأكيد الدفع. الطلب راح للمطبخ.")
    elif total < expected:
        status = "partial"
        res = Result("partial", f"المبلغ أقل من المطلوب. المتبقي {expected - total:.2f} جنيه.",
                     remaining=expected - total)
    else:
        status = "overpaid"
        res = Result("overpaid", f"تم الدفع، وفي زيادة {total - expected:.2f} جنيه هتترجع للعميل.",
                     refund_due=total - expected)
    conn.execute("UPDATE orders SET paid_total=?, status=? WHERE order_id=?", (total, status, order_id))
    conn.commit()
    return res
