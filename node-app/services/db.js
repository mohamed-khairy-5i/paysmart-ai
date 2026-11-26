const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'orders.json');
const FRAUD_LOG_FILE = path.join(__dirname, '..', 'data', 'fraud_log.json');

// Ensure data directory exists
const dataDir = path.dirname(DB_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { orders: {}, transactions: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading DB file, returning empty store:', err.message);
    return { orders: {}, transactions: {} };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving DB file:', err.message);
  }
}

// Order Management
function createOrder({ customerName, phone, address, items, totalAmount, notes }) {
  const db = readDB();
  const orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
  
  const newOrder = {
    id: orderId,
    customerName,
    phone,
    address,
    items, // array of { name, quantity, price }
    totalAmount: Number(totalAmount),
    amountPaidSoFar: 0,
    refundDue: 0,
    notes: notes || '',
    status: 'PENDING_TELEGRAM', // PENDING_TELEGRAM | PENDING_PAYMENT | PARTIALLY_PAID | ESCALATED_HUMAN | PAID_CONFIRMED | OVERPAID_CONFIRMED | PREPARING | DELIVERED | REJECTED
    telegramChatId: null,
    telegramUsername: null,
    paymentDetails: null, // Last AI extracted data
    receipts: [], // Array of all uploaded receipts for audit trail
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.orders[orderId] = newOrder;
  writeDB(db);
  return newOrder;
}

function getOrder(orderId) {
  const db = readDB();
  return db.orders[orderId] || null;
}

function getOrderByChatId(chatId) {
  const db = readDB();
  const userOrders = Object.values(db.orders).filter(o => o.telegramChatId === String(chatId));
  if (userOrders.length === 0) return null;
  // Return latest non-delivered order
  return userOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function updateOrder(orderId, updates) {
  const db = readDB();
  if (!db.orders[orderId]) return null;
  
  db.orders[orderId] = {
    ...db.orders[orderId],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  writeDB(db);
  return db.orders[orderId];
}

// Record partial payment
function addPartialPayment(orderId, amountPaid, receiptData) {
  const db = readDB();
  const order = db.orders[orderId];
  if (!order) return null;

  order.amountPaidSoFar = (order.amountPaidSoFar || 0) + Number(amountPaid);
  order.status = 'PARTIALLY_PAID';
  order.receipts = order.receipts || [];
  order.receipts.push({
    amount: amountPaid,
    receiptData,
    timestamp: new Date().toISOString()
  });
  order.updatedAt = new Date().toISOString();

  writeDB(db);
  return order;
}

// Cashier Manual Decision (Human-in-the-loop)
function manualDecision(orderId, decision, notes = '') {
  const db = readDB();
  const order = db.orders[orderId];
  if (!order) return null;

  if (decision === 'APPROVE') {
    order.status = 'PAID_CONFIRMED';
  } else if (decision === 'REJECT') {
    order.status = 'REJECTED';
  }
  order.manualReview = {
    decidedBy: 'Cashier',
    decision,
    notes,
    timestamp: new Date().toISOString()
  };
  order.updatedAt = new Date().toISOString();

  writeDB(db);
  return order;
}

function getAllOrders() {
  const db = readDB();
  return Object.values(db.orders).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Anti-Replay: Check if transaction ID was previously used
function isTransactionDuplicate(transactionId) {
  if (!transactionId || transactionId.trim() === '') return false;
  const db = readDB();
  const cleanId = String(transactionId).trim().toUpperCase();
  return Boolean(db.transactions[cleanId]);
}

function registerTransaction(transactionId, orderId, metadata = {}) {
  if (!transactionId || transactionId.trim() === '') return;
  const db = readDB();
  const cleanId = String(transactionId).trim().toUpperCase();
  db.transactions[cleanId] = {
    orderId,
    timestamp: new Date().toISOString(),
    ...metadata
  };
  writeDB(db);
}

// Log suspicious fraud attempts
function logFraudAttempt(orderId, reason, payload) {
  let logs = [];
  if (fs.existsSync(FRAUD_LOG_FILE)) {
    try {
      logs = JSON.parse(fs.readFileSync(FRAUD_LOG_FILE, 'utf-8'));
    } catch (e) {
      logs = [];
    }
  }
  logs.push({
    timestamp: new Date().toISOString(),
    orderId,
    reason,
    payload
  });
  fs.writeFileSync(FRAUD_LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
}

module.exports = {
  createOrder,
  getOrder,
  getOrderByChatId,
  updateOrder,
  addPartialPayment,
  manualDecision,
  getAllOrders,
  isTransactionDuplicate,
  registerTransaction,
  logFraudAttempt
};
