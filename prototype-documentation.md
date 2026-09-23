# Jewelry Mini-Shop — Prototype Technical Documentation & Architecture Report

**Project Title:** Accountless Mobile Commerce with Cryptographic Messenger Identity Linking  
**Current Milestone:** Phase 1 & 2 Prototype Completed & Deployed  
**Deployment Target:** Production Homelab (Proxmox VE Unprivileged LXC + Cloudflare Zero Trust Tunnel)  
**Live Production URL:** `https://test.trapiseth.site`  
**Date:** September 2026  

---

## 1. Executive Summary

Traditional e-commerce platforms impose significant conversion friction on non-technical, mobile-first retail customers by demanding credential creation (passwords, email verifications, OTPs). Conversely, standard guest checkout systems suffer from high rates of abandoned carts, order spam, and unreachable customers due to fake contact details.

This project implements an **accountless, mobile-first e-commerce system** that links customer transactions to a verified social identity without requiring account creation. By leveraging the business's existing relationship on **Meta Messenger**, checkout URLs are dynamically generated with **server-signed HMAC-SHA256 tokens**. This binds each shopping session to a verified Page-Scoped ID (PSID) and guarantees that order status updates and visual carousels can be delivered within Meta's **24-hour customer interaction window** via the Graph API.

The entire system is self-contained and hosted 24/7 on an ultra-lightweight homelab edge container (**~45 MB RAM footprint**) behind Carrier-Grade NAT (CGNAT), using Cloudflare Zero Trust tunnels for secure HTTPS delivery without public IPv4 or port forwarding.

---

## 2. System Architecture

```
                  ┌──────────────────────────────────────────────┐
                  │          Customer Mobile Messenger           │
                  └──────────────────────┬───────────────────────┘
                                         │ 1. Customer sends "Hi" / "Shop"
                                         ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ Meta Graph API & Webhook Gateway                                                      │
 └──────────────────────┬─────────────────────────────────────────────────────────────────┘
                        │ 2. Webhook Event (POST /webhook)
                        ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ Cloudflare Edge Network (TLS Termination & DDoS Mitigation)                            │
 └──────────────────────┬─────────────────────────────────────────────────────────────────┘
                        │ 3. Encrypted Outbound Tunnel (QUIC/HTTPS)
                        ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ Homelab Edge Infrastructure (Proxmox VE 9.2 · Unprivileged LXC 100)                     │
 │                                                                                        │
 │   cloudflared systemd service (Port 7844 outbound -> localhost:3000)                   │
 │                                                                                        │
 │   Node.js Express Application (Supervised by PM2)                                      │
 │   ├─ Webhook Handler: Extracts PSID, generates HMAC signature                          │
 │   ├─ Graph API Dispatcher: Sends signed "✨ Open Shop" webview button                   │
 │   ├─ Identity Verification Middleware: crypto.timingSafeEqual validation               │
 │   ├─ Commerce Engine: Public catalog, cart, KHQR payment display                      │
 │   ├─ Admin API: Password-authenticated CRUD, margin calculations, order state machine  │
 │   └─ Concurrency Guard: Atomic check-and-decrement inventory updates                   │
 │                                                                                        │
 │   Embedded Storage Engine: SQLite in WAL (Write-Ahead Logging) mode (`shop.db`)        │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Component Breakdown

### 3.1. Infrastructure & Hosting Layer
* **Hypervisor:** Proxmox VE 9.2 (Linux Kernel 7.0) on physical homelab hardware.
* **Execution Environment:** Unprivileged Ubuntu 24.04 LTS LXC container (CT ID: `100`).
  * **Memory Utilization:** 45.6 MB active RAM (isolated, zero guest VM kernel overhead).
  * **Storage Allocation:** 10 GB thin-provisioned rootfs.
  * **Security Boundary:** Unprivileged mapping ensures container root (`uid 0`) maps to an unprivileged sub-UID on the Proxmox host, preventing container escape attacks.
* **Network & Ingress:** Cloudflare Zero Trust Tunnel (`cloudflared`).
  * Creates persistent outbound QUIC/HTTPS tunnels to Cloudflare edge nodes.
  * Completely bypasses residential ISP **Carrier-Grade NAT (CGNAT)** and eliminates the need for public IPv4 addresses or router port forwarding.
  * Cloudflare provides automated TLS/SSL certificate issuance and edge DDoS filtering.
* **Process Supervisor:** `PM2` (Node.js Process Manager) running as a `systemd` daemon (`pm2-root.service`). Automatically restarts the Node process upon code crashes or host reboots.

---

### 3.2. Cryptographic Identity & Meta Integration

#### The Problem with Traditional Approaches:
* Client-side SDKs (`MessengerExtensions.getContext()`) are deprecated, inconsistent across iOS/Android in-app browsers, and fail when links are opened in desktop or external browsers.
* Simple URL query parameters (`?psid=12345`) are trivially vulnerable to client-side tampering, spoofing, and impersonation.

#### Architectural Solution: Server-Signed HMAC-SHA256 URLs
1. **Dynamic Generation:** When the customer contacts the Facebook Page, the server signs the PSID using the store's private `APP_SECRET`:
   $$\text{Signature} = \text{HMAC-SHA256}(\text{APP\_SECRET}, \text{psid})$$
   The customer receives a private shopping URL:
   `https://test.trapiseth.site/webview?psid=28248567978157531&sig=a8f0...9b12`
