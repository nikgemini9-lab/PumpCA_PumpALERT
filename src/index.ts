/**
 * PumpAlert — main entry point
 *
 * Starts:
 *   1. SQLite database
 *   2. Telegram bot (polling mode)
 *   3. Solana WebSocket monitor (bonding curves)
 *   4. DexScreener poller
 *   5. Express HTTP server (health check)
 */

import TelegramBot from 'node-telegram-bot-api'
import { config } from './config'
import { initDatabase, getActiveTokens } from './database'
import { SolanaMonitor } from './monitor'
import { DexScreenerPoller } from './poller'
import { AlertManager } from './alerts'
import { setupBot } from './bot'
import { startServer } from './server'
import { MonitorStatus } from './types'

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  PumpAlert — pump.fun CA tracker')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // 1. Database
  initDatabase()

  // 2. Telegram bot
  const bot = new TelegramBot(config.telegram.botToken, { polling: true })
  console.log('[Bot] Telegram bot started (polling)')

  // 3. Solana monitor
  const monitor = new SolanaMonitor()

  // 4. DexScreener poller
  const poller = new DexScreenerPoller()

  // 5. Alert manager
  const alertManager = new AlertManager(bot)

  // Wire up events
  monitor.on('buy', event => {
    alertManager.handleOnChainBuy(event)
  })

  poller.on('data', (mint: string, pair: any) => {
    alertManager.handleDexScreenerData(mint, pair)
  })

  // Status helper
  const startedAt = Date.now()
  const getStatus = (): MonitorStatus => ({
    trackedTokens: getActiveTokens().length,
    onchainSubscriptions: monitor.getSubscriptionCount(),
    lastPollAt: poller.getLastPollAt(),
    uptime: Date.now() - startedAt,
    startedAt,
  })

  // Setup bot commands
  setupBot(bot, monitor, getStatus)

  // Subscribe to all existing tokens in DB
  const existingTokens = getActiveTokens()
  if (existingTokens.length > 0) {
    console.log(`[Init] Subscribing to ${existingTokens.length} existing tokens...`)
    await monitor.subscribeAll(existingTokens.map(t => t.mint))
  } else {
    console.log('[Init] No tokens tracked yet. Send /add <CA> to your Telegram bot.')
  }

  // Start poller
  poller.start()

  // Start HTTP server
  startServer(getStatus)

  // Print thresholds
  console.log(
    `[Config] Thresholds — price: +${config.alerts.priceChangePercent}%` +
      ` | buys: ${config.alerts.buyCountThreshold} in ${config.alerts.buyCountWindowMinutes}min` +
      ` | cooldown: ${config.alerts.cooldownMinutes}min`
  )

  if (!config.telegram.chatId) {
    console.warn(
      '[Warn] TELEGRAM_CHAT_ID not set! Send /start to your bot to get your chat ID, then set it.'
    )
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  All systems running. Watching for pumps...')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // Graceful shutdown
  process.on('SIGTERM', () => gracefulShutdown(monitor, poller, bot))
  process.on('SIGINT', () => gracefulShutdown(monitor, poller, bot))
}

async function gracefulShutdown(
  monitor: SolanaMonitor,
  poller: DexScreenerPoller,
  bot: TelegramBot
): Promise<void> {
  console.log('\n[Shutdown] Stopping services...')
  poller.stop()
  await monitor.stop()
  bot.stopPolling()
  console.log('[Shutdown] Done.')
  process.exit(0)
}

main().catch(err => {
  console.error('[Fatal]', err)
  process.exit(1)
})
