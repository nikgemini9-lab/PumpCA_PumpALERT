# PumpALERT — Tool Overview

## What It Does

PumpALERT is a 24/7 real-time monitoring and alert system for **Solana pump.fun tokens**. It watches tokens you manually add (via contract address) or auto-discovers from tracked wallet holdings, then fires Telegram alerts the moment a pump condition is met.

**Key capabilities:**
- Real-time on-chain bonding curve monitoring via Solana WebSocket
- DexScreener polling for price, market cap, and volume
- Axiom.trade viewer count tracking (requires session cookie)
- Twitter/X follower spike detection
- OG Hunter: finds older tokens with the same name when a newer version migrates to Raydium
- Dormant coin radar: flags old tokens that suddenly move again
- Web dashboard for live token tracking

**Users:** Nik + Josh (AXIOM traders) — alerts routed per wallet owner where relevant.

---

## Alert Conditions

| # | Alert Type | Trigger Condition | Threshold | Configurable? | Cooldown | Data Source |
|---|-----------|------------------|-----------|---------------|----------|-------------|
| 1 | **Price Pump** | 5-min price change ≥ threshold | `15%` default | Yes — `PRICE_CHANGE_ALERT_PERCENT` | 10 min global | DexScreener / On-chain |
| 2 | **Buy Count** | N buys within rolling time window | `5 buys / 5 min` default | Yes — `BUY_COUNT_ALERT`, `BUY_COUNT_WINDOW_MINUTES` | 10 min global | DexScreener / On-chain |
| 3 | **Axiom Viewers** | Live viewer count on Axiom ≥ threshold | `50 viewers` default | Yes — `VIEWER_COUNT_ALERT` | 5 min (separate, per token) | Axiom API (cookie required) |
| 4 | **Twitter Follower Spike** | Follower count increases by ≥ 5% since last poll | `5%` hardcoded | No | 10 min global | Twitter Widget API |
| 5 | **OG Radar Hit** | A newer token with the same name graduates & MC > $25K, while an older OG version still has MC < $5K | Runner MC `$25K`, OG MC `$5K` (both hardcoded) | No | Once per migrated token (stored in DB) | DexScreener + pump.fun |
| 6 | **OG Milestone** | After an OG Radar hit, the OG token's MC reaches 2x / 3x / 5x / 10x from its detection price | `2x, 3x, 5x, 10x` hardcoded | No | Once per milestone per token | pump.fun API |
| 7 | **Dormant Coin** | Token aged ≥ 25 days suddenly moves: ≥ 30% in 1h OR ≥ 60% in 6h | Age `25 days`, move `30%/1h` or `60%/6h` (hardcoded) | No | Once per token per session | DexScreener via Movers Poller |

---

## Condition Details

### 1. Price Pump
Fires when the 5-minute price change for a tracked token hits the threshold. Works both from on-chain bonding curve deltas (pre-graduation) and DexScreener's `priceChange.m5` field (post-graduation). A re-alert only fires if the price has also moved ≥ threshold since the *last alert's anchor price*, preventing repeated alerts on a flat chart.

### 2. Buy Count
Counts buys in a rolling window. On-chain source uses WebSocket account change events (SOL reserve increase = buy). DexScreener source uses `txns.m5.buys`. Both feed the same AlertManager check.

### 3. Axiom Viewers
Requires `AXIOM_COOKIE` env var (your session cookie from axiom.trade). Polls every 30 seconds. Viewer alerts have their own 5-minute cooldown independent of the global cooldown — so a viewer spike can alert even if a price alert just fired.

### 4. Twitter Follower Spike
Polls the Twitter widget API every 5 minutes (no auth needed). Compares current follower count to the previous reading. If the percentage increase ≥ 5%, a social alert fires alongside any price data available at that moment.

### 5. OG Radar Hit
Triggered when any monitored or discovered mover:
- Has graduated from pump.fun to Raydium (bonding curve complete)
- Reaches a market cap > $25,000

The system then searches pump.fun for an **older token with the same name or symbol**. If one is found with MC < $5,000, it fires a Telegram alert with: the OG's CA, its age in hours, recent buy count (last 3h), and the gap ratio (runner MC ÷ OG MC). Each migrated token only triggers one OG radar alert (deduplicated in the database).

### 6. OG Milestone
After an OG Radar Hit, the system tracks that OG token every 3 minutes for 24 hours. When the OG's market cap crosses 2×, 3×, 5×, or 10× of its value at detection time, a milestone alert fires. Each milestone fires only once per token and resets on restart.

### 7. Dormant Coin
The Movers Poller continuously discovers tokens from recent on-chain pump.fun swap transactions. For each token it enriches with DexScreener data, it checks:
- Token age ≥ 25 days (old/dormant token)
- Last traded within the past 24 hours (still active)
- Price moved ≥ 30% in the last hour **OR** ≥ 60% in the last 6 hours

If all conditions pass, a dormant alert fires once per session per token. The alert also shows the live Axiom viewer count if available and links to any OG Radar hit that may have caused the movement.

---

## Global Alert Gating Rules

| Rule | Value | Notes |
|------|-------|-------|
| Global cooldown | 10 min (default) | Between any two alerts for the same token |
| Hard minimum gap | 2 min | Enforced even if cooldown is set lower |
| Re-alert price gate | Must move ≥ threshold from last alert anchor | Prevents flat-chart spam |
| Viewer cooldown | 5 min (separate) | Independent of global cooldown |
| OG Radar dedup | Once per migrated token | Stored in DB, survives restarts |
| Dormant dedup | Once per session | In-memory, resets on restart |

---

## Configurable Thresholds (`.env`)

| Variable | Default | What It Controls |
|----------|---------|-----------------|
| `PRICE_CHANGE_ALERT_PERCENT` | `15` | % price move to trigger pump alert |
| `BUY_COUNT_ALERT` | `5` | Number of buys to trigger buy alert |
| `BUY_COUNT_WINDOW_MINUTES` | `5` | Rolling window for buy count |
| `ALERT_COOLDOWN_MINUTES` | `10` | Minutes between repeated alerts per token |
| `VIEWER_COUNT_ALERT` | `50` | Axiom viewers threshold |
| `AXIOM_POLL_INTERVAL_SECONDS` | `30` | How often to poll Axiom |
| `POLL_INTERVAL_SECONDS` | `30` | How often to poll DexScreener |

---

## Telegram Commands

| Command | What It Does |
|---------|-------------|
| `/add <CA>` | Add a token to the watchlist |
| `/remove <CA>` | Remove a token |
| `/list` | Show all tracked tokens |
| `/status` | WebSocket health, uptime, last poll time |
| `/thresholds` | Show current alert thresholds |
| `/set pricechange <pct>` | Update price alert threshold |
| `/set buycount <n>` | Update buy count threshold |
| `/set cooldown <min>` | Update alert cooldown |
| `/og <name>` | Manually search for OG token by name |
| `/wallets` | List tracked wallets |
| `/addwallet <nik\|josh> <addr>` | Track a wallet (auto-adds holdings) |
| `/removewallet <addr>` | Stop tracking a wallet |
