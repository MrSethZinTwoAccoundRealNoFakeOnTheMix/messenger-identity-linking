require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const APP_SECRET = process.env.APP_SECRET;
const PAGE_TOKEN = process.env.APP_SESSION_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://test.trapiseth.site';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ────────────────────────────────────────────────────────────────

// Generate a signed URL with HMAC
function generateSignedWebviewUrl(baseUrl, psid) {
  const sig = crypto.createHmac('sha256', APP_SECRET).update(psid).digest('hex');
  return `${baseUrl}/webview?psid=${psid}&sig=${sig}`;
}

// Verify a signed PSID token
function verifySignedToken(psid, sig) {
  if (!psid || !sig) return { ok: false, reason: 'missing params' };

  // Dev mode mock bypass
  if (process.env.NODE_ENV !== 'production' && sig === 'demo-bypass') {
    return { ok: true };
  }

  const expected = crypto.createHmac('sha256', APP_SECRET).update(psid).digest('hex');
  if (sig.length !== expected.length) return { ok: false, reason: 'invalid' };
  const isValid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  return isValid ? { ok: true } : { ok: false, reason: 'tampered' };
}

// Send receipt message to customer via Messenger
async function sendMessengerReceipt(psid, order, items) {
  if (!PAGE_TOKEN) return;

  const itemElements = items.map(item => ({
    title: item.name,
    subtitle: `Qty: ${item.quantity} × $${item.unit_price.toFixed(2)}`,
    image_url: item.photo_url || 'https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=500&q=80',
    buttons: [{
      type: 'web_url',
      url: `${BASE_URL}/webview?psid=${psid}&sig=${crypto.createHmac('sha256', APP_SECRET).update(psid).digest('hex')}`,
      title: 'View Store'
    }]
  }));

  try {
    // 1. Send items carousel
    await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'generic',
              elements: itemElements.slice(0, 10)
            }
          }
        }
      })
    });

    // 2. Send text summary
    const summaryText = `🛍️ Order Confirmed (Pending Payment)!\n\nOrder ID: ${order.id}\nTotal: $${order.total_amount.toFixed(2)}\nCustomer: ${order.customer_name}\nPhone: ${order.phone}\nAddress: ${order.address}\n\nOur shop owner will review your order shortly!`;
    await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: { text: summaryText }
      })
    });
  } catch (err) {
    console.error('Failed to send Messenger receipt:', err);
  }
}

// ─── Customer Routes ────────────────────────────────────────────────────────

