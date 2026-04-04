/**
 * Express HTTP server
 *
 * Routes:
 *   GET  /health                  — health check (Fly.io / UptimeRobot)
 *   GET  /                        — serves the web dashboard (HTML)
 *
 * REST API (all require DASHBOARD_SECRET if set):
 *   GET  /api/status              — uptime, counts
 *   GET  /api/watchlist           — all active tokens
 *   POST /api/watchlist           — { mint } add token
 *   DELETE /api/watchlist/:mint   — remove token
 *   GET  /api/wallets             — all tracked wallets with holdings
 *   POST /api/wallets             — { label, address } add wallet
 *   DELETE /api/wallets/:address  — remove wallet
 *   GET  /api/alerts              — recent 50 alerts
 *   GET  /api/users               — configured user names (no chat IDs)
 *   GET  /api/target-zone         — pump.fun coins ≥30d old, MC $8K-$14K (sortable)
 *
 * Webhook (no auth check — Helius uses its own authHeader mechanism):
 *   POST /api/webhook/helius      — receives Helius enhanced transaction events
 */

import express, { Request, Response, NextFunction } from 'express'
import path from 'path'
import axios from 'axios'
import { config } from './config'
import * as db from './database'
import { MonitorStatus } from './types'
import { SolanaMonitor } from './monitor'
import { WalletPoller, SKIP_MINTS } from './walletPoller'
import { syncWebhook, parseWebhookTransfers } from './heliusWebhook'
import { MoversPoller } from './movers'
import type { AxiomPoller } from './axiomPoller'

// ── API health check (cached, refreshed every 5 min) ──────────────────────────

interface ApiCheck {
  name:         string
  env?:         string          // env var name that enables this service (omit = always-on)
  configured:   boolean         // key/token is present
  ok:           boolean | null  // null = not yet checked or not configured
  latencyMs:    number | null
  error?:       string
  checkedAt:    number | null   // epoch ms
}

let _apiStatusCache: ApiCheck[] = []
let _apiStatusTs = 0
const API_STATUS_TTL = 5 * 60_000  // 5 minutes

async function ping(url: string, opts: {
  method?: 'get' | 'post'
  data?: object
  headers?: Record<string, string>
  timeout?: number
  okStatuses?: number[]  // extra HTTP codes to treat as "ok" (e.g. 429 rate limit = reachable)
} = {}): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now()
  const extraOk = new Set(opts.okStatuses ?? [])
  try {
    await axios({ method: opts.method ?? 'get', url, data: opts.data, headers: opts.headers, timeout: opts.timeout ?? 7_000 })
    return { ok: true, latencyMs: Date.now() - t0 }
  } catch (err: any) {
    const status: number | undefined = err?.response?.status
    if (status && extraOk.has(status)) return { ok: true, latencyMs: Date.now() - t0 }
    return { ok: false, latencyMs: Date.now() - t0, error: status ? `HTTP ${status}` : err?.message?.slice(0, 60) }
  }
}

