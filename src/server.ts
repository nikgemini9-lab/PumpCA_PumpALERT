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
 *
 * Webhook (no auth check — Helius uses its own authHeader mechanism):
 *   POST /api/webhook/helius      — receives Helius enhanced transaction events
 */

import express, { Request, Response, NextFunction } from 'express'
import path from 'path'
import { config } from './config'
import * as db from './database'
import { MonitorStatus } from './types'
import { SolanaMonitor } from './monitor'
import { WalletPoller, SKIP_MINTS } from './walletPoller'
import { syncWebhook, parseWebhookTransfers } from './heliusWebhook'
import { MoversPoller } from './movers'
import type { AxiomPoller } from './axiomPoller'

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

  // ── GET /api/meta ─────────────────────────────────────────────────────────
  app.get('/api/meta', (_req: Request, res: Response) => {
    res.json(moversPoller.getMetaAnalysis())
  })

  // ── GET /api/users ────────────────────────────────────────────────────────
  app.get('/api/users', (_req: Request, res: Response) => {
    res.json(config.telegram.users.map(u => u.name))
  })

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
