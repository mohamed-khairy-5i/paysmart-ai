/**
 * Telegram Bot Service with Comprehensive Edge-Case Handling
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { analyzeReceiptWithGemini, verifyReceiptRules } = require('./gemini');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CASHIER_CHAT_ID = process.env.CASHIER_CHAT_ID || '';
const STORE_NAME = process.env.STORE_NAME || 'متجرنا الذكي';

let isPolling = false;
let lastUpdateId = 0;

async function telegramRequest(method, payload = {}) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'DEMO_BOT_TOKEN') {
    console.log(`[Telegram Mock] Request ${method}:`, JSON.stringify(payload).slice(0, 150));
    return { ok: true, result: {} };
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!data.ok) {
      console.error(`[Telegram API Error] ${method}:`, data.description);
    }
    return data;
  } catch (error) {
    console.error(`[Telegram Network Error] ${method}:`, error.message);
    return { ok: false, error: error.message };
  }
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  return telegramRequest('sendMessage', payload);
}

async function downloadTelegramFile(fileId) {
  try {
    const fileRes = await telegramRequest('getFile', { file_id: fileId });
    if (!fileRes.ok || !fileRes.result.file_path) {
      throw new Error('Failed to resolve file path from Telegram');
    }
    const filePath = fileRes.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    
    const imageRes = await fetch(downloadUrl);
    const arrayBuffer = await imageRes.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error('[Telegram File Download Error]:', err.message);
    throw err;
  }
}

/**
 * Handle incoming user messages with 10 edge case branches
 */
