import sqlite3
from contextlib import closing

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    customer TEXT,
    expected REAL NOT NULL,
    paid_total REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | partial | paid | overpaid | review
    kitchen_stage TEXT NOT NULL DEFAULT 'waiting',  -- waiting | preparing | ready | delivered
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS receipts (
    transaction_id TEXT PRIMARY KEY,  -- UNIQUE: this is the anti-replay guard
    order_id TEXT NOT NULL,
    amount REAL NOT NULL,
    sender TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def connect(path=":memory:"):
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    with closing(conn.cursor()) as cur:
        cur.executescript(SCHEMA)
    conn.commit()
    return conn


def create_order(conn, order_id, expected, customer=""):
    conn.execute("INSERT INTO orders(order_id, customer, expected) VALUES (?,?,?)",
                 (order_id, customer, float(expected)))
    conn.commit()


def get_order(conn, order_id):
    return conn.execute("SELECT * FROM orders WHERE order_id=?", (order_id,)).fetchone()


def list_orders(conn):
    return conn.execute("SELECT * FROM orders ORDER BY created_at DESC, order_id").fetchall()
