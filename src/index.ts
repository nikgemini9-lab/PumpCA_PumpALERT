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
import { initDatabase, getActiveTokens } from './database'
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

  // 5. Alert manager
  const alertManager = new AlertManager(bot)

  // 6. Wallet holdings poller
  const walletPoller = new WalletPoller(monitor)

  // 7. OG Hunter Radar
  const ogRadar = new OgHunterRadar(bot)

  // 8. OG MC Tracker (milestone alerts: 2x/3x/5x/10x after radar fires)
  const ogMcTracker = new OgMcTracker(bot)

  // 9. Movers poller
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

  // Wire OG radar to movers graduation events
  moversPoller.on('graduated', (mint: string, name: string, symbol: string, mc: number) => {
    ogRadar.handleMoversEntry(mint, name, symbol, mc)
  })

  // Wire dormant coin Telegram alerts
  moversPoller.on('dormant', (mover: MoverEntry) => {
    const chatIds = config.telegram.users.map(u => u.chatId).filter(Boolean)
    const ageDays = Math.floor(mover.ageHours / 24)
    const ageStr  = ageDays >= 365 ? `${Math.floor(ageDays / 365)}y ${ageDays % 365}d`
                  : ageDays >= 30  ? `${Math.floor(ageDays / 30)}mo`
                  : `${ageDays}d`

    const fmtPct = (n: number | null) => n != null ? `${n > 0 ? '+' : ''}${n.toFixed(1)}%` : '—'
    const mcStr  = mover.marketCap >= 1e6 ? `$${(mover.marketCap / 1e6).toFixed(2)}M`
                 : mover.marketCap >= 1e3 ? `$${(mover.marketCap / 1e3).toFixed(1)}K`
                 : `$${mover.marketCap.toFixed(0)}`
    const lastTraded = Math.floor((Date.now() - mover.lastTradeAt) / 60_000)
    const lastStr = lastTraded < 60 ? `${lastTraded}m ago` : `${Math.floor(lastTraded / 60)}h ago`

    const text = [
      `👴 <b>DORMANT COIN WOKE UP!</b>`,
      ``,
      `<b>${mover.name}</b>  $${mover.symbol}`,
      `<code>${mover.mint}</code>`,
      ``,
      `⏳ Age: <b>${ageStr}</b>`,
      `💎 MC: <b>${mcStr}</b>`,
      `📈 1H: <b>${fmtPct(mover.change1h)}</b>  |  24H: <b>${fmtPct(mover.change24h)}</b>`,
      `⏱ Last traded: <b>${lastStr}</b>`,
      ``,
      `⚡ Old coin suddenly moving — possible OG situation.`,
      `Check OG Hunter Radar for related new coins.`,
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
  })

  // Start pollers
  poller.start()
  walletPoller.start()
  moversPoller.start()
  ogMcTracker.start()

  // Start HTTP server + dashboard
  startServer(getStatus, monitor, walletPoller, moversPoller)

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
  process.on('SIGTERM', () => gracefulShutdown(monitor, poller, walletPoller, moversPoller, ogMcTracker, bot))
  process.on('SIGINT', () => gracefulShutdown(monitor, poller, walletPoller, moversPoller, ogMcTracker, bot))
}

async function gracefulShutdown(
  monitor: SolanaMonitor,
  poller: DexScreenerPoller,
  walletPoller: WalletPoller,
  moversPoller: MoversPoller,
  ogMcTracker: OgMcTracker,
  bot: TelegramBot
): Promise<void> {
  console.log('\n[Shutdown] Stopping services...')
  poller.stop()
  walletPoller.stop()
  moversPoller.stop()
  ogMcTracker.stop()
  await monitor.stop()
  bot.stopPolling()
  console.log('[Shutdown] Done.')
  process.exit(0)
}

main().catch(err => {
  console.error('[Fatal]', err)
  process.exit(1)
})
