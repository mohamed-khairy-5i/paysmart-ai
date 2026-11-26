require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./services/db');
const { startPolling, handleUpdate, sendMessage } = require('./services/telegram');
const { analyzeReceiptWithGemini, verifyReceiptRules } = require('./services/gemini');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'SmartOrderBot';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// API Endpoints
// ==========================================

/**
 * 1. Customer creates an order
 */
app.post('/api/orders', (req, res) => {
  try {
    const { customerName, phone, address, items, totalAmount, notes } = req.body;

    if (!customerName || !phone || !items || !totalAmount) {
      return res.status(400).json({ error: 'يرجى استكمال جميع بيانات الطلب المطلوبة.' });
    }

    const order = db.createOrder({
      customerName,
      phone,
      address: address || '',
      items: Array.isArray(items) ? items : [],
      totalAmount: Number(totalAmount),
      notes: notes || ''
    });

    const telegramDeepLink = `https://t.me/${BOT_USERNAME}?start=${order.id}`;
    console.log(`[Order Created] #${order.id} for ${customerName} (${totalAmount} EGP)`);

    return res.status(201).json({
      success: true,
      order,
      telegramDeepLink
    });
  } catch (error) {
    console.error('Error creating order:', error);
    return res.status(500).json({ error: 'فشل في حفظ الطلب في النظام.' });
  }
});

/**
 * 2. Get Single Order Details
 */
app.get('/api/orders/:id', (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود.' });
  return res.json({ success: true, order });
});

/**
 * 3. Cashier Dashboard: Get all orders
 */
app.get('/api/cashier/orders', (req, res) => {
  const orders = db.getAllOrders();
  return res.json({ success: true, orders });
});

/**
 * 4. Cashier Status Transitions (Preparing, Delivering, Delivered)
 */
app.post('/api/cashier/update-status', async (req, res) => {
  try {
    const { orderId, status } = req.body;
    const order = db.getOrder(orderId);

    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }

    const updated = db.updateOrder(orderId, { status });

    if (order.telegramChatId) {
      let statusArabic = status;
      if (status === 'PREPARING') statusArabic = '👨‍🍳 طلبك الآن قيد التحضير في المطبخ!';
      if (status === 'DELIVERING') statusArabic = '🛵 طلبك الآن في الطريق مع مندوب التوصيل!';
      if (status === 'DELIVERED') statusArabic = '✅ تم توصيل طلبك بنجاح! نأمل أن ينال إعجابك ❤️';

      await sendMessage(order.telegramChatId, `
تحديث بخصوص طلبك رقم <code>#${order.id}</code>:
<b>${statusArabic}</b>
      `);
    }

    return res.json({ success: true, order: updated });
  } catch (error) {
    console.error('Error updating status:', error);
    return res.status(500).json({ error: 'فشل في تحديث حالة الطلب.' });
  }
});

/**
 * 5. Human-in-the-Loop Manual Review Decision (Cashier overrides or approves)
 */
app.post('/api/cashier/manual-decision', async (req, res) => {
  try {
    const { orderId, decision, notes } = req.body; // decision: 'APPROVE' | 'REJECT'
    const order = db.getOrder(orderId);

    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }

    const updated = db.manualDecision(orderId, decision, notes);

    if (order.telegramChatId) {
      if (decision === 'APPROVE') {
        await sendMessage(order.telegramChatId, `
🎉 <b>تم اعتماد طلبك رقم #${order.id} يدوياً بنجاح!</b>
طلبك الآن قيد التحضير في المطبخ وسنوافيك بالتفاصيل قريباً 👨‍🍳.
        `);
      } else {
        await sendMessage(order.telegramChatId, `
⚠️ <b>نأسف، تم رفض إيصال الطلب رقم #${order.id} بعد المراجعة.</b>
السبب: ${notes || 'بيانات التحويل غير مطابقة'}. يرجى التواصل مع الإدارة للمساعدة.
        `);
      }
    }

    return res.json({ success: true, order: updated });
  } catch (error) {
    console.error('Manual decision error:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 6. Simulation & Testing Sandbox Endpoint with Multi-Scenario Support
 */
app.post('/api/simulate-receipt', async (req, res) => {
  try {
    const { orderId, imageBase64, mockAmount, mockScenario } = req.body;
    const order = db.getOrder(orderId);

    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }

    let aiData;
    if (mockScenario) {
      // Allow forced simulation of edge cases for testing
      aiData = {
        is_valid_receipt: mockScenario !== 'INVALID_IMAGE',
        payment_method: 'InstaPay',
        transaction_id: mockScenario === 'DUPLICATE' ? 'TXN-DUP-001' : 'TXN-' + Math.floor(100000 + Math.random() * 900000),
        amount_paid: Number(mockAmount || order.totalAmount),
        currency: 'EGP',
        recipient_account: mockScenario === 'WRONG_RECIPIENT' ? 'wrong@instapay' : 'store@instapay',
        is_today_or_recent: mockScenario !== 'EXPIRED',
        tampering_signs: { detected: mockScenario === 'TAMPERED' },
        confidence_score: 0.98
      };
    } else {
      aiData = await analyzeReceiptWithGemini(imageBase64, 'image/jpeg');
    }

    const isDuplicate = db.isTransactionDuplicate(aiData.transaction_id);
    const verification = verifyReceiptRules(aiData, order, isDuplicate);

    if (verification.code === 'PAID_CONFIRMED' || verification.code === 'OVERPAID_CONFIRMED') {
      db.registerTransaction(aiData.transaction_id, order.id, {
        amount: aiData.amount_paid,
        method: aiData.payment_method
      });

      const updated = db.updateOrder(order.id, {
        status: verification.code,
        amountPaidSoFar: aiData.amount_paid,
        refundDue: verification.refundAmount || 0,
        paymentDetails: aiData,
        paidAt: new Date().toISOString()
      });

      return res.json({ success: true, verification, aiData, order: updated });
    } else if (verification.code === 'PARTIALLY_PAID') {
      const updated = db.addPartialPayment(order.id, verification.paidAmount, aiData);
      return res.json({ success: false, verification, aiData, order: updated });
    } else {
      db.logFraudAttempt(order.id, verification.reason, aiData);
      return res.json({ success: false, verification, aiData });
    }
  } catch (error) {
    console.error('Simulation error:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 7. Telegram Webhook Endpoint
 */
app.post('/webhook/telegram', async (req, res) => {
  try {
    await handleUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 [AI Order Automation Engine] Running on port ${PORT}`);
  console.log(`🌐 Store Checkout:     http://localhost:${PORT}`);
  console.log(`🧑‍🍳 Cashier Dashboard: http://localhost:${PORT}/cashier.html`);
  console.log(`======================================================\n`);

  startPolling();
});
