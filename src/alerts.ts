/**
 * Alert manager
 *
 * Receives buy events from two sources:
 *   1. SolanaMonitor  — on-chain bonding curve changes (real-time, pre-graduation)
 *   2. DexScreenerPoller — market data (post-graduation + richer data)
 *
 * Applies cooldown logic so you don't get spammed.
 * Formats and sends Telegram messages.
 */

import TelegramBot from 'node-telegram-bot-api'
import { config } from './config'
import * as db from './database'
import { OnChainBuyEvent, DexScreenerPair, AlertData } from './types'

export class AlertManager {
  private bot: TelegramBot
  // Rolling buy history per mint: timestamps of on-chain buy events
  private buyWindow: Map<string, number[]> = new Map()

  constructor(bot: TelegramBot) {
    this.bot = bot
  }

  // ── On-chain buy (from SolanaMonitor) ─────────────────────────────────────

  handleOnChainBuy(event: OnChainBuyEvent): void {
    const { mint, solAmount, priceChangePct: pctChange } = event

    // Add to rolling buy window
    const now = Date.now()
    const windowMs = config.alerts.buyCountWindowMinutes * 60_000
    const history = (this.buyWindow.get(mint) ?? []).filter(t => now - t < windowMs)
    history.push(now)
    this.buyWindow.set(mint, history)

    const buyCount = history.length
    const exceedsBuyThreshold = buyCount >= config.alerts.buyCountThreshold
    const exceedsPriceThreshold = pctChange >= config.alerts.priceChangePercent

    if ((exceedsBuyThreshold || exceedsPriceThreshold) && !this.isOnCooldown(mint)) {
      const token = db.getToken(mint)
      this.sendAlert({
        mint,
        name: token?.name ?? 'Unknown',
        symbol: token?.symbol ?? '?',
        buyCount,
        priceChangePct: pctChange,
        solAmount,
        priceUsd: token?.priceUsd ?? undefined,
        marketCapUsd: token?.marketCap ?? undefined,
        source: 'onchain',
      })
    }
  }

  // ── DexScreener update (from DexScreenerPoller) ───────────────────────────

  handleDexScreenerData(mint: string, pair: DexScreenerPair): void {
    const priceChangePct = pair.priceChange?.m5 ?? 0
    const buysM5 = pair.txns?.m5?.buys ?? 0

    const exceedsBuyThreshold = buysM5 >= config.alerts.buyCountThreshold
    const exceedsPriceThreshold = priceChangePct >= config.alerts.priceChangePercent

    if ((exceedsBuyThreshold || exceedsPriceThreshold) && !this.isOnCooldown(mint)) {
      this.sendAlert({
        mint,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        buyCount: buysM5,
        priceChangePct,
        volumeUsd: pair.volume?.m5,
        marketCapUsd: pair.fdv ?? pair.marketCap,
        priceUsd: pair.priceUsd,
        source: 'dexscreener',
      })
    }
  }

  // ── Core send ─────────────────────────────────────────────────────────────

  private sendAlert(data: AlertData): void {
    if (!config.telegram.chatId) {
      console.warn('[Alert] TELEGRAM_CHAT_ID not set, skipping alert.')
      return
    }

    db.recordAlert(data.mint, 'pump')

    const message = formatMessage(data, config.alerts)

    this.bot
      .sendMessage(config.telegram.chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      })
      .then(() => {
        console.log(`[Alert] Sent pump alert for ${data.symbol} (${data.mint.slice(0, 8)}...)`)
      })
      .catch(err => {
        console.error('[Alert] Failed to send Telegram message:', err?.message)
      })
  }

  private isOnCooldown(mint: string): boolean {
    const lastAlert = db.getLastAlertTime(mint)
    if (!lastAlert) return false
    return Date.now() - lastAlert < config.alerts.cooldownMinutes * 60_000
  }

  // Send a plain info message (used by bot commands, errors, etc.)
  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  }
}

function formatMessage(
  data: AlertData,
  alertConfig: typeof config.alerts
): string {
  const lines: string[] = [
    `🚀 <b>PUMP ALERT!</b>`,
    ``,
    `<b>${escapeHtml(data.name)}</b>  $${escapeHtml(data.symbol)}`,
    `<code>${data.mint}</code>`,
    ``,
  ]

  if (data.priceChangePct && data.priceChangePct > 0) {
    lines.push(`📈 Price  <b>+${data.priceChangePct.toFixed(1)}%</b> in 5 min`)
  }

  if (data.buyCount) {
    lines.push(
      `🛒 Buys   <b>${data.buyCount}</b> in ${alertConfig.buyCountWindowMinutes} min`
    )
  }

  if (data.solAmount) {
    lines.push(`💰 Size   <b>${data.solAmount.toFixed(3)} SOL</b>`)
  }

  if (data.volumeUsd) {
    lines.push(`📊 Vol    <b>$${fmtNum(data.volumeUsd)}</b> (5m)`)
  }

  if (data.priceUsd) {
    lines.push(`💲 Price  <b>$${data.priceUsd}</b>`)
  }

  if (data.marketCapUsd) {
    lines.push(`💎 MC     <b>$${fmtNum(data.marketCapUsd)}</b>`)
  }

  const src = data.source === 'onchain' ? '⛓ on-chain' : '📡 DexScreener'
  lines.push(``, `Source: ${src}`)

  lines.push(
    ``,
    [
      `<a href="https://axiom.trade/t/${data.mint}">📊 Axiom</a>`,
      `<a href="https://dexscreener.com/solana/${data.mint}">📈 DexScr</a>`,
      `<a href="https://pump.fun/${data.mint}">🎱 pump.fun</a>`,
    ].join('  |  ')
  )

  return lines.join('\n')
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(2)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