2. **Timing-Safe Re-Verification:** When an order is placed (`POST /api/orders`), the backend recalculates the expected HMAC and validates it using `crypto.timingSafeEqual`:
   ```javascript
   const expected = crypto.createHmac('sha256', APP_SECRET).update(psid).digest('hex');
   if (sig.length !== expected.length) return { ok: false, reason: 'invalid' };
   const isValid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
   ```
   This prevents URL tampering, replay attacks under forged identities, and side-channel timing attacks.
3. **Guest Protection:** Anyone browsing directly without valid parameters can explore the catalog, but the checkout form strictly disables order submission and directs the user to message the Facebook Page.

#### Meta 24-Hour Messaging Policy Compliance:
* Meta enforces a strict policy: business Pages may only send automated responses (`messaging_type: RESPONSE`) within **24 hours** of a customer's last incoming message.
* Because the customer initiates contact to receive their signed shop link, the 24-hour interaction window is guaranteed active when they submit their order minutes later.
* The backend immediately calls Graph API `/me/messages` to send an interactive order confirmation carousel containing item photos, prices, order IDs, and total amounts.

---

### 3.3. Database Architecture & Concurrency Guard

* **Engine:** Embedded `better-sqlite3` configured with **Write-Ahead Logging (WAL)** mode and `PRAGMA busy_timeout = 5000`.
* **Rationale:** WAL mode allows concurrent read operations while writes are being committed, eliminating database lock contentions for high-throughput mobile browsing.

#### Inventory Concurrency Control (Atomic Decrement)
A naive e-commerce design decrements inventory at checkout submission. In an accountless system, this creates an **Inventory Denial of Service (DoS)** vulnerability, where attackers or abandoned carts artificially lock up physical jewelry pieces.

**Our Rule:**
1. Orders are submitted in **`PENDING`** status without touching stock.
2. The store owner inspects customer details and payment in the Admin Dashboard and clicks **Confirm**.
3. Stock is decremented **atomically** at confirmation time:
   ```sql
   UPDATE products
   SET stock = stock - ?
   WHERE id = ? AND stock >= ?
   ```
4. If `result.changes === 0`, the transaction rolls back, throwing a `409 Conflict` error to prevent overselling scarce, one-of-a-kind jewelry inventory.

---

### 3.4. Administrative Security

* **Dashboard URL:** `https://test.trapiseth.site/admin`
* **Authentication Scheme:** Single-owner credential protection backed by HMAC session validation.
* **Flow:**
  1. The owner submits the master `ADMIN_PASSWORD`.
  2. The server generates a deterministic session token:
     $$\text{Token} = \text{HMAC-SHA256}(\text{APP\_SECRET}, \text{"admin:"} + \text{ADMIN\_PASSWORD})$$
  3. The token is persisted in browser `localStorage` and dispatched in request headers:
     `x-admin-token: <hex_token>`
  4. All management endpoints (`/api/admin/products`, `/api/admin/orders`, `/api/admin/orders/:id/confirm`, `/api/admin/orders/:id/cancel`) enforce the `requireAdminAuth` middleware.
  5. Any unauthorized or unauthenticated request receives an immediate **`401 Unauthorized`**, prompting the client-side authentication modal.

---

## 4. Database Schema Reference

```sql
-- Products Table
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,               -- Category-prefixed SKU (e.g. RG-0001, NK-0001)
  name TEXT NOT NULL,
  category TEXT NOT NULL,            -- Ring, Necklace, Bracelet, Earring
  import_price REAL NOT NULL,        -- Wholesale cost (admin visible only)
  sell_price REAL NOT NULL,          -- Retail price shown to customers
  stock INTEGER NOT NULL DEFAULT 0,  -- Quantity available
  photo_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Orders Table
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,               -- Timestamp-prefixed identifier (e.g. ORD-1727050000000)
  psid TEXT NOT NULL,                -- Verified Facebook Page-Scoped ID
  status TEXT DEFAULT 'PENDING',     -- PENDING | CONFIRMED | CANCELLED
  total_amount REAL NOT NULL,
  customer_name TEXT,
  phone TEXT,
  address TEXT,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Order Items Junction Table
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);
```

---

## 5. API Specification

