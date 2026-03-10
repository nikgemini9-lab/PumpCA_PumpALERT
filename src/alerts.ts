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

    if (exceedsBuyThreshold || exceedsPriceThreshold) {
      this.handleOnChainBuyAsync(mint, solAmount, pctChange, buyCount).catch(err =>
        console.error('[Alert] handleOnChainBuy error:', err)
      )
    }
  }

  private async handleOnChainBuyAsync(
    mint: string,
    solAmount: number,
    pctChange: number,
    buyCount: number
  ): Promise<void> {
    if (await this.isOnCooldown(mint)) return
    const token = await db.getToken(mint)
    await this.sendAlert({
      mint,
      name: token?.name ?? 'Unknown',
      symbol: token?.symbol ?? '?',
      buyCount,
      priceChangePct: pctChange,
      solAmount,
      priceUsd: token?.priceUsd ?? undefined,
      marketCapUsd: token?.marketCap ?? undefined,
      initialMarketCapUsd: token?.initialMarketCap ?? undefined,
      source: 'onchain',
    })
  }

  // ── DexScreener update (from DexScreenerPoller) ───────────────────────────

  handleDexScreenerData(mint: string, pair: DexScreenerPair): void {
    const priceChangePct = pair.priceChange?.m5 ?? 0
    const buysM5 = pair.txns?.m5?.buys ?? 0
    const currentPrice = pair.priceUsd ? parseFloat(pair.priceUsd) : undefined

    const exceedsBuyThreshold = buysM5 >= config.alerts.buyCountThreshold
    const exceedsPriceThreshold = priceChangePct >= config.alerts.priceChangePercent

    if (exceedsBuyThreshold || exceedsPriceThreshold) {
      this.handleDexScreenerAsync(mint, pair, priceChangePct, buysM5, currentPrice).catch(err =>
        console.error('[Alert] handleDexScreenerData error:', err)
      )
    }
  }

  private async handleDexScreenerAsync(
    mint: string,
    pair: DexScreenerPair,
    priceChangePct: number,
    buysM5: number,
    currentPrice: number | undefined
  ): Promise<void> {
    if (await this.isOnCooldown(mint, currentPrice)) return

    const token = await db.getToken(mint)
    const currentMC = pair.fdv ?? pair.marketCap
    const initialMC = token?.initialMarketCap ?? null

    // Skip alert if current MC is below first-seen baseline (token already dumped from when we first saw it)
    if (initialMC != null && currentMC != null && currentMC < initialMC) {
      console.log(`[Alert] Skipped ${mint.slice(0, 8)} — MC $${fmtNum(currentMC)} below first-seen $${fmtNum(initialMC)}`)
      return
    }

    await this.sendAlert({
      mint,
      name: pair.baseToken.name,
      symbol: pair.baseToken.symbol,
      buyCount: buysM5,
      priceChangePct,
      volumeUsd: pair.volume?.m5,
      marketCapUsd: currentMC,
      priceUsd: pair.priceUsd,
      initialMarketCapUsd: initialMC ?? undefined,
      source: 'dexscreener',
    })
  }

  // ── Social follower spike (from SocialPoller) ─────────────────────────────

  handleFollowerSpike(mint: string, handle: string, followers: number, deltaAbs: number, deltaPct: number): void {
    this.handleFollowerSpikeAsync(mint, handle, followers, deltaAbs, deltaPct).catch(err =>
      console.error('[Alert] handleFollowerSpike error:', err)
    )
  }

  private async handleFollowerSpikeAsync(
    mint: string,
    handle: string,
    followers: number,
    deltaAbs: number,
    deltaPct: number
  ): Promise<void> {
    const token = await db.getToken(mint)
    await this.sendAlert({
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

  private async sendAlert(data: AlertData): Promise<void> {
    if (data.priceUsd) {
      this.priceAtLastAlert.set(data.mint, parseFloat(data.priceUsd))
    }

    const targets = await this.resolveTargets(data.mint)

    if (targets.length === 0) {
      console.warn('[Alert] No chat IDs configured, skipping alert.')
      return
    }

    await db.recordAlert(data.mint, 'pump')

    const holders = await db.getWalletsHoldingToken(data.mint)
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

  private async resolveTargets(mint: string): Promise<string[]> {
    const token = await db.getToken(mint)

    if (token?.source === 'wallet' && token.walletSource) {
      const wallet = await db.getWallet(token.walletSource)
      if (wallet?.ownerChatId) return [wallet.ownerChatId]
    }

    const allChatIds = config.telegram.users.map(u => u.chatId).filter(Boolean)
    return allChatIds
  }

  private async isOnCooldown(mint: string, currentPrice?: number): Promise<boolean> {
    const lastAlert = await db.getLastAlertTime(mint)
    if (!lastAlert) return false

    const timeSince = Date.now() - lastAlert
    if (timeSince < this.MIN_ALERT_GAP_MS) return true

    if (currentPrice && this.priceAtLastAlert.has(mint)) {
      const anchor = this.priceAtLastAlert.get(mint)!
      if (anchor > 0) {
        const movePct = Math.abs((currentPrice - anchor) / anchor) * 100
        if (movePct < config.alerts.priceChangePercent) return true
      }
      return false
    }

    return timeSince < config.alerts.cooldownMinutes * 60_000
  }

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
    lines.push(`🛒 Buys   <b>${data.buyCount}</b> in ${alertConfig.buyCountWindowMinutes} min`)
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

  if (data.initialMarketCapUsd && data.marketCapUsd && data.initialMarketCapUsd > 0) {
    const changePct = ((data.marketCapUsd - data.initialMarketCapUsd) / data.initialMarketCapUsd) * 100
    const sign = changePct >= 0 ? '+' : ''
    lines.push(`📍 First seen  <b>$${fmtNum(data.initialMarketCapUsd)}</b> MC  →  <b>${sign}${changePct.toFixed(0)}%</b>`)
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
