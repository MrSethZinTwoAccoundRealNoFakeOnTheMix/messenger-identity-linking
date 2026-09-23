# Jewelry Mini-Shop — Homelab Deployment & CI/CD Guide

This guide covers the complete deployment architecture, initial server provisioning, continuous integration/continuous deployment (CI/CD) workflow, and operational runbook for running the Jewelry Mini-Shop 24/7 in an isolated homelab environment.

---

## 1. System Topology Overview

```
 [ Developer PC (Windows) ]
            │
            │ 1. git push origin <branch>
            ▼
    [ GitHub Repository ]
            │
            │ 2. git pull & pm2 reload
            ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │ Homelab Physical Host (Proxmox VE 9.2 · 192.168.100.x)                 │
 │                                                                        │
 │  ┌──────────────────────────────────────────────────────────────────┐  │
 │  │ Proxmox Unprivileged LXC Container (CT 100: Ubuntu 24.04 LTS)   │  │
 │  │                                                                  │  │
 │  │   cloudflared Service ──(Outbound QUIC Tunnel)──► Cloudflare Edge │  │
 │  │            │                                            ▲        │  │
 │  │            ▼ (Proxy to localhost:3000)                  │        │  │
 │  │   Node.js Server (PM2 Supervised · Port 3000)           │        │  │
 │  │            │                                            │        │  │
 │  │            ▼                                            │        │  │
 │  │   SQLite Embedded DB (WAL Mode · shop.db)               │        │  │
 │  └─────────────────────────────────────────────────────────┼────────┘  │
 └────────────────────────────────────────────────────────────┼───────────┘
                                                              │
                                      3. Public Ingress via HTTPS
                                      https://test.trapiseth.site
                                                              │
                                            ┌─────────────────┴─────────┐
                                            │ Customers & Meta Webhook  │
                                            └───────────────────────────┘
```

---

## 2. Infrastructure Requirements & Specs

| Component | Target Specification | Purpose |
|---|---|---|
| **Hypervisor** | Proxmox VE 8.x / 9.x | Physical hardware virtualization |
| **Virtualization Type** | **Unprivileged LXC Container** | Lightweight, security-isolated OS container |
| **Operating System** | Ubuntu 24.04 LTS (x86_64) | Production operating system |
| **vCPU** | 1 Core | Sufficient for single-threaded Node.js event loop |
| **RAM** | 1024 MiB (1 GB) | Active app runs at **~45 MB RAM** |
| **Disk** | 10 GB (Thin-provisioned) | OS, Node runtime, SQLite DB, and backups |
| **Network** | `vmbr0` (DHCP or Static IP) | LAN connectivity |
| **Features** | `Nesting=1`, `TUN/TAP=1` | Required for containers and tunneling |

---

## 3. Initial Server Provisioning (Zero to Running)

### Step 3.1: Create Container in Proxmox
Run the Proxmox Community Helper script in your Proxmox Host Node Shell:
```bash
bash -c "$(wget -qLO - https://github.com/community-scripts/ProxmoxVE/raw/main/ct/ubuntu.sh)"
```
* **Type:** Unprivileged
* **Hostname:** `jewelry-shop`
* **CPU:** 1 Core
* **RAM:** 1024 MB
* **Disk:** 10 GB
* **Features:** Enable Nesting and TUN/TAP

---

### Step 3.2: Install Core Runtimes (Inside Container)
Open the container console (`pct enter 100` or Proxmox Web GUI console) and run:

```bash
# 1. Update system packages
apt update && apt upgrade -y
apt install -y curl git build-essential sqlite3

# 2. Install Node.js 22 LTS (Required for better-sqlite3 v13+)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 3. Install PM2 process supervisor globally
npm install -g pm2
pm2 startup systemd -u root --hp /root

# 4. Install Cloudflared Linux package
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb && rm cloudflared.deb

# Verify tool versions
node -v          # Expected: v22.x
npm -v           # Expected: 10.x
cloudflared -v   # Expected: 2026.x+
```

---

### Step 3.3: Set Up Cloudflare Zero Trust Tunnel
Because residential ISPs operate under Carrier-Grade NAT (CGNAT) without public IPv4 addresses, `cloudflared` creates an outbound-only connection directly to Cloudflare's edge:

1. In [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com) → **Networks** → **Tunnels** → Select your tunnel.
2. Under **Public Hostnames**, configure:
   * **Domain:** `test.trapiseth.site` (or your custom subdomain)
   * **Service Type:** `HTTP`
   * **URL:** `localhost:3000`
3. In your container terminal, install the tunnel service:
   ```bash
   cloudflared service install <YOUR_TUNNEL_TOKEN>
   systemctl start cloudflared
   systemctl enable cloudflared
   ```
4. Verify tunnel status:
   ```bash
   systemctl status cloudflared
   ```

---

### Step 3.4: Clone & Configure Application
Inside the container:

```bash
# 1. Clone repository
git clone <YOUR_GITHUB_REPO_URL> /root/jewelry-shop
cd /root/jewelry-shop

# 2. Configure Production .env
nano .env
```

Paste your production credentials:
```env
APP_SECRET=your_facebook_app_secret
APP_ID=your_facebook_app_id
APP_SESSION_TOKEN=your_meta_page_access_token
BASE_URL=https://test.trapiseth.site
VERIFY_TOKEN=jewelry_secret_webhook_token_2026
ADMIN_PASSWORD=your_secure_admin_password
NODE_ENV=production
PORT=3000
```

