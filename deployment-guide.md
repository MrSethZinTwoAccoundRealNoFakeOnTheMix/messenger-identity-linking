# Deployment & Git Workflow Guide — Local Dev to Homelab Production

This guide documents the complete development-to-production lifecycle for the **Jewelry Mini-Shop** application. It details how changes developed and tested on your local Windows PC are committed to GitHub and deployed with zero downtime to the 24/7 Proxmox LXC homelab container.

---

## 1. System Topology & Environment Separation

```
 ┌──────────────────────────────────────┐          ┌──────────────────────────────────────┐
 │       Windows Local Dev Machine      │          │       GitHub Remote Repository       │
 │                                      │          │                                      │
 │ • Worktree: D:\Test Page SDK\...     │          │ • Branch: feature/phase1-...         │
 │ • Mode: NODE_ENV=development         │ ───────► │ • Role: Single Source of Truth       │
 │ • URL: http://localhost:3000         │ git push │                                      │
 │ • Test: Yellow Demo PSID Banner      │          └──────────────────┬───────────────────┘
 └──────────────────────────────────────┘                             │
                                                                      │ git pull
                                                                      ▼
                                                   ┌──────────────────────────────────────┐
                                                   │    Homelab Production Container      │
                                                   │                                      │
                                                   │ • Node: Proxmox LXC 100 (Ubuntu 24)  │
                                                   │ • IP: 192.168.100.232 / :3000        │
                                                   │ • Supervisor: PM2 daemon             │
                                                   │ • Ingress: Cloudflare Tunnel Service │
                                                   │ • Live URL: https://test.trapiseth.site
                                                   └──────────────────────────────────────┘
```

---

## 2. The Standard 2-Step Workflow

### Step 1: On Your Windows PC (Save & Push Changes)

Whenever you finish creating a feature, modifying styles, or updating backend routes:

```powershell
# 1. Review what files you modified or created
git status

# 2. Stage all modifications
git add .

# 3. Create a snapshot commit with a descriptive summary
git commit -m "feat: add category filter for necklaces and rings"

# 4. Push your commit to GitHub
git push origin feature/phase1-core-commerce
```

---

### Step 2: On Your Homelab Container (Pull & Deploy)

SSH into your container (or open the Proxmox Console for container `100`):

```bash
# 1. Navigate to the project directory
cd /root/jewelry-shop

# 2. Fetch and merge the latest code from GitHub
git pull

# 3. Only run if you added new packages to package.json:
npm install

# 4. Zero-downtime hot reload
pm2 reload jewelry-shop
```

---

## 3. Detailed Command-by-Command Breakdown

### Windows Side (Development & Version Control)

| Command | What It Actually Does | Why It Is Important |
|---|---|---|
| `git status` | Compares your working directory against the last commit. Shows modified (`M`), untracked (`??`), or deleted files. | Prevents accidentally committing sensitive files or leaving out new files. |
| `git add .` | Stages all modified and newly created files in the current folder into the Git staging area (index). | Prepares your work into an organized batch before permanently recording it. |
| `git commit -m "..."` | Packages all staged files into a permanent cryptographic snapshot (commit) tagged with your author info, date, and description. | Creates a checkpoint in history you can review, roll back to, or inspect later. |
| `git push origin <branch>` | Uploads your local commits over SSH/HTTPS to your remote GitHub repository. | Synchronizes your code to the cloud so your homelab server can access it. |

---

### Homelab Container Side (Production Deployment)

| Command | What It Actually Does | Why It Is Important |
|---|---|---|
| `cd /root/jewelry-shop` | Sets the current working directory to the application root. | Ensures all git, npm, and PM2 commands execute against the correct project context. |
| `git pull` | Connects to GitHub, checks for new commits on the current branch, and updates the local files on disk. | Transfers only the changed code lines without needing manual file uploads. |
| `npm install` | Scans `package.json` and installs any missing libraries into `node_modules`. | Ensures newly added dependencies are compiled for the Linux container architecture. |
| `pm2 reload jewelry-shop` | Instructs the PM2 supervisor to perform a **Zero-Downtime Hot Reload**. It spawns the new process first, verifies it binds to port 3000, and gracefully terminates the old worker. | Unlike `pm2 restart` (which causes a 1-2 second outage), `pm2 reload` drops **zero** customer requests. |
| `pm2 status` | Prints a tabular status screen showing memory usage, uptime, restart counts, and CPU utilization. | Used to quickly verify that the application is `online` and consuming expected resources (~45 MB). |
| `pm2 logs jewelry-shop --lines 30` | Streams the last 30 lines of application output (`stdout` and `stderr`). | Shows real-time incoming webhook triggers, Meta API responses, and order confirmations. |

---

## 4. First-Time Git Setup on the Container (One-Time Link)

If your container folder was originally populated via `scp` and does not yet have Git linked to your GitHub repository, run this **once** inside the container:

```bash
cd /root/jewelry-shop

# Initialize Git in the directory
git init

# Connect to your GitHub repository
git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPO>.git

# Fetch the remote branches
git fetch origin

# Track the active feature branch
git checkout -f feature/phase1-core-commerce

# Verify connection
git status
```

---

## 5. The 1-Line Remote Deployment Shortcut (PowerShell)

You don't need to open the Proxmox console or separate SSH sessions every time. After pushing from Windows, you can trigger the entire production deployment in **one single command** right from your Windows PowerShell:

```powershell
ssh root@192.168.100.232 "cd /root/jewelry-shop && git pull && pm2 reload jewelry-shop"
```

> **Result:** Your homelab server pulls the newest commit and completes a zero-downtime hot reload in under **2 seconds**.

---

## 6. Troubleshooting Common Deployment Scenarios

### Scenario A: Local Changes on the Container Blocking `git pull`
* **Error:** `error: Your local changes to the following files would be overwritten by merge`
* **Cause:** A file was manually edited on the server or a database file was touched.
* **Fix:** Reset the server worktree to match GitHub exactly:
  ```bash
  cd /root/jewelry-shop
  git fetch --all
  git reset --hard origin/feature/phase1-core-commerce
  pm2 reload jewelry-shop
  ```

### Scenario B: You Changed Environment Variables (`.env`)
* **Note:** `pm2 reload` caches existing environment variables by default.
* **Fix:** If you updated `.env` (e.g. changed `ADMIN_PASSWORD` or `BASE_URL`), tell PM2 to refresh environment values:
  ```bash
  pm2 restart jewelry-shop --update-env
  ```

### Scenario C: C++ Native Modules (`better-sqlite3`) Need Rebuilding
* **Note:** If `better-sqlite3` fails after a Node or OS package upgrade.
* **Fix:** Run native recompilation:
  ```bash
  npm rebuild better-sqlite3
  pm2 reload jewelry-shop
  ```
