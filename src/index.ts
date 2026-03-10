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
import { MonitorStatus } from './types'

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  PumpAlert — pump.fun CA tracker')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // 1. Database (Turso cloud or local SQLite)
  await initDatabase()

  // 2. Telegram bot
  const bot = new TelegramBot(config.telegram.botToken, { polling: true })
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

  // Start pollers
  poller.start()
  walletPoller.start()

  // Start HTTP server + dashboard
  startServer(getStatus, monitor, walletPoller)

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
  process.on('SIGTERM', () => gracefulShutdown(monitor, poller, walletPoller, bot))
  process.on('SIGINT', () => gracefulShutdown(monitor, poller, walletPoller, bot))
}

async function gracefulShutdown(
  monitor: SolanaMonitor,
  poller: DexScreenerPoller,
  walletPoller: WalletPoller,
  bot: TelegramBot
): Promise<void> {
  console.log('\n[Shutdown] Stopping services...')
  poller.stop()
  walletPoller.stop()
  await monitor.stop()
  bot.stopPolling()
  console.log('[Shutdown] Done.')
  process.exit(0)
}

main().catch(err => {
  console.error('[Fatal]', err)
  process.exit(1)
})
