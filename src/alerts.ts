/**
 * Alert manager
 *
 * Receives buy events from two sources:
 *   1. SolanaMonitor  — on-chain bonding curve changes (real-time, pre-graduation)
 *   2. DexScreenerPoller — market data (post-graduation + richer data)
 *
 * Alert routing:
 *   - Tokens added manually (source='manual') → alert ALL configured users
 *   - Tokens auto-added from a wallet scan (source='wallet') → alert only that wallet's owner
 *     PLUS a note is added for all users if someone they know holds it
 */

import TelegramBot from 'node-telegram-bot-api'
import { config } from './config'
import * as db from './database'
import { OnChainBuyEvent, DexScreenerPair, AlertData } from './types'

export class AlertManager {
  private bot: TelegramBot
  // Rolling buy history per mint: timestamps of on-chain buy events
  private buyWindow: Map<string, number[]> = new Map()
  // Price at the time each alert last fired — used for re-alert gating
  private priceAtLastAlert: Map<string, number> = new Map()
  // Hard minimum gap between any two alerts for the same token (anti-burst)
  private readonly MIN_ALERT_GAP_MS = 2 * 60_000

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
    const currentPrice = pair.priceUsd ? parseFloat(pair.priceUsd) : undefined

    const exceedsBuyThreshold = buysM5 >= config.alerts.buyCountThreshold
    const exceedsPriceThreshold = priceChangePct >= config.alerts.priceChangePercent

    if ((exceedsBuyThreshold || exceedsPriceThreshold) && !this.isOnCooldown(mint, currentPrice)) {
      this.sendAlert({
        mint,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        buyCount: buysM5,
        priceChangePct,
        volumeUsd: pair.volume?.m5,
        marketCapUsd: pair.marketCap ?? pair.fdv,
        priceUsd: pair.priceUsd,
        source: 'dexscreener',
      })
    }
  }

  // ── Social follower spike (from SocialPoller) ─────────────────────────────

  handleFollowerSpike(mint: string, handle: string, followers: number, deltaAbs: number, deltaPct: number): void {
    const token = db.getToken(mint)
    this.sendAlert({
      mint,
      name: token?.name ?? 'Unknown',
      symbol: token?.symbol ?? '?',
      priceUsd: token?.priceUsd ?? undefined,
      marketCapUsd: token?.marketCap ?? undefined,
      twitterHandle: handle,
      followersDelta: deltaAbs,
      followersDeltaPct: deltaPct,
      followersTotal: followers,
      source: 'social',
    })
  }

  // ── Core send ─────────────────────────────────────────────────────────────

  private sendAlert(data: AlertData): void {
    // Anchor the price so the next re-alert requires another full % move from here
    if (data.priceUsd) {
      this.priceAtLastAlert.set(data.mint, parseFloat(data.priceUsd))
    }

    const targets = this.resolveTargets(data.mint)

    if (targets.length === 0) {
      console.warn('[Alert] No chat IDs configured, skipping alert.')
      return
    }

    db.recordAlert(data.mint, 'pump')

    // Find wallets holding this token for the "held by" annotation
    const holders = db.getWalletsHoldingToken(data.mint)
    const holderNames = holders.map(w => w.label)

    const message = formatMessage(data, config.alerts, holderNames)

    for (const chatId of targets) {
      this.bot
        .sendMessage(chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        })
        .then(() => {
          console.log(`[Alert] Sent pump alert for ${data.symbol} (${data.mint.slice(0, 8)}...) → chat ${chatId}`)
        })
        .catch(err => {
          console.error('[Alert] Failed to send Telegram message:', err?.message)
        })
    }
  }

  /**
   * Determine which chat IDs should receive this alert.
   *
   * Rules:
   *   - If the token was auto-added from a wallet scan: alert only the wallet owner
   *   - If added manually (or unknown source): alert all configured users
   */
  private resolveTargets(mint: string): string[] {
    const token = db.getToken(mint)

    if (token?.source === 'wallet' && token.walletSource) {
      const wallet = db.getWallet(token.walletSource)
      if (wallet?.ownerChatId) return [wallet.ownerChatId]
    }

    // Manual / unknown source → all users
    const allChatIds = config.telegram.users.map(u => u.chatId).filter(Boolean)
    return allChatIds
  }

  /**
   * Returns true if this mint should be suppressed right now.
   *
   * Logic:
   *  1. Hard minimum gap (2 min) — prevents burst spam.
   *  2. After the minimum gap, only suppress if the price hasn't moved
   *     another `priceChangePercent`% from the price when the last alert fired.
   *     This means a token that keeps pumping will keep alerting, while a
   *     token that spiked once and flatlined won't spam.
   *  3. If no price is available, fall back to the configured cooldown.
   */
  private isOnCooldown(mint: string, currentPrice?: number): boolean {
    const lastAlert = db.getLastAlertTime(mint)
    if (!lastAlert) return false

    const timeSince = Date.now() - lastAlert
    if (timeSince < this.MIN_ALERT_GAP_MS) return true

    // Price-anchor check: has price moved enough from the last alert?
    if (currentPrice && this.priceAtLastAlert.has(mint)) {
      const anchor = this.priceAtLastAlert.get(mint)!
      if (anchor > 0) {
        const movePct = Math.abs((currentPrice - anchor) / anchor) * 100
        // Not moved enough from the anchor — suppress
        if (movePct < config.alerts.priceChangePercent) return true
      }
      return false // price has moved enough — allow re-alert
    }

    // No price info — fall back to configured cooldown
    return timeSince < config.alerts.cooldownMinutes * 60_000
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
  alertConfig: typeof config.alerts,
  holderNames: string[]
): string {
  // Social spike alert — different format
  if (data.source === 'social' && data.twitterHandle) {
    const lines = [
      `👥 <b>COMMUNITY SPIKE!</b>`,
      ``,
      `<b>${escapeHtml(data.name)}</b>  $${escapeHtml(data.symbol)}`,
      `<code>${data.mint}</code>`,
      ``,
      `🐦 @${escapeHtml(data.twitterHandle)}`,
      `📈 Followers  <b>+${data.followersDelta?.toLocaleString()} (+${data.followersDeltaPct?.toFixed(1)}%)</b>`,
      `👥 Total  <b>${data.followersTotal?.toLocaleString()}</b>`,
    ]
    if (data.priceUsd) lines.push(`💲 Price  <b>$${data.priceUsd}</b>`)
    if (data.marketCapUsd) lines.push(`💎 MC     <b>$${fmtNum(data.marketCapUsd)}</b>`)
    if (holderNames.length > 0) lines.push(`💼 Held by  <b>${holderNames.join(', ')}</b>`)
    lines.push(
      ``,
      [
        `<a href="https://x.com/${data.twitterHandle}">🐦 X / Twitter</a>`,
        `<a href="https://axiom.trade/t/${data.mint}">📊 Axiom</a>`,
        `<a href="https://dexscreener.com/solana/${data.mint}">📈 DexScr</a>`,
      ].join('  |  ')
    )
    return lines.join('\n')
  }

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

  if (holderNames.length > 0) {
    lines.push(`💼 Held by  <b>${holderNames.join(', ')}</b>`)
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