async function refreshApiStatus(): Promise<ApiCheck[]> {
  const now = Date.now()
  const checks: ApiCheck[] = []

  // Helper to push a result
  const add = (base: Omit<ApiCheck, 'checkedAt'>) =>
    checks.push({ ...base, checkedAt: now })

  // 1. Helius RPC
  if (config.solana.heliusApiKey) {
    const r = await ping(config.solana.rpcUrl, {
      method: 'post',
      data: { jsonrpc: '2.0', id: 1, method: 'getHealth' },
      headers: { 'Content-Type': 'application/json' },
    })
    add({ name: 'Helius RPC', env: 'HELIUS_API_KEY', configured: true, ok: r.ok, latencyMs: r.latencyMs, error: r.error })
  } else {
    add({ name: 'Helius RPC', env: 'HELIUS_API_KEY', configured: false, ok: null, latencyMs: null })
  }

  // 2. Telegram Bot
  {
    const r = await ping(`https://api.telegram.org/bot${config.telegram.botToken}/getMe`, { timeout: 6_000 })
    add({ name: 'Telegram Bot', env: 'TELEGRAM_BOT_TOKEN', configured: !!config.telegram.botToken, ok: r.ok, latencyMs: r.latencyMs, error: r.error })
  }

  // 3. GeckoTerminal — free, always-on (429 = rate limited but reachable = still ok)
  {
    const r = await ping('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools', {
      headers: { Accept: 'application/json' },
      okStatuses: [429],
    })
    add({ name: 'GeckoTerminal', configured: true, ok: r.ok, latencyMs: r.latencyMs, error: r.error })
  }

  // 4. DexScreener — free, always-on
  {
    const r = await ping('https://api.dexscreener.com/token-boosts/active/v1', { timeout: 6_000 })
    add({ name: 'DexScreener', configured: true, ok: r.ok, latencyMs: r.latencyMs, error: r.error })
  }

  // 5. pump.fun API — free, always-on
  {
    const r = await ping('https://frontend-api.pump.fun/coins?limit=1&sort=last_trade_timestamp&order=DESC', {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      timeout: 6_000,
    })
    add({ name: 'pump.fun API', configured: true, ok: r.ok, latencyMs: r.latencyMs, error: r.error })
  }

  // 6. Birdeye — optional paid key
  if (config.birdeye.apiKey) {
    const r = await ping('https://public-api.birdeye.so/defi/tokenlist?limit=1&sort_by=v24hChangePercent&sort_type=desc', {
      headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': 'solana' },
      timeout: 7_000,
    })
    add({ name: 'Birdeye', env: 'BIRDEYE_API_KEY', configured: true, ok: r.ok, latencyMs: r.latencyMs, error: r.error })
  } else {
    add({ name: 'Birdeye', env: 'BIRDEYE_API_KEY', configured: false, ok: null, latencyMs: null })
  }

  // 7. CoinMarketCap — optional paid key
  if (config.cmc.apiKey) {
    const r = await ping('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=1', {
      headers: { 'X-CMC_PRO_API_KEY': config.cmc.apiKey },
      timeout: 7_000,
    })
    add({ name: 'CMC (SOL price)', env: 'CMC_API_KEY', configured: true, ok: r.ok, latencyMs: r.latencyMs, error: r.error })
  } else {
    add({ name: 'CMC (SOL price)', env: 'CMC_API_KEY', configured: false, ok: null, latencyMs: null })
  }

  _apiStatusCache = checks
  _apiStatusTs = now
  return checks
}

function getApiStatusCached(): Promise<ApiCheck[]> {
  if (Date.now() - _apiStatusTs < API_STATUS_TTL && _apiStatusCache.length > 0) {
    return Promise.resolve(_apiStatusCache)
  }
  return refreshApiStatus()
}