async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text ? message.text.trim() : '';
  const username = message.from.username || message.from.first_name || 'عميلنا العزيز';

  console.log(`[Telegram Message] From ${username} (${chatId}): ${text || '[Media/Photo]'}`);

  // 1. Handle /start command with Deep-Linking Payload (?start=ORD_XXXXXX)
  if (text.startsWith('/start')) {
    const parts = text.split(' ');
    const orderPayload = parts[1] ? parts[1].trim() : null;

    if (orderPayload) {
      const order = db.getOrder(orderPayload);
      if (order) {
        db.updateOrder(order.id, {
          telegramChatId: String(chatId),
          telegramUsername: username,
          status: 'PENDING_PAYMENT'
        });

        const itemsList = order.items.map(item => `• <b>${item.name}</b> × ${item.quantity} = ${item.price * item.quantity} ج.م`).join('\n');

        const reply = `
مرحباً بك يا <b>${order.customerName}</b> في <b>${STORE_NAME}</b>! 🌟

لقد استلمنا طلبك رقم: <code>#${order.id}</code>
━━━━━━━━━━━━━━━━━━
📋 <b>تفاصيل الطلب:</b>
${itemsList}

💰 <b>الإجمالي المطلوب سداده:</b> <code>${order.totalAmount} ج.م</code>
📍 <b>عنوان التوصيل:</b> ${order.address || 'استلام من الفرع'}
━━━━━━━━━━━━━━━━━━
💳 <b>طرق الدفع المتاحة:</b>
1. <b>InstaPay:</b> <code>${process.env.INSTAPAY_ADDRESS || 'store@instapay'}</code>
2. <b>فودافون كاش:</b> <code>${process.env.VODAFONE_CASH_NUMBER || '01012345678'}</code>

📲 <b>الخطوة القادمة:</b>
بعد إتمام التحويل، يرجى <b>إرسال صورة إيصال التحويل (Screenshot)</b> هنا مباشرة داخل المحادثة ليقوم الذكاء الاصطناعي بمطابقتها واعتماد طلبك فوراً! ⚡
`;
        await sendMessage(chatId, reply);
        return;
      }
    }

    const genericMsg = `
أهلاً بك في <b>${STORE_NAME}</b>! 🛍️
لإتمام طلباتك ومتابعتها، يرجى تقديم طلبك من الموقع أولاً والضغط على زر تليجرام في صفحة إتمام الطلب ليتم ربط حسابك تلقائياً.
`;
    await sendMessage(chatId, genericMsg);
    return;
  }

  // 2. Handle Photo Upload (Payment Receipt)
  if (message.photo && message.photo.length > 0) {
    const activeOrder = db.getOrderByChatId(chatId);

    if (!activeOrder) {
      await sendMessage(chatId, '⚠️ لم نتمكن من العثور على طلب معلق مرتبط بحسابك. يرجى تقديم طلب جديد عبر الموقع أولاً أو الضغط على رابط الطلب.');
      return;
    }

    if (activeOrder.status === 'PAID_CONFIRMED' || activeOrder.status === 'PREPARING' || activeOrder.status === 'OVERPAID_CONFIRMED') {
      await sendMessage(chatId, `✅ طلبك رقم <code>#${activeOrder.id}</code> تم تأكيده وسداده بالفعل وهو الآن قيد التجهيز بالمطبخ!`);
      return;
    }

    // Acknowledge receipt upload
    await sendMessage(chatId, '⏳ <i>جاري فحص صورة الإيصال ومطابقة المبلغ والبيانات بالذكاء الاصطناعي... لحظات من فضلك</i>');

    try {
      const photoItem = message.photo[message.photo.length - 1];
      const imageBuffer = await downloadTelegramFile(photoItem.file_id);

      // Analyze with Gemini Multimodal AI
      const aiData = await analyzeReceiptWithGemini(imageBuffer, 'image/jpeg');

      // Check anti-replay
      const isDuplicate = db.isTransactionDuplicate(aiData.transaction_id);

      // Verify business rules
      const verification = verifyReceiptRules(aiData, activeOrder, isDuplicate);

      // ==========================================
      // Scenario Handlers (10 Edge Cases)
      // ==========================================

      // Scenario 1: Exact Happy Path (PAID_CONFIRMED)
      if (verification.code === 'PAID_CONFIRMED') {
        db.registerTransaction(aiData.transaction_id, activeOrder.id, {
          amount: aiData.amount_paid,
          method: aiData.payment_method,
          chatId: String(chatId)
        });

        db.updateOrder(activeOrder.id, {
          status: 'PAID_CONFIRMED',
          amountPaidSoFar: activeOrder.totalAmount,
          paymentDetails: aiData,
          paidAt: new Date().toISOString()
        });

        const successMsg = `
🎉 <b>تم تأكيد الدفع بنجاح!</b>

تم التحقق من إيصال التحويل عبر الذكاء الاصطناعي:
━━━━━━━━━━━━━━━━━━
🔹 <b>رقم الطلب:</b> <code>#${activeOrder.id}</code>
🔹 <b>طريقة الدفع:</b> ${aiData.payment_method}
🔹 <b>المبلغ المسدد:</b> ${aiData.amount_paid} ${aiData.currency || 'ج.م'}
🔹 <b>رقم العملية:</b> <code>${aiData.transaction_id || 'N/A'}</code>
━━━━━━━━━━━━━━━━━━
🚀 تم تحويل طلبك مباشرة إلى <b>قسم التجهيز والكاشير</b> وسنوافيك بتحديثات التوصيل فور خروجه!
شكراً لثقتك بنا ❤️
`;
        await sendMessage(chatId, successMsg);
        notifyCashier(activeOrder, aiData, 'PAID_CONFIRMED');
        return;
      }

      // Scenario 2: Underpayment (Partial Payment)
      if (verification.code === 'PARTIALLY_PAID') {
        db.addPartialPayment(activeOrder.id, verification.paidAmount, aiData);

        const partialMsg = `
⚠️ <b>تم استلام دفعة جزئية!</b>

• المبلغ المستلم في هذا الإيصال: <b>${verification.paidAmount} ج.م</b>
• إجمالي الفاتورة المطلوبة: <b>${activeOrder.totalAmount} ج.م</b>
• <b>المبلغ المتبقي لإتمام الطلب:</b> <code>${verification.remainingAmount} ج.م</code>
━━━━━━━━━━━━━━━━━━
يرجى تحويل المبلغ المتبقي (<b>${verification.remainingAmount} ج.م</b>) وإرسال إيصال التحويل الجديد هنا لاعتماد الطلب وبدء تحضيره فوراً.
`;
        await sendMessage(chatId, partialMsg);
        return;
      }

      // Scenario 3: Overpayment (Refund Due)
      if (verification.code === 'OVERPAID_CONFIRMED') {
        db.registerTransaction(aiData.transaction_id, activeOrder.id, {
          amount: aiData.amount_paid,
          method: aiData.payment_method,
          chatId: String(chatId)
        });

        db.updateOrder(activeOrder.id, {
          status: 'OVERPAID_CONFIRMED',
          amountPaidSoFar: aiData.amount_paid,
          refundDue: verification.refundAmount,
          paymentDetails: aiData,
          paidAt: new Date().toISOString()
        });

        const overpaidMsg = `
🎉 <b>تم تأكيد الدفع واعتماد طلبك بنجاح!</b>

💡 <b>تنبيه بخصوص المبلغ:</b>
لقد قمت بتحويل مبلغ <b>${aiData.amount_paid} ج.م</b> بزيادة قدرها <b>${verification.refundAmount} ج.م</b> عن قيمة الفاتورة (${activeOrder.totalAmount} ج.م).

💵 <b>لا تقلق!</b> تم تسجيل رد الفارق لك وسيتم تسليمه نقداً مع مندوب التوصيل مع طلبك 🛵.
`;
        await sendMessage(chatId, overpaidMsg);
        notifyCashier(activeOrder, aiData, 'OVERPAID_CONFIRMED', verification.refundAmount);
        return;
      }

      // Scenario 9: AI Downtime / Escalated to Human
      if (verification.code === 'ESCALATED_HUMAN') {
        db.updateOrder(activeOrder.id, {
          status: 'ESCALATED_HUMAN',
          paymentDetails: aiData
        });

        const humanMsg = `
⏳ <b>جاري مراجعة إيصالك يدوياً بواسطة أحد ممثلي الخدمة للتأكد.</b>
سنرسل لك إشعاراً فورياً هنا بمجرد اعتماد الطلب، لا داعي لإعادة إرسال الصورة!
`;
        await sendMessage(chatId, humanMsg);
        notifyCashier(activeOrder, aiData, 'ESCALATED_HUMAN');
        return;
      }

      // Other Failure Scenarios (Wrong Recipient, Expired, Tampered, Duplicate, Invalid)
      db.logFraudAttempt(activeOrder.id, verification.reason, aiData);

      const failMsg = `
⚠️ <b>تعذر اعتماد إيصال التحويل!</b>

<b>السبب:</b>
${verification.reason}

يرجى مراجعة بيانات التحويل وإعادة إرسال صورة واضحة للإيصال الصحيح، أو التواصل مع خدمة العملاء للمساعدة.
`;
      await sendMessage(chatId, failMsg);

    } catch (err) {
      console.error('[Receipt Processing Error]:', err.message);
      // Fallback to human review on unhandled error
      db.updateOrder(activeOrder.id, { status: 'ESCALATED_HUMAN' });
      await sendMessage(chatId, 'حدث خطأ مؤقت في المعالجة الآلية. تم إرسال إيصالك للكاشير للمراجعة اليدوية المباشرة 👨‍💼.');
    }
    return;
  }

  // 3. Fallback text
  const helpMsg = `
مرحباً بك! لإرسال إيصال الدفع، يرجى إرسال الصورة مباشرة هنا وسيقوم النظام بمطابقتها مع طلبك فوراً. 📸
`;
  await sendMessage(chatId, helpMsg);
}