// Public storefront or Messenger webview entry
app.get(['/', '/webview'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Identity verification API
app.get('/api/identity', (req, res) => {
  const { psid, sig } = req.query;
  if (!psid || !sig) return res.json({ verified: false, reason: 'missing params' });
  const check = verifySignedToken(psid, sig);
  res.json({ verified: check.ok, psid: check.ok ? psid : null, reason: check.reason || null });
});

// Products listing API
app.get('/api/products', (req, res) => {
  const products = db.prepare('SELECT id, name, category, sell_price, stock, photo_url FROM products ORDER BY id ASC').all();
  res.json(products);
});

// Create Order API (Requires verified PSID)
app.post('/api/orders', async (req, res) => {
  const { psid, sig, items, customer_name, phone, address, note } = req.body;

  // 1. Mandatory Identity Check
  const check = verifySignedToken(psid, sig);
  if (!check.ok) {
    return res.status(403).json({ error: 'Checkout requires a verified Messenger identity link.' });
  }

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Cart cannot be empty.' });
  }

  // Consolidate duplicates by productId (e.g. 3 separate entries -> 1 entry with quantity 3)
  const consolidatedMap = new Map();
  for (const it of items) {
    const prev = consolidatedMap.get(it.productId) || 0;
    consolidatedMap.set(it.productId, prev + (Number(it.quantity) || 1));
  }

  // 2. Calculate total and verify items in DB
  let totalAmount = 0;
  const orderItemsData = [];

  for (const [productId, quantity] of consolidatedMap.entries()) {
    const product = db.prepare('SELECT id, name, sell_price, stock, photo_url FROM products WHERE id = ?').get(productId);
    if (!product) {
      return res.status(400).json({ error: `Product ${productId} not found.` });
    }
    if (product.stock < quantity) {
      return res.status(400).json({
        error: `Insufficient stock for "${product.name}". Only ${product.stock} available.`
      });
    }
    const itemTotal = product.sell_price * quantity;
    totalAmount += itemTotal;
    orderItemsData.push({
      productId: product.id,
      name: product.name,
      photo_url: product.photo_url,
      quantity,
      unit_price: product.sell_price
    });
  }

  const orderId = 'ORD-' + Date.now().toString().slice(-6);

  // 3. Save order in PENDING status (does NOT decrement stock yet)
  const insertOrder = db.prepare(`
    INSERT INTO orders (id, psid, status, total_amount, customer_name, phone, address, note)
    VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?)
  `);

  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, quantity, unit_price)
    VALUES (?, ?, ?, ?)
  `);

  const createTransaction = db.transaction(() => {
    insertOrder.run(orderId, psid, totalAmount, customer_name || '', phone || '', address || '', note || '');
    for (const item of orderItemsData) {
      insertItem.run(orderId, item.productId, item.quantity, item.unit_price);
    }
  });

  try {
    createTransaction();

    const orderRecord = {
      id: orderId,
      psid,
      total_amount: totalAmount,
      customer_name: customer_name || 'Customer',
      phone: phone || '',
      address: address || ''
    };

    // 4. Send confirmation carousel asynchronously to Messenger
    sendMessengerReceipt(psid, orderRecord, orderItemsData);

    res.json({
      success: true,
      orderId,
      total: totalAmount,
      status: 'PENDING'
    });
  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({ error: 'Failed to create order.' });
  }
});

// ─── Admin Routes ───────────────────────────────────────────────────────────

// Generate admin auth token using HMAC of ADMIN_PASSWORD
function getExpectedAdminToken() {
  return crypto.createHmac('sha256', APP_SECRET || 'luxe_secret').update(`admin:${ADMIN_PASSWORD}`).digest('hex');
}

// Admin auth middleware
function requireAdminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token && token === getExpectedAdminToken()) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please login with admin password.' });
}

// Admin: Login endpoint
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  res.json({ success: true, token: getExpectedAdminToken() });
});

// Admin Dashboard UI
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Admin: Get all products (with import price and margins)
app.get('/api/admin/products', requireAdminAuth, (req, res) => {
  const products = db.prepare(`
    SELECT id, name, category, import_price, sell_price, stock, photo_url,
           ROUND(((sell_price - import_price) / sell_price) * 100, 1) as margin_percent
    FROM products
    ORDER BY id ASC
  `).all();
  res.json(products);
});

// Admin: Add or update product
app.post('/api/admin/products', requireAdminAuth, (req, res) => {
  const { id, name, category, import_price, sell_price, stock, photo_url } = req.body;
  if (!name || !category || import_price == null || sell_price == null) {
    return res.status(400).json({ error: 'Missing required product fields.' });
  }

  // Generate category-prefixed SKU if new
  let sku = id;
  if (!sku) {
    const prefixMap = { Ring: 'RG', Necklace: 'NK', Bracelet: 'BR', Earring: 'ER' };
    const prefix = prefixMap[category] || 'JW';
    const last = db.prepare('SELECT id FROM products WHERE id LIKE ? ORDER BY id DESC LIMIT 1').get(`${prefix}-%`);
    let nextNum = 1;
    if (last) {
      const match = last.id.match(/\d+$/);
      if (match) nextNum = parseInt(match[0], 10) + 1;
    }
    sku = `${prefix}-${String(nextNum).padStart(4, '0')}`;
  }

  const upsert = db.prepare(`
    INSERT INTO products (id, name, category, import_price, sell_price, stock, photo_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      category=excluded.category,
      import_price=excluded.import_price,
      sell_price=excluded.sell_price,
      stock=excluded.stock,
      photo_url=excluded.photo_url
  `);

  upsert.run(sku, name, category, Number(import_price), Number(sell_price), Number(stock || 0), photo_url || '');
  res.json({ success: true, id: sku });
});

// Admin: Get Orders list
app.get('/api/admin/orders', requireAdminAuth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  for (const o of orders) {
    o.items = db.prepare(`
      SELECT oi.*, p.name, p.photo_url
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `).all(o.id);
  }
  res.json(orders);
});

// Admin: Confirm Order with ATOMIC stock decrement concurrency guard
app.post('/api/admin/orders/:id/confirm', requireAdminAuth, (req, res) => {
  const orderId = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'PENDING') {
    return res.status(400).json({ error: `Cannot confirm order with status ${order.status}.` });
  }

  const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId);

  // Concurrency Guard: Atomic check & decrement
  const decrementStock = db.prepare(`
    UPDATE products
    SET stock = stock - ?
    WHERE id = ? AND stock >= ?
  `);

  const updateOrderStatus = db.prepare(`
    UPDATE orders SET status = 'CONFIRMED' WHERE id = ?
  `);

  const confirmTransaction = db.transaction(() => {
    for (const item of items) {
      const result = decrementStock.run(item.quantity, item.product_id, item.quantity);
      if (result.changes === 0) {
        throw new Error(`Insufficient stock for product ${item.product_id}.`);
      }
    }
    updateOrderStatus.run(orderId);
  });

  try {
    confirmTransaction();
    res.json({ success: true, message: `Order ${orderId} confirmed and stock decremented.` });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Admin: Cancel Order (e.g. out of stock or payment not received)
app.post('/api/admin/orders/:id/cancel', requireAdminAuth, (req, res) => {
  const orderId = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'PENDING') {
    return res.status(400).json({ error: `Cannot cancel order with status ${order.status}.` });
  }

  db.prepare("UPDATE orders SET status = 'CANCELLED' WHERE id = ?").run(orderId);
  res.json({ success: true, message: `Order ${orderId} has been marked as CANCELLED.` });
});


// Helper API: trigger shop link to user (from spike)
app.post('/api/send-shop-link', async (req, res) => {
  const { psid, baseUrl } = req.body;
  const shopUrl = generateSignedWebviewUrl(baseUrl || BASE_URL, psid);

  try {
    const response = await fetch(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: psid },
          messaging_type: 'RESPONSE',
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'button',
                text: 'Welcome! Tap below to open the store:',
                buttons: [{
                  type: 'web_url',
                  url: shopUrl,
                  title: 'Open Shop',
                  webview_height_ratio: 'tall',
                  messenger_extensions: true,
                }],
              },
            },
          },
        }),
      }
    );
    const data = await response.json();
    res.json({ status: 'sent', shopUrl, fbResponse: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Meta Messenger Webhook ──────────────────────────────────────────────────

// 1. Webhook Verification (Meta challenge)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'jewelry_secret_webhook_token_2026';

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Meta Webhook verified successfully!');
      return res.status(200).send(challenge);
    } else {
      console.warn('❌ Meta Webhook verification token mismatch.');
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// Cache of last time a shop link was auto-sent to a PSID (in-memory cooldown)
const lastShopLinkSentAt = new Map();
// const SHOP_LINK_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const SHOP_LINK_COOLDOWN_MS = 1000 * 60; // 1min for testing

// Quick reply pill prompts floating above the composer bar (Khmer + English)
const QUICK_REPLIES = [
  {
    content_type: 'text',
    title: '✨ ចូលហាង / Open Shop',
    payload: 'OPEN_SHOP',
    image_url: 'https://img.icons8.com/color/48/diamond--v1.png'
  }
];

// 2. Webhook Event Handler (Auto-reply with shop link when user messages page)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      const webhookEvent = entry.messaging ? entry.messaging[0] : null;
      if (!webhookEvent) continue;

      const senderPsid = webhookEvent.sender.id;

      // Ignore messages sent by the page itself
      if (webhookEvent.message && webhookEvent.message.is_echo) {
        continue;
      }

      // Check text, postback, or quick reply action
      const userText = (webhookEvent.message && webhookEvent.message.text ? webhookEvent.message.text.toLowerCase().trim() : '');
      const quickReplyPayload = (webhookEvent.message && webhookEvent.message.quick_reply ? webhookEvent.message.quick_reply.payload : '');
      const isPostback = !!webhookEvent.postback;
      const postbackPayload = isPostback ? webhookEvent.postback.payload : '';
      const actionPayload = quickReplyPayload || postbackPayload;

      const isExplicitShopRequest = isPostback || !!quickReplyPayload || userText === 'shop' || userText.includes('ចូលហាង') || userText.includes('open shop');

      // Check cooldown (in-memory)
      const lastSent = lastShopLinkSentAt.get(senderPsid) || 0;
      const isCoolDownOver = (Date.now() - lastSent) > SHOP_LINK_COOLDOWN_MS;

      // 1. Explicit Shop Request: User tapped quick reply, postback, or typed 'shop'/'ចូលហាង'
      if (isExplicitShopRequest) {
        console.log(`🛍️ Explicit shop request from PSID: ${senderPsid} (Trigger: "${actionPayload || userText}")`);
        lastShopLinkSentAt.set(senderPsid, Date.now());

        const shopUrl = generateSignedWebviewUrl(BASE_URL, senderPsid);

        try {
          // 1. Send Bilingual Guide: Khmer first, English bottom
          const guideMessage = 
`👋 សួស្តី! សូមស្វាគមន៍មកកាន់ Luxe Jewelry ✨

🛍️ របៀបបញ្ជាទិញ & ប្រើប្រាស់ហាង៖
១. ចុចប៊ូតុង "✨ ចូលមើលហាង" ខាងក្រោម ដើម្បីបើកទំព័រទំនិញ
២. ជ្រើសរើសគ្រឿងអលង្ការដែលពេញចិត្ត រួចចុច "Add to Cart"
៣. បំពេញព័ត៌មានដឹកជញ្ជូន និងស្កេនទូទាត់តាម KHQR ពេលទូទាត់ប្រាក់

💡 មិនបាច់បង្កើតគណនី (No Login)៖ បង្កាន់ដៃបញ្ជាទិញនឹងត្រូវផ្ញើចូលក្នុង Messenger នេះដោយស្វ័យប្រវត្តិ!

──────────────────
🛍️ How to Order:
1. Tap "Open Shop" below to browse our collection.
2. Select your favorite jewelry and tap "Add to Cart".
3. Enter your delivery info and pay via KHQR at checkout.

💡 No account/login needed! Your order receipt will be sent directly to this chat.`;

          await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipient: { id: senderPsid },
              messaging_type: 'RESPONSE',
              message: { text: guideMessage }
            })
          });

          // 2. Send Shop Button Template with signed link & floating Quick Reply pill
          await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipient: { id: senderPsid },
              messaging_type: 'RESPONSE',
              message: {
                attachment: {
                  type: 'template',
                  payload: {
                    template_type: 'button',
                    text: '👇 ចុចទីនេះដើម្បីចូលមើលហាង / Tap to open store:',
                    buttons: [{
                      type: 'web_url',
                      url: shopUrl,
                      title: '✨ ចូលមើលហាង (Open Shop)',
                      webview_height_ratio: 'tall',
                      messenger_extensions: true
                    }]
                  }
                },
                quick_replies: QUICK_REPLIES
              }
            })
          });

          console.log(`✅ Sent full order guide and webview card to ${senderPsid}`);
        } catch (err) {
          console.error('Error sending explicit shop response:', err);
        }
      } 
      // 2. General First Message / Interaction (Lightweight greeting with Quick Reply pill)
      else if (isCoolDownOver) {
        console.log(`👋 First interaction from PSID: ${senderPsid} (Trigger: "${userText || 'interaction'}")`);
        lastShopLinkSentAt.set(senderPsid, Date.now());

        const welcomeGreeting = 
`👋 សួស្តី! សូមស្វាគមន៍មកកាន់ Luxe Jewelry ✨
តើពួកយើងអាចជួយអ្វីបានដែរ? បើលោកអ្នកចង់មើលទំនិញ ឬបញ្ជាទិញ សូមចុចប៊ូតុងខាងក្រោមនេះ👇

👋 Hello! Welcome to Luxe Jewelry ✨
How can we help you today? To browse our collection or order, tap the button below👇`;

        try {
          await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipient: { id: senderPsid },
              messaging_type: 'RESPONSE',
              message: {
                text: welcomeGreeting,
                quick_replies: QUICK_REPLIES
              }
            })
          });
          console.log(`✅ Sent lightweight greeting with quick reply pill to ${senderPsid}`);
        } catch (err) {
          console.error('Error sending lightweight greeting:', err);
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});


const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));