import unittest
from paysmart.db import connect, create_order, get_order
from paysmart.verify import check_receipt
from paysmart.extractor import FakeExtractor
from paysmart.dashboard import render


def fresh(expected=250):
    c = connect(":memory:")
    create_order(c, "ORD_1", expected)
    return c


class VerifyTests(unittest.TestCase):
    def test_exact_payment(self):
        c = fresh()
        r = check_receipt(c, "ORD_1", {"amount": 250, "transaction_id": "T1"})
        self.assertEqual(r.code, "accepted")
        self.assertEqual(get_order(c, "ORD_1")["status"], "paid")

    def test_duplicate_receipt_rejected_even_for_other_order(self):
        c = fresh()
        create_order(c, "ORD_2", 250)
        check_receipt(c, "ORD_1", {"amount": 250, "transaction_id": "T1"})
        r = check_receipt(c, "ORD_2", {"amount": 250, "transaction_id": "T1"})
        self.assertEqual(r.code, "duplicate")
        self.assertEqual(get_order(c, "ORD_2")["paid_total"], 0)

    def test_partial_then_rest(self):
        c = fresh(400)
        r = check_receipt(c, "ORD_1", {"amount": 300, "transaction_id": "T1"})
        self.assertEqual((r.code, r.remaining), ("partial", 100))
        r = check_receipt(c, "ORD_1", {"amount": 100, "transaction_id": "T2"})
        self.assertEqual(r.code, "accepted")

    def test_overpayment_flags_refund(self):
        c = fresh(120)
        r = check_receipt(c, "ORD_1", {"amount": 150, "transaction_id": "T1"})
        self.assertEqual((r.code, r.refund_due), ("overpaid", 30))

    def test_unreadable_goes_to_manual_review(self):
        c = fresh()
        r = check_receipt(c, "ORD_1", {"amount": None, "transaction_id": "T1"})
        self.assertEqual(r.code, "needs_review")
        self.assertEqual(get_order(c, "ORD_1")["status"], "review")

    def test_unknown_and_already_paid(self):
        c = fresh()
        self.assertEqual(check_receipt(c, "NOPE", {"amount": 1, "transaction_id": "X"}).code, "unknown_order")
        check_receipt(c, "ORD_1", {"amount": 250, "transaction_id": "T1"})
        self.assertEqual(check_receipt(c, "ORD_1", {"amount": 250, "transaction_id": "T9"}).code, "already_paid")

    def test_amount_with_comma_string(self):
        c = fresh(1250)
        r = check_receipt(c, "ORD_1", {"amount": "1,250.00", "transaction_id": "T1"})
        self.assertEqual(r.code, "accepted")

    def test_fake_extractor_and_dashboard(self):
        c = fresh()
        ex = FakeExtractor({"amount": 250, "transaction_id": "T1", "sender": "x"}).extract(b"")
        check_receipt(c, "ORD_1", ex)
        self.assertIn("مدفوع", render(c))


if __name__ == "__main__":
    unittest.main()