function notifyCashier(order, aiData, status, extra = null) {
  if (!CASHIER_CHAT_ID) return;
  let text = '';
  if (status === 'PAID_CONFIRMED') {
    text = `🔔 <b>طلب جديد مؤكد وجاهز للتحضير!</b>\n• رقم الطلب: #${order.id}\n• العميل: ${order.customerName}\n• المبلغ: ${order.totalAmount} ج.م`;
  } else if (status === 'OVERPAID_CONFIRMED') {
    text = `⚠️ <b>طلب مؤكد مع رد فارق نقدي!</b>\n• رقم الطلب: #${order.id}\n• العميل: ${order.customerName}\n• <b>مبلغ الرد نقداً للعميل: ${extra} ج.م</b>`;
  } else if (status === 'ESCALATED_HUMAN') {
    text = `🚨 <b>طلب يتطلب مراجعة بشرية فورية!</b>\n• رقم الطلب: #${order.id}\n• العميل: ${order.customerName}\n• يرجى فحص الإيصال يدوياً على لوحة الكاشير.`;
  }
  sendMessage(CASHIER_CHAT_ID, text);
}

/**
 * Long-polling runner
 */
async function startPolling() {
  if (isPolling) return;
  isPolling = true;
  console.log('[Telegram Bot] Long-polling engine started...');

  while (isPolling) {
    try {
      if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'DEMO_BOT_TOKEN') {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const res = await telegramRequest('getUpdates', {
        offset: lastUpdateId + 1,
        timeout: 25
      });

      if (res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          lastUpdateId = update.update_id;
          await handleUpdate(update);
        }
      } else {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (error) {
      console.error('[Polling Loop Error]:', error.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

function stopPolling() {
  isPolling = false;
  console.log('[Telegram Bot] Long-polling stopped.');
}

module.exports = {
  sendMessage,
  handleUpdate,
  startPolling,
  stopPolling
};
