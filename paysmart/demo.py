"""Offline demo: runs the real checking logic with fake extractor output and prints the dashboard data."""
from .db import connect, create_order, list_orders
from .verify import check_receipt

conn = connect(":memory:")
create_order(conn, "ORD_1001", 250, "عميل 1")
create_order(conn, "ORD_1002", 400, "عميل 2")
create_order(conn, "ORD_1003", 120, "عميل 3")
steps = [
    ("ORD_1001", {"amount": 250, "transaction_id": "TX-A1", "sender": "Ahmed"}),
    ("ORD_1003", {"amount": 250, "transaction_id": "TX-A1", "sender": "Ahmed"}),  # same receipt reused
    ("ORD_1002", {"amount": 300, "transaction_id": "TX-B1", "sender": "Sara"}),
    ("ORD_1002", {"amount": 100, "transaction_id": "TX-B2", "sender": "Sara"}),
    ("ORD_1003", {"amount": 150, "transaction_id": "TX-C1", "sender": "Omar"}),
]
for oid, ex in steps:
    r = check_receipt(conn, oid, ex)
    print(f"{oid:9} {ex['transaction_id']:6} -> {r.code:12} {r.message}")
print()
for o in list_orders(conn):
    print(f"{o['order_id']}  expected={o['expected']:.2f}  paid={o['paid_total']:.2f}  status={o['status']}")