export function startServer(
  getStatus: () => Promise<MonitorStatus>,
  monitor: SolanaMonitor,
  walletPoller: WalletPoller,
  moversPoller: MoversPoller,
  axiomPoller: AxiomPoller | null = null
): void {
  const app = express()
  app.use(express.json())

  // ── Static dashboard ──────────────────────────────────────────────────────
  const publicDir = path.join(__dirname, 'public')
  app.use(express.static(publicDir))

  // ── Health check (no auth) ────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', ts: new Date().toISOString() })
  })

  // ── Helius webhook receiver (no dashboard auth — uses authHeader from Helius) ──
  app.post('/api/webhook/helius', async (req: Request, res: Response) => {
    // Verify the authHeader Helius was configured with (equals DASHBOARD_SECRET if set)
    if (config.dashboard.secret) {
      const provided = req.headers.authorization
      if (provided !== config.dashboard.secret) {
        res.status(401).send()
        return
      }
    }

    // Always respond 200 immediately — Helius retries on non-2xx
    res.status(200).send()

    try {
      const transactions = Array.isArray(req.body) ? req.body : [req.body]
      const trackedWallets = new Set((await db.getWallets()).map(w => w.address))
      const events = parseWebhookTransfers(transactions, trackedWallets)

      for (const event of events) {
        // Skip junk tokens (e.g. Wrapped SOL)
        if (SKIP_MINTS.has(event.mint)) continue

        // Update holdings directly from webhook data — zero RPC, zero credits
        await db.adjustHolding(event.walletAddress, event.mint, event.delta)

        // If this is a new token received, add it to the watchlist
        if (event.delta > 0) {
          const added = await db.addToken(event.mint, 'Unknown', '?', 'wallet', event.walletAddress)
          if (added) {
            console.log(`[Webhook] New token for ${event.walletAddress.slice(0, 8)}...: ${event.mint.slice(0, 8)}... — added to watchlist`)
            monitor.subscribeToToken(event.mint).catch(err => {
              console.error('[Webhook] Subscribe error:', err?.message)
            })
          }
        }
      }

      if (events.length > 0) {
        console.log(`[Webhook] Processed ${events.length} transfer event(s)`)
      }
    } catch (err) {
      console.error('[Webhook] Parse error:', err)
    }
  })

  // ── Auth middleware for /api/* (excluding webhook above) ──────────────────
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    // Webhook route already handled above
    if (req.path === '/webhook/helius') return next()

    const secret = config.dashboard.secret
    if (!secret) return next()

    const authHeader = req.headers.authorization
    const queryKey = req.query.key as string | undefined
    const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : queryKey

    if (provided === secret) return next()
    res.status(401).json({ error: 'Unauthorized' })
  })

  // ── GET /api/status ───────────────────────────────────────────────────────
  app.get('/api/status', async (_req: Request, res: Response) => {
    const status = await getStatus()
    const wallets = await db.getWallets()
    res.json({
      online: true,
      uptime_ms: status.uptime,
      started_at: new Date(status.startedAt).toISOString(),
      tracked_tokens: status.trackedTokens,
      tracked_wallets: wallets.length,
      onchain_subscriptions: status.onchainSubscriptions,
      last_poll_at: status.lastPollAt ? new Date(status.lastPollAt).toISOString() : null,
      users: config.telegram.users.map(u => u.name),
      webhook_active: !!config.solana.heliusApiKey && !!config.appUrl,
    })
  })

  // ── GET /api/watchlist ────────────────────────────────────────────────────
  app.get('/api/watchlist', async (_req: Request, res: Response) => {
    const tokens = await db.getActiveTokens()
    const result = await Promise.all(tokens.map(async t => ({
      mint: t.mint,
      name: t.name,
      symbol: t.symbol,
      price_usd: t.priceUsd,
      market_cap: t.marketCap,
      added_at: t.addedAt,
      source: t.source,
      wallet_source: t.walletSource,
      twitter_handle: t.twitterHandle ?? null,
      twitter_followers: t.twitterFollowers ?? null,
      twitter_followers_prev: t.twitterFollowersPrev ?? null,
      axiom_user_count: t.axiomUserCount ?? null,
      axiom_top10_holders: t.axiomTop10Holders ?? null,
      axiom_lp_burned: t.axiomLpBurned ?? null,
      axiom_dex_paid: t.axiomDexPaid ?? null,
      axiom_dev_funded_sol: t.axiomDevFundedSol ?? null,
      axiom_updated_at: t.axiomUpdatedAt ?? null,
      price_updated_at: t.priceUpdatedAt ?? null,
      alert_count: await db.getAlertCount(t.mint),
    })))
    res.json(result)
  })

  // ── POST /api/watchlist ───────────────────────────────────────────────────
  app.post('/api/watchlist', async (req: Request, res: Response) => {
    const { mint } = req.body as { mint?: string }
    if (!mint || typeof mint !== 'string' || mint.trim().length < 32) {
      res.status(400).json({ error: 'Invalid mint address' })
      return
    }

    const added = await db.addToken(mint.trim(), 'Unknown', '?', 'manual', null)
    if (!added) {
      res.status(409).json({ error: 'Already tracking this token' })
      return
    }

    monitor.subscribeToToken(mint.trim()).catch(err => {
      console.error(`[Server] subscribe error for ${mint}:`, err)
    })

    res.status(201).json({ ok: true, mint: mint.trim() })
  })

  // ── POST /api/watchlist/:mint/twitter — manually set Twitter handle ────────
  app.post('/api/watchlist/:mint/twitter', async (req: Request, res: Response) => {
    const { mint } = req.params
    const { handle } = req.body as { handle?: string }
    if (!handle || typeof handle !== 'string') {
      res.status(400).json({ error: 'handle required' })
      return
    }
    const clean = handle.replace(/^@/, '').trim().toLowerCase()
    if (!clean) { res.status(400).json({ error: 'Invalid handle' }); return }
    await db.updateTokenMetadata(mint, { twitterHandle: clean })
    res.json({ ok: true, handle: clean })
  })

  // ── DELETE /api/watchlist/:mint ───────────────────────────────────────────
  app.delete('/api/watchlist/:mint', async (req: Request, res: Response) => {
    const { mint } = req.params
    const removed = await db.removeToken(mint)
    if (!removed) {
      res.status(404).json({ error: 'Token not found' })
      return
    }
    monitor.unsubscribeFromToken(mint).catch(() => {})
    res.json({ ok: true })
  })

  // ── GET /api/wallets ──────────────────────────────────────────────────────
  app.get('/api/wallets', async (_req: Request, res: Response) => {
    const wallets = await db.getWallets()
    const result = await Promise.all(wallets.map(async w => ({
      address: w.address,
      label: w.label,
      added_at: w.addedAt,
      holdings: (await db.getWalletHoldings(w.address)).map((h: any) => ({
        mint: h.mint,
        amount: h.amount,
        symbol: h.symbol,
        name: h.name,
        price_usd: h.priceUsd,
        market_cap: h.marketCap,
      })),
    })))
    res.json(result)
  })

  // ── POST /api/wallets ─────────────────────────────────────────────────────
  app.post('/api/wallets', async (req: Request, res: Response) => {
    const { label, address } = req.body as { label?: string; address?: string }

    if (!label || !address) {
      res.status(400).json({ error: 'label and address are required' })
      return
    }

    const ownerName = label.toLowerCase().trim()
    const owner = config.telegram.users.find(u => u.name.toLowerCase() === ownerName)
    if (!owner) {
      const known = config.telegram.users.map(u => u.name).join(', ') || 'none configured'
      res.status(400).json({ error: `Unknown owner "${label}". Configured users: ${known}` })
      return
    }

    const added = await db.addWallet(address.trim(), ownerName, owner.chatId)
    if (!added) {
      res.status(409).json({ error: 'Wallet already tracked' })
      return
    }

    // Sync Helius webhook to include the new address
    syncWebhook().catch(err => console.error('[Server] Webhook sync error:', err))

    // Immediately poll the new wallet so holdings appear right away
    walletPoller.refreshWallet(address.trim(), ownerName).catch(err =>
      console.error('[Server] Initial wallet poll error:', err)
    )

    res.status(201).json({ ok: true, address: address.trim(), label: ownerName })
  })

  // ── POST /api/wallets/:address/refresh ───────────────────────────────────
  app.post('/api/wallets/:address/refresh', async (req: Request, res: Response) => {
    const wallet = await db.getWallet(req.params.address)
    if (!wallet) {
      res.status(404).json({ error: 'Wallet not found' })
      return
    }
    res.json({ ok: true, message: 'Rescan started' })
    walletPoller.refreshWallet(wallet.address, wallet.label).catch(err =>
      console.error('[Server] Wallet rescan error:', err)
    )
  })

  // ── DELETE /api/wallets/:address ──────────────────────────────────────────
  app.delete('/api/wallets/:address', async (req: Request, res: Response) => {
    const removed = await db.removeWallet(req.params.address)
    if (!removed) {
      res.status(404).json({ error: 'Wallet not found' })
      return
    }

    // Sync Helius webhook to remove the address
    syncWebhook().catch(err => console.error('[Server] Webhook sync error:', err))

    res.json({ ok: true })
  })

  // ── GET /api/alerts ───────────────────────────────────────────────────────
  app.get('/api/alerts', async (_req: Request, res: Response) => {
    res.json(await db.getRecentAlerts(50))
  })

  // ── GET /api/og-radar ─────────────────────────────────────────────────────
  app.get('/api/og-radar', async (_req: Request, res: Response) => {
    res.json(await db.getOgRadarHits(50))
  })

  // ── GET /api/movers ───────────────────────────────────────────────────────
  // Rug detection thresholds
  const RUG_TOP10_THRESHOLD = 90   // top10Holders > 90% = whale concentration
  const RUG_MIN_TXNS        = 10   // txns24h < 10 = almost no real trading (DexScreener only)
  const RUG_MIN_VOLUME      = 100  // volume24h < $100 = micro volume (DexScreener only)

  app.get('/api/movers', (req: Request, res: Response) => {
    const filter = req.query.filter as string | undefined
    const status = moversPoller.getStatus()
    const allMovers = moversPoller.getMovers()

    const cookieOk = axiomPoller ? axiomPoller.isCookieOk() : null

    // Enrich with Axiom data + compute isRug flag
    const enriched = allMovers.map(m => {
      const axiom = axiomPoller?.getMoverAxiomData(m.mint) ?? null
      const isRug =
        (axiom !== null && axiom.top10Holders > RUG_TOP10_THRESHOLD) ||
        (m.txns24h !== null && m.txns24h < RUG_MIN_TXNS) ||
        (m.volume24h !== null && m.volume24h < RUG_MIN_VOLUME)
      return {
        ...m,
        axiom_user_count: axiom?.userCount ?? null,
        axiom_top10:      axiom?.top10Holders ?? null,
        axiom_lp_burned:  axiom?.lpBurned ?? null,
        isRug,
      }
    })

    let movers = enriched
    if (filter === 'dormant') movers = enriched.filter(m => m.isDormant && !m.isRug)
    else if (filter === 'gainers') movers = enriched.filter(m => (m.change1h ?? 0) > 0 && !m.isRug)
    else if (filter === 'rugs') movers = enriched.filter(m => m.isRug)
    else movers = enriched.filter(m => !m.isRug)  // default: hide rugs

    // Default sort: biggest absolute 1h move first
    movers.sort((a, b) => {
      const aScore = Math.abs(a.change1h ?? a.change24h ?? 0)
      const bScore = Math.abs(b.change1h ?? b.change24h ?? 0)
      return bScore - aScore
    })

    res.json({
      movers,
      axiom_cookie_ok: cookieOk,
      lastPollAt: status.lastPollAt,
      lastError: status.lastError,
    })
  })

  // ── GET /api/target-zone ─────────────────────────────────────────────────
  // Returns pump.fun coins >= 30 days old with MC in the $8K-$14K range.
  // These are "sleeping" coins with remaining holders — good pre-pump watchlist.
  app.get('/api/target-zone', (req: Request, res: Response) => {
    const status = moversPoller.getStatus()
    const coins  = moversPoller.getTargetZone()

    // Sort by holder count desc by default (most holders = most likely to react)
    const sortBy = (req.query.sort as string) ?? 'holders'
    const sortDir = req.query.dir === 'asc' ? 1 : -1

    const sorted = [...coins].sort((a, b) => {
      let aVal: number, bVal: number
      switch (sortBy) {
        case 'mc':        aVal = a.marketCap;            bVal = b.marketCap;            break
        case 'age':       aVal = a.ageHours;             bVal = b.ageHours;             break
        case 'volume':    aVal = a.volume24h ?? 0;       bVal = b.volume24h ?? 0;       break
        case 'txns':      aVal = a.txns24h ?? 0;         bVal = b.txns24h ?? 0;         break
        case 'change1h':  aVal = a.change1h ?? 0;        bVal = b.change1h ?? 0;        break
        case 'change24h': aVal = a.change24h ?? 0;       bVal = b.change24h ?? 0;       break
        case 'traded':    aVal = a.lastTradeAt;          bVal = b.lastTradeAt;          break
        case 'holders':
        default:          aVal = a.holderCount ?? 0;     bVal = b.holderCount ?? 0;     break
      }
      return (bVal - aVal) * sortDir
    })

    res.json({
      coins: sorted,
      count: sorted.length,
      lastPollAt: status.lastPollAt,
    })
  })

  // ── GET /api/debug/axiom?mint=XXX ─────────────────────────────────────────
  // Tests the Axiom pair-info call for a given mint. Returns raw response +
  // which pair address was used. Useful for diagnosing viewer count issues.
  app.get('/api/debug/axiom', async (req: Request, res: Response) => {
    if (!axiomPoller) {
      res.status(503).json({ error: 'Axiom poller not running (no AXIOM_COOKIE set)' })
      return
    }
    const mint = req.query.mint as string | undefined
    if (!mint || mint.length < 32) {
      res.status(400).json({ error: 'Pass ?mint=<solana_mint_address>' })
      return
    }
    // Find the mover to get its pair address (Raydium pool for graduated tokens)
    const mover = moversPoller.getMovers().find(m => m.mint === mint)
    const pairAddress = mover?.pairAddress ?? null

    const result = await axiomPoller.debugFetchPairInfo(mint, pairAddress ?? undefined)
    res.json({ mint, cookieOk: axiomPoller.isCookieOk(), dexscreenerPairAddress: pairAddress, ...result })
  })

  // ── GET /api/dormant-history?hours=24 ────────────────────────────────────
  app.get('/api/dormant-history', async (req: Request, res: Response) => {
    const hours = Math.min(Number(req.query.hours ?? 24), 168) // cap at 7 days
    const wakeups = await db.getDormantWakeups(hours)
    res.json({ wakeups, hours })
  })

  // ── GET /api/users ────────────────────────────────────────────────────────
  app.get('/api/users', (_req: Request, res: Response) => {
    res.json(config.telegram.users.map(u => u.name))
  })

  // ── GET /api/api-status ───────────────────────────────────────────────────
  // Returns live health of every external API (cached 5 min). No slow startup.
  app.get('/api/api-status', async (_req: Request, res: Response) => {
    const checks = await getApiStatusCached()
    res.json({ checks, cachedAt: new Date(_apiStatusTs).toISOString() })
  })

  // Warm the cache in background so first dashboard load is instant
  setTimeout(() => refreshApiStatus().catch(() => {}), 3_000)
  setInterval(() => refreshApiStatus().catch(() => {}), API_STATUS_TTL)

  app.listen(config.port, () => {
    console.log(`[Server] Listening on port ${config.port}`)
    if (config.appUrl) {
      console.log(`[Server] Dashboard: ${config.appUrl}`)
      console.log(`[Server] Webhook:   ${config.appUrl}/api/webhook/helius`)
    } else {
      console.log(`[Server] Dashboard: http://localhost:${config.port}`)
    }
  })
}
