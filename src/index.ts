/**
 * PumpAlert — main entry point
 *
 * Starts:
 *   1. Turso (persistent cloud SQLite) or local SQLite
 *   2. Telegram bot (polling mode)
 *   3. Solana WebSocket monitor (bonding curves)
 *   4. DexScreener poller
 *   5. Wallet holdings poller (Nik + Josh wallets)
 *   6. Express HTTP server (dashboard + REST API)
 *   7. Keep-alive self-ping (prevents Render free tier from sleeping)
 */

import axios from 'axios'
import TelegramBot from 'node-telegram-bot-api'
import { config } from './config'
import { initDatabase, getActiveTokens, getOgRadarHits, addDormantWakeup, getDormantWakeups, updateDormantWakeupAth } from './database'
import { SolanaMonitor } from './monitor'
import { DexScreenerPoller } from './poller'
import { AlertManager } from './alerts'
import { WalletPoller } from './walletPoller'
import { setupBot } from './bot'
import { startServer } from './server'
import { syncWebhook } from './heliusWebhook'
import { OgHunterRadar } from './ogRadar'
import { OgMcTracker } from './ogMcTracker'
import { MoversPoller, MoverEntry } from './movers'
import { AxiomPoller } from './axiomPoller'
import { MonitorStatus } from './types'

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  PumpAlert — pump.fun CA tracker')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // 1. Database (Turso cloud or local SQLite)
  await initDatabase()

  // 2. Telegram bot
  const bot = new TelegramBot(config.telegram.botToken, { polling: true })
  // 409 = another instance still shutting down during redeploy — suppress the noise
  bot.on('polling_error', (err: any) => {
    if (err?.code === 'ETELEGRAM' && String(err?.message).includes('409')) {
      console.warn('[Bot] Polling conflict (409) — previous instance still stopping, will recover')
      return
    }
    console.error('[Bot] Polling error:', err?.message ?? err)
  })
  console.log('[Bot] Telegram bot started (polling)')

  // 3. Solana monitor
  const monitor = new SolanaMonitor()

  // 4. DexScreener poller
  const poller = new DexScreenerPoller()

  // 5. Axiom viewer count poller (created before AlertManager so it can be injected)
  const axiomPoller = new AxiomPoller()

  // 6. Alert manager
  const alertManager = new AlertManager(bot, axiomPoller)

  // 7. Wallet holdings poller
  const walletPoller = new WalletPoller(monitor)

  // 8. OG Hunter Radar
  const ogRadar = new OgHunterRadar(bot)

  // 9. OG MC Tracker (milestone alerts: 2x/3x/5x/10x after radar fires)
  const ogMcTracker = new OgMcTracker(bot)

  // 10. Movers poller
  const moversPoller = new MoversPoller()

  // Wire up events
  monitor.on('buy', event => {
    alertManager.handleOnChainBuy(event)
  })

  poller.on('data', (mint: string, pair: any) => {
    alertManager.handleDexScreenerData(mint, pair)
    ogRadar.handleDexData(mint, pair)
  })

  poller.on('social', (mint: string, handle: string, followers: number, delta: number, deltaPct: number) => {
    alertManager.handleFollowerSpike(mint, handle, followers, delta, deltaPct)
  })

  axiomPoller.on('viewers', (mint: string, userCount: number) => {
    alertManager.handleViewerCount(mint, userCount)
  })

  // Status helper (async — queries DB for live token count)
  const startedAt = Date.now()
  const getStatus = async (): Promise<MonitorStatus> => ({
    trackedTokens: (await getActiveTokens()).length,
    onchainSubscriptions: monitor.getSubscriptionCount(),
    lastPollAt: poller.getLastPollAt(),
    uptime: Date.now() - startedAt,
    startedAt,
  })

  // Setup bot commands
  setupBot(bot, monitor, getStatus)

  // Subscribe to all existing tokens in DB
  const existingTokens = await getActiveTokens()
  if (existingTokens.length > 0) {
    console.log(`[Init] Subscribing to ${existingTokens.length} existing tokens...`)
    await monitor.subscribeAll(existingTokens.map(t => t.mint))
  } else {
    console.log('[Init] No tokens tracked yet. Use /add <CA> in Telegram or the dashboard.')
  }

  // Wire AxiomPoller movers source (lets it fetch viewer counts for all movers)
  axiomPoller.setMoversSource(() => moversPoller.getMovers())

  // Wire OG radar to movers graduation events
  moversPoller.on('graduated', (mint: string, name: string, symbol: string, mc: number) => {
    ogRadar.handleMoversEntry(mint, name, symbol, mc)
  })

  // Wire dormant coin Telegram alerts
  moversPoller.on('dormant', (mover: MoverEntry) => {
    const chatIds = config.telegram.users.map(u => u.chatId).filter(Boolean)
    if (chatIds.length === 0) return

    ;(async () => {
      const ageDays = Math.floor(mover.ageHours / 24)
      const ageStr  = ageDays >= 365 ? `${Math.floor(ageDays / 365)}y ${ageDays % 365}d`
                    : ageDays >= 30  ? `${Math.floor(ageDays / 30)}mo`
                    : `${ageDays}d`

      const fmtPct = (n: number | null) => n != null ? `${n > 0 ? '+' : ''}${n.toFixed(1)}%` : '—'
      const fmtMc  = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M`
                   : n >= 1e3   ? `$${(n / 1e3).toFixed(1)}K`
                   : `$${n.toFixed(0)}`
      const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

      const lastTraded = Math.floor((Date.now() - mover.lastTradeAt) / 60_000)
      const lastStr = lastTraded < 60 ? `${lastTraded}m ago` : `${Math.floor(lastTraded / 60)}h ago`

      // Check for a recent runner that caused this dormant coin to move (OG radar hits, last 6h)
      let runnerLine = ''
      let runnerHit: { migratedMint: string; migratedName: string } | null = null
      try {
        const SIX_HOURS = 6 * 60 * 60_000
        const ogHits = await getOgRadarHits(50)
        const hit = ogHits.find(h => h.ogMint === mover.mint && Date.now() - h.detectedAt < SIX_HOURS)
        if (hit) {
          runnerHit = { migratedMint: hit.migratedMint, migratedName: hit.migratedName }
          // Prefer live MC from movers if the runner is still in the list
          const runnerMover = moversPoller.getMovers().find(r => r.mint === hit.migratedMint)
          const runnerMc = runnerMover?.marketCap ?? hit.migratedMc
          const gapRatio = runnerMc > 0 && mover.marketCap > 0 ? Math.round(runnerMc / mover.marketCap) : null
          const gapStr = gapRatio ? ` (${gapRatio}x OG MC)` : ''
          runnerLine = `\n🏃 Runner: <b>${escHtml(hit.migratedName)}</b> @ <b>${fmtMc(runnerMc)}</b>${gapStr}`
        }
      } catch { /* non-fatal — proceed without runner line */ }

      // Fetch Axiom viewer count
      let viewerLine = ''
      try {
        const viewerCount = await axiomPoller.fetchViewerCount(mover.mint)
        if (viewerCount != null && viewerCount > 0) {
          viewerLine = `\n👀 Axiom:  <b>${viewerCount} watching</b>`
        }
      } catch { /* non-fatal */ }

      // Persist wakeup to DB for 24h history view in dashboard
      addDormantWakeup({
        mint:       mover.mint,
        name:       mover.name,
        symbol:     mover.symbol,
        marketCap:  mover.marketCap,
        ageHours:   mover.ageHours,
        change1h:   mover.change1h,
        change6h:   mover.change6h,
        change24h:  mover.change24h,
        floorMc:    mover.dormantFloorMc ?? null,
        runnerMint: runnerHit?.migratedMint ?? null,
        runnerName: runnerHit?.migratedName ?? null,
      }).catch(err => console.error('[Movers] Failed to persist dormant wakeup:', err))

      const contextLine = runnerLine
        ? `⚡ OG pumping — runner detected above.`
        : `⚡ Old coin suddenly moving — possible OG situation.`

      const text = [
        `👴 <b>DORMANT COIN WOKE UP!</b>`,
        ``,
        `<b>${escHtml(mover.name)}</b>  $${escHtml(mover.symbol)}`,
        `<code>${mover.mint}</code>`,
        ``,
        `⏳ Age: <b>${ageStr}</b>`,
        `💎 MC: <b>${fmtMc(mover.marketCap)}</b>${mover.dormantFloorMc ? `  (floor <b>${fmtMc(mover.dormantFloorMc)}</b>)` : ''}`,
        `📈 1H: <b>${fmtPct(mover.change1h)}</b>  |  24H: <b>${fmtPct(mover.change24h)}</b>`,
        `⏱ Last traded: <b>${lastStr}</b>${viewerLine}${runnerLine}`,
        ``,
        contextLine,
        ``,
        [
          `<a href="https://axiom.trade/t/${mover.mint}">📊 Axiom</a>`,
          `<a href="https://dexscreener.com/solana/${mover.mint}">📈 DexScr</a>`,
          `<a href="https://pump.fun/${mover.mint}">🎱 pump.fun</a>`,
        ].join('  |  '),
      ].join('\n')

      for (const chatId of chatIds) {
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true })
          .catch(err => console.error('[Movers] Telegram error:', err?.message))
      }
    })().catch(err => console.error('[Movers] Dormant alert error:', err))
  })

  // Start pollers
  poller.start()
  walletPoller.start()
  moversPoller.start()
  ogMcTracker.start()
  axiomPoller.start()

  // Periodic ATH updater for dormant wakeups — every 2 minutes
  // Checks live MC from movers cache / watchlist / DexScreener and updates ath_mc if price peaked higher
  setInterval(async () => {
    try {
      const wakeups = await getDormantWakeups(168) // last 7 days
      if (wakeups.length === 0) return
      const movers = moversPoller.getMovers()
      const watchlist = await getActiveTokens()

      // Mints not covered by movers cache or watchlist → fetch fresh from DexScreener
      const moverMints = new Set(movers.map(m => m.mint))
      const watchMints = new Set(watchlist.map(t => t.mint))
      const missingMints = [...new Set(wakeups.map(w => w.mint))]
        .filter(mint => !moverMints.has(mint) && !watchMints.has(mint))

      const dexMcMap = new Map<string, number>()
      if (missingMints.length > 0) {
        try {
          const BATCH = 30
          for (let i = 0; i < missingMints.length; i += BATCH) {
            const batch = missingMints.slice(i, i + BATCH)
            const res = await axios.get(
              `https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`,
              { timeout: 10_000, headers: { 'User-Agent': 'PumpAlert/1.0' } }
            )
            for (const pair of (res.data?.pairs ?? []) as any[]) {
              if (pair.chainId !== 'solana' || !pair.baseToken?.address || !pair.fdv) continue
              const addr = pair.baseToken.address as string
              const prev = dexMcMap.get(addr) ?? 0
              if (pair.fdv > prev) dexMcMap.set(addr, pair.fdv)
            }
          }
        } catch { /* non-fatal, best-effort */ }
      }

      for (const w of wakeups) {
        const mover = movers.find(m => m.mint === w.mint)
        let currentMc: number | null = mover?.marketCap ?? null
        if (currentMc == null) {
          const tok = watchlist.find(t => t.mint === w.mint)
          if (tok?.marketCap) currentMc = tok.marketCap
        }
        if (currentMc == null) currentMc = dexMcMap.get(w.mint) ?? null
        if (currentMc == null) continue
        const storedAth = w.athMc ?? w.marketCap
        if (currentMc > storedAth) {
          await updateDormantWakeupAth(w.id, currentMc, Date.now())
        }
      }
    } catch (err) {
      console.error('[AthUpdater] Error updating dormant wakeup ATH:', err)
    }
  }, 2 * 60_000)

  // Start HTTP server + dashboard
  startServer(getStatus, monitor, walletPoller, moversPoller, axiomPoller)

  // Register / update Helius webhook (async, non-blocking)
  syncWebhook().catch(err => console.error('[Init] Webhook sync error:', err))

  // Keep-alive: self-ping /health every 13 min so Render free tier never sleeps.
  // Pair with a free UptimeRobot monitor (https://uptimerobot.com) for external pings.
  if (config.appUrl) {
    setInterval(async () => {
      try {
        await axios.get(`${config.appUrl}/health`, { timeout: 5_000 })
        console.log('[KeepAlive] Pinged /health — service staying awake')
      } catch (err: any) {
        console.warn('[KeepAlive] Self-ping failed:', err?.message)
      }
    }, 13 * 60_000)
    console.log('[KeepAlive] Self-ping enabled every 13 min (prevents Render sleep)')
  }

  console.log(
    `[Config] Thresholds — price: +${config.alerts.priceChangePercent}%` +
      ` | buys: ${config.alerts.buyCountThreshold} in ${config.alerts.buyCountWindowMinutes}min` +
      ` | cooldown: ${config.alerts.cooldownMinutes}min`
  )

  const userList = config.telegram.users.map(u => u.name).join(', ') || 'none'
  console.log(`[Config] Authorized users: ${userList}`)

  if (config.telegram.users.length === 0) {
    console.warn(
      '[Warn] No users configured! Set NIK_CHAT_ID and/or JOSH_CHAT_ID in your environment.\n' +
      '       Send /start to the bot to get your chat ID.'
    )
  }

  if (!config.dashboard.secret) {
    console.warn('[Warn] DASHBOARD_SECRET not set — dashboard is publicly accessible!')
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  All systems running. Watching for pumps...')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // Graceful shutdown
  process.on('SIGTERM', () => gracefulShutdown(monitor, poller, walletPoller, moversPoller, ogMcTracker, axiomPoller, bot))
  process.on('SIGINT', () => gracefulShutdown(monitor, poller, walletPoller, moversPoller, ogMcTracker, axiomPoller, bot))
}

async function gracefulShutdown(
  monitor: SolanaMonitor,
  poller: DexScreenerPoller,
  walletPoller: WalletPoller,
  moversPoller: MoversPoller,
  ogMcTracker: OgMcTracker,
  axiomPoller: AxiomPoller,
  bot: TelegramBot
): Promise<void> {
  console.log('\n[Shutdown] Stopping services...')
  poller.stop()
  walletPoller.stop()
  moversPoller.stop()
  ogMcTracker.stop()
  axiomPoller.stop()
  await monitor.stop()
  bot.stopPolling()
  console.log('[Shutdown] Done.')
  process.exit(0)
}

main().catch(err => {
  console.error('[Fatal]', err)
  process.exit(1)
})
