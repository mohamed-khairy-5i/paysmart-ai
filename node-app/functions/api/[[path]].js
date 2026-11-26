// Cloudflare Pages Function: DEMO-ONLY mock of the Express API (node-app/server.js).
// No real Gemini or Telegram calls. State lives in memory and resets often.
const seed = [
  { id: 'ORD-282466', customerName: 'Demo customer', totalAmount: 170, status: 'PENDING_TELEGRAM', items: [{ name: 'Coffee', quantity: 2, price: 85 }] },
  { id: 'ORD-478529', customerName: 'Demo review', totalAmount: 265, status: 'ESCALATED_HUMAN', amountPaidSoFar: 115, items: [{ name: 'Cheesecake', quantity: 1, price: 95 }] },
];
const orders = new Map(seed.map((o) => [o.id, o]));
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

export async function onRequest({ request, params }) {
  const path = (Array.isArray(params.path) ? params.path : [params.path]).join('/');
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  if (path === 'orders') {
    const id = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
    const order = { id, ...body, status: 'PENDING_TELEGRAM' };
    orders.set(id, order);
    return json({ success: true, order, telegramDeepLink: 'https://t.me/YourStoreBot?start=' + id }, 201);
  }
  if (path === 'cashier/orders') return json({ success: true, orders: [...orders.values()] });
  if (path === 'cashier/update-status' || path === 'cashier/manual-decision') {
    const o = orders.get(body.orderId);
    if (o) o.status = body.status || (body.decision === 'APPROVE' ? 'PAID_CONFIRMED' : 'REJECTED');
    return json({ success: true, order: o || null });
  }
  if (path === 'simulate-receipt') {
    const aiData = { is_valid_receipt: true, payment_method: 'InstaPay', transaction_id: 'TXN-DEMO-' + Math.floor(100000 + Math.random() * 900000), amount_paid: (orders.get(body.orderId) || {}).totalAmount || 170, currency: 'EGP', confidence_score: 0.98, demo: true };
    return json({ success: true, verification: { code: 'PAID_CONFIRMED', reason: 'DEMO: receipt image was not analysed' }, aiData });
  }
  return json({ error: 'not found' }, 404);
}
