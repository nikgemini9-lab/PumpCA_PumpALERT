# PumpAlert — pump.fun CA Tracker for AXIOM holders

Get instant Telegram alerts when tokens you're holding on AXIOM start pumping.

**How it works:**
- Tracks your tokens' pump.fun **bonding curves directly on-chain** via Solana WebSocket
- Also polls **DexScreener** for price/volume data (covers graduated tokens on Raydium too)
- Sends Telegram alerts with buy count, price change %, market cap and direct links to Axiom/DexScreener

---

## Setup (5 minutes)

### 1. Create a Telegram Bot

1. Open Telegram, search for **@BotFather**
2. Send `/newbot` and follow the steps
3. Copy the **bot token** (looks like `7123456789:AAHxxxx...`)

### 2. Get your Chat ID

1. Start a chat with your new bot
2. Send `/start`
3. The bot will reply with your **Chat ID** — copy it

### 3. Get a Free Helius API Key (recommended)

Helius gives you a stable WebSocket connection. Public RPCs are rate-limited.

1. Go to [dev.helius.xyz](https://dev.helius.xyz)
2. Sign up (free), create a project
3. Copy your **API key**

### 4. Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/PumpCA_PumpALERT
cd PumpCA_PumpALERT
cp .env.example .env
```

Edit `.env`:
```env
TELEGRAM_BOT_TOKEN=7123456789:AAHxxxxxxxx
TELEGRAM_CHAT_ID=123456789
HELIUS_API_KEY=your-helius-key        # optional but recommended
PRICE_CHANGE_ALERT_PERCENT=15         # alert when price +15% in 5 min
BUY_COUNT_ALERT=5                     # alert when 5 buys in 5 min
ALERT_COOLDOWN_MINUTES=10             # don't spam same token
```

---

## Deployment (24/7, no tab needed)

### Option A: Fly.io (Recommended — truly free, never sleeps)

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login / signup
fly auth login

# Launch (first time only)
fly launch --name pump-alert --region ord --no-deploy

# Create persistent volume for SQLite
fly volumes create pump_alert_data --size 1 --region ord

# Set secrets
fly secrets set TELEGRAM_BOT_TOKEN=your_token
fly secrets set TELEGRAM_CHAT_ID=your_chat_id
fly secrets set HELIUS_API_KEY=your_key

# Deploy
fly deploy
```

The `fly.toml` already has `auto_stop_machines = false` so it **never sleeps**.

### Option B: Render.com (Free with UptimeRobot trick)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New Web Service → connect your repo
3. Render auto-detects `render.yaml`
4. Add env vars in the dashboard (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, HELIUS_API_KEY)
5. Deploy

**Important:** Render free tier sleeps after 15 min.
Fix: Create a free [UptimeRobot](https://uptimerobot.com) monitor pinging `https://your-app.onrender.com/health` every 5 minutes. This keeps it alive permanently.

### Option C: Local / any VPS

```bash
npm install
npm run build
npm start
```

Use `pm2` or `systemd` to keep it alive:
```bash
npm install -g pm2
pm2 start dist/index.js --name pump-alert
pm2 save && pm2 startup
```

---

## Using the Bot

Once deployed, open Telegram and talk to your bot:

| Command | What it does |
|---|---|
| `/add <CA>` | Track a token by contract address |
| `/remove <CA>` | Stop tracking |
| `/list` | Show all tracked tokens + price/MC |
| `/status` | WebSocket health, uptime, last poll |
| `/thresholds` | Show current alert settings |
| `/set pricechange 20` | Change price alert to 20% |
| `/set buycount 8` | Change buy count threshold |
| `/set cooldown 15` | Change cooldown between alerts |

**Example alert you'll receive:**

```
🚀 PUMP ALERT!

BONK  $BONK
HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98fjR

📈 Price  +23.5% in 5 min
🛒 Buys   8 in 5 min
💰 Size   4.2 SOL
📊 Vol    $12.3K (5m)
💎 MC     $42.1K

📊 Axiom  |  📈 DexScr  |  🎱 pump.fun
```

---

## Alert Logic

**On-chain (real-time, for pre-graduation tokens):**
- Subscribes to the pump.fun bonding curve PDA for each token
- Detects buys by watching `virtualSolReserves` increase
- Alerts when: N buys in M minutes OR price ratio increases X%

**DexScreener (30s polling, for graduated tokens too):**
- Polls `priceChange.m5` and `txns.m5.buys`
- Alerts when either exceeds thresholds
- Also keeps token metadata (name, symbol, price) up to date

**Cooldown:** After alerting on a token, that token is silenced for N minutes (default 10) to prevent spam.

---

## Why Fly.io and not Railway?

Railway's free tier doesn't support persistent background workers without keeping a tab open. **Fly.io free tier includes real VMs** (`auto_stop_machines = false`) that run indefinitely — no tab, no credit card needed for the free allocation.
