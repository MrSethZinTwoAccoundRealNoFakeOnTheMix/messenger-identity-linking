require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const APP_SECRET = process.env.APP_SECRET;
const PAGE_TOKEN = process.env.APP_SESSION_TOKEN; // page access token from .env

app.use(express.json());

// ─── Helpers ────────────────────────────────────────────────────────────────

// Generate a permanent signed URL — no expiry, PSID is signed with HMAC
function generateSignedWebviewUrl(baseUrl, psid) {
  const sig = crypto.createHmac('sha256', APP_SECRET).update(psid).digest('hex');
  return `${baseUrl}/webview?psid=${psid}&sig=${sig}`;
}

// Verify a signed PSID token (permanent — no expiry check)
function verifySignedToken(psid, sig) {
  if (!psid || !sig) return { ok: false, reason: 'missing params' };
  const expected = crypto.createHmac('sha256', APP_SECRET).update(psid).digest('hex');
  if (sig.length !== expected.length) return { ok: false, reason: 'invalid' };
  const isValid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  return isValid ? { ok: true } : { ok: false, reason: 'tampered' };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Webview entry point — verify signed PSID, then serve the page
app.get('/webview', (req, res) => {
  const { psid, sig } = req.query;

  // No token — show generic landing
  if (!psid || !sig) {
    return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px">
      <h2>Store</h2><p>Please open this page from Messenger.</p>
    </body></html>`);
  }

  const check = verifySignedToken(psid, sig);
  if (!check.ok) {
    return res.status(403).send(`Link ${check.reason}. Please tap the button in Messenger again.`);
  }

  // Serve the verified webview — PSID is already in the URL for the frontend to read
  res.sendFile(path.join(__dirname, 'index.html'));
});

// API: verify a signed PSID (called by the frontend JS)
app.get('/api/identity', (req, res) => {
  const { psid, sig } = req.query;
  if (!psid || !sig) return res.json({ verified: false, reason: 'missing params' });
  const check = verifySignedToken(psid, sig);
  res.json({ verified: check.ok, psid: check.ok ? psid : null, reason: check.reason || null });
});

// API: send a signed shop button to a PSID via Messenger
app.post('/api/send-shop-link', async (req, res) => {
  const { psid, baseUrl, pageAccessToken } = req.body;
  const token = pageAccessToken || PAGE_TOKEN;
  const shopUrl = generateSignedWebviewUrl(baseUrl, psid);

  try {
    const response = await fetch(
      `https://graph.facebook.com/v20.0/me/messages?access_token=${token}`,
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
// Add this route before app.listen(...)
app.get('/', (req, res) => {
  res.send('Hello from trapiseth.site via Cloudflare Tunnel! broski');
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));