```bash
# 3. Install dependencies and compile native SQLite bindings
npm install

# 4. Launch with PM2 using ecosystem configuration
pm2 start ecosystem.config.js
pm2 save
```

---

## 4. Environment Variables Reference

| Variable Name | Environment | Example Value | Description |
|---|---|---|---|
| `NODE_ENV` | Production | `production` | Disables demo banner and mock PSID bypass. Mandates valid HMAC. |
| `NODE_ENV` | Local Dev | `development` | Enables yellow demo bar & `sig=demo-bypass` simulation. |
| `PORT` | Both | `3000` | Port Express listens on. |
| `BASE_URL` | Production | `https://test.trapiseth.site` | Canonical domain used to construct signed webview links. |
| `BASE_URL` | Local Dev | `http://localhost:3000` | Local address for development. |
| `ADMIN_PASSWORD` | Both | `admin` (or secret PIN) | Password required to unlock `/admin` dashboard. |
| `APP_SECRET` | Both | `500f9dd...` | Meta App Secret used to sign & verify HMAC-SHA256 tokens. |
| `APP_ID` | Both | `1900045...` | Meta App ID. |
| `APP_SESSION_TOKEN`| Both | `EAAbAF...` | Meta Page Access Token for dispatching Graph API messages. |
| `VERIFY_TOKEN` | Both | `jewelry_secret_...` | Pre-shared token for Meta webhook subscription challenge. |

---

## 5. Development & CI/CD Deployment Workflow

### 5.1. Local Development (Windows PC)
Make code changes locally and test without affecting the live store:
1. Ensure local `.env` has `NODE_ENV=development`.
2. Start dev server with file auto-reloading:
   ```powershell
   npm run dev
   ```
3. Test catalog, cart, and simulated checkouts at `http://localhost:3000`.

---

### 5.2. Pushing Updates to GitHub
Once verified on your PC, stage and push the changes:

```powershell
# 1. Stage changes
git add .

# 2. Commit with descriptive message
git commit -m "feat: add category filter for earrings"

# 3. Push to remote branch
git push origin feature/phase1-core-commerce
```

---

### 5.3. Deploying to Homelab (Zero-Downtime Reload)

#### Option A: Pulling directly on the server
SSH into container (`ssh root@192.168.100.232`):
```bash
cd /root/jewelry-shop

# 1. Fetch latest code
git pull

# 2. Only if you added new packages in package.json:
npm install

# 3. Reload with zero downtime
pm2 reload jewelry-shop
```

#### Option B: The 1-Line Remote Deploy (Run from Windows)
Execute deployment remotely from your Windows PowerShell in one command:

```powershell
ssh root@192.168.100.232 "cd /root/jewelry-shop && git pull && pm2 reload jewelry-shop"
```

> **Why `pm2 reload` instead of `restart`?**  
> `pm2 reload` performs a hot, rolling reload: it starts a new worker process first, verifies it binds successfully to port 3000, and only then tears down the old process. Active customers experience **0 milliseconds of downtime**.

---

## 6. Operations & Maintenance Runbook

### 6.1. Process Monitoring
```bash
# View active processes, CPU, RAM, and uptime
pm2 status

# Interactive terminal dashboard (real-time metrics)
pm2 monit

# Check live stream logs (traffic, orders, webhooks)
pm2 logs jewelry-shop --lines 50
```

---

### 6.2. Cloudflare Tunnel Health
```bash
# Check service health
systemctl status cloudflared

# Follow real-time tunnel logs
journalctl -u cloudflared -f

# Restart tunnel service if degraded
systemctl restart cloudflared
```

---

### 6.3. Automated Database Backups (Zero-Downtime)
Because SQLite runs in **Write-Ahead Logging (WAL)** mode, you can safely create consistent database snapshots while active orders are being processed.

Create a nightly backup cron job:
```bash
crontab -e
```
Add the following entry (runs daily at 3:00 AM):
```cron
0 3 * * * sqlite3 /root/jewelry-shop/shop.db "VACUUM INTO '/root/jewelry-shop/backups/shop-$(date +\%F).db'"
```

---

## 7. Troubleshooting & Recovery Matrix

| Issue / Symptom | Possible Cause | Verification & Resolution |
|---|---|---|
| `502 Bad Gateway` on domain | Node.js process crashed or not listening on port 3000 | Run `pm2 status`. If errored, check `pm2 logs jewelry-shop --lines 30`. Verify `curl http://localhost:3000`. |
| `1033 / 1003 Tunnel Error` | `cloudflared` service stopped or tunnel token invalidated | Run `systemctl status cloudflared`. Restart via `systemctl restart cloudflared`. Check Cloudflare Zero Trust console. |
| Inbound webhook silent (no logs) | Meta App is in Development Mode and user is not a Tester | Go to Meta Developers → **App Roles → Roles → Testers** → Add user's Facebook account. |
| `EBADENGINE` or C++ build failure | Node version mismatch for `better-sqlite3` | Check `node -v`. Must be **Node.js 22 LTS**. Run `npm rebuild` to recompile native C++ binaries. |
| Admin panel displays 401 | Invalid or expired admin session token | Log in via `/admin` password prompt (`ADMIN_PASSWORD`). Check that `ADMIN_PASSWORD` in `.env` matches your entry. |
| Stock not decrementing on order | By design: stock only decrements on **owner confirmation** | Decrements occur when owner taps **Confirm** on `/admin` to prevent cart abandonment inventory lockouts. |