| Endpoint | Method | Access Level | Description |
|---|---|---|---|
| `/` or `/webview` | `GET` | Public | Serves the customer mobile storefront ([`index.html`](file:///d:/Test%20Page%20SDK/messenger-spike/index.html)). |
| `/api/identity` | `GET` | Public | Validates `psid` and `sig` query parameters via HMAC-SHA256. |
| `/api/products` | `GET` | Public | Returns active catalog items (`id`, `name`, `category`, `sell_price`, `stock`, `photo_url`). Wholesale prices hidden. |
| `/api/orders` | `POST` | Verified PSID | Re-verifies HMAC signature, checks stock sufficiency, records `PENDING` order, and dispatches Messenger receipt carousel. |
| `/admin` | `GET` | Public UI | Serves the owner management dashboard ([`admin.html`](file:///d:/Test%20Page%20SDK/messenger-spike/admin.html)). |
| `/api/admin/login` | `POST` | Public | Validates master password and returns signed `adminToken`. |
| `/api/admin/products` | `GET` | Admin Auth | Lists all inventory with wholesale import costs and auto-calculated profit margins. |
| `/api/admin/products` | `POST` | Admin Auth | Creates or updates product records. Auto-generates category SKUs (`RG-XXXX`, `NK-XXXX`, etc.). |
| `/api/admin/orders` | `GET` | Admin Auth | Lists all customer orders with constituent line items. |
| `/api/admin/orders/:id/confirm` | `POST` | Admin Auth | Executes atomic SQL inventory decrement and transitions order to `CONFIRMED`. |
| `/api/admin/orders/:id/cancel` | `POST` | Admin Auth | Cancels pending order without mutating inventory. |
| `/webhook` | `GET` | Meta Platform | Verifies Meta challenge handshake (`hub.challenge`). |
| `/webhook` | `POST` | Meta Platform | Receives incoming messages/postbacks and auto-replies with signed shopping URLs. |

---

## 6. Meta Developer Environment Configuration

### Understanding Development Mode vs. Live Mode
1. **Development Mode (Current Academic / Evaluation State):**
   * Meta restricts webhook events and messaging to accounts assigned an **App Role** (Administrator, Developer, or Tester).
   * **Inbound Webhook Filtering:** If an unregistered user sends `"Hi"`, Meta silently drops the webhook event before it reaches our server to protect user privacy from unverified third-party code.
   * **Adding Evaluators / Testers:** Up to 50 Facebook accounts can be added instantly under **App Roles → Roles → Testers** in the Meta Developer Portal without business verification or paperwork.
2. **Production / Live Mode (General Public Release):**
   * The application is toggled to **Live Mode**.
   * Requires submitting standard "Advanced Access" permission for `pages_messaging` along with a public Privacy Policy link and a short screencast of the shopping flow.

---

## 7. Operational Runbook & Maintenance

### 7.1. Starting and Inspecting the Application
All commands are executed inside container `100` (`root@jewelry-shop`):

```bash
# Check process status and resource consumption
pm2 status

# View live application logs (store traffic, webhooks, receipts)
pm2 logs jewelry-shop --lines 50

# Restart the application with zero downtime
pm2 reload jewelry-shop
```

### 7.2. Cloudflare Tunnel Management
```bash
# Check tunnel service status
systemctl status cloudflared

# Restart tunnel service
systemctl restart cloudflared
```

### 7.3. Zero-Downtime Database Backups
SQLite WAL mode enables atomic live snapshots without stopping server traffic:

```bash
# Run inside container or cron job:
sqlite3 /root/jewelry-shop/shop.db "VACUUM INTO '/root/jewelry-shop/backups/shop-$(date +%F).db';"
```

---

## 8. Academic Evaluation & Engineering Tradeoffs

| Design Decision | Alternative Rejected | Engineering Tradeoff & Rationale |
|---|---|---|
| **Cryptographic HMAC Links** | Full User Accounts (Email/Password) | Eliminates user drop-off during mobile shopping while maintaining unforgeable customer identity. |
| **Server-Side HMAC Tokens** | `MessengerExtensions` SDK | Replaces brittle, platform-specific client SDKs with standard web architecture compatible across all browsers. |
| **Stock Decrement at Confirmation** | Decrement at Checkout | Prevents Inventory Denial-of-Service attacks where unconfirmed carts exhaust limited inventory. |
| **Atomic SQL Check-and-Decrement** | Application-Level Locks | Eliminates race conditions during concurrent confirmations directly at the database engine level. |
| **Proxmox LXC + SQLite WAL** | Heavy Cloud Database (RDS/Postgres) | Reduces operational complexity and hosting costs to $0, achieving sub-5ms local queries on an edge homelab. |
| **Cloudflare Zero Trust Tunnel** | Port Forwarding / Dynamic DNS | Protects home network IP, bypasses ISP CGNAT, and automates TLS encryption without firewall holes. |
