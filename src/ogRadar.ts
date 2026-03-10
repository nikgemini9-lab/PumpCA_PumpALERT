/**
 * OG Hunter Radar
 *
 * Monitors all DexScreener data events. When a tracked token:
 *   1. Has migrated from bonding curve (appears on DexScreener)
 *   2. Reaches a market cap above MIGRATED_MC_THRESHOLD ($25K)
 *
 * …it searches for an older token with the same name/symbol. If one is found
 * with a market cap BELOW OG_MC_THRESHOLD ($5K), it:
 *   - Stores the hit in the og_radar DB table (deduped per migrated token)
 *   - Sends a Telegram alert to all configured users
 *
 * The dashboard fetches /api/og-radar to display the radar hits panel.
 */

import TelegramBot from 'node-telegram-bot-api'
import { config } from './config'
import * as db from './database'
import { findOgToken, fmtAge, getOgBuyActivity } from './ogFinder'
import { DexScreenerPair } from './types'

const MIGRATED_MC_THRESHOLD = 25_000  // $25K — token must have migrated & pumped
const OG_MC_THRESHOLD = 5_000        // $5K  — OG must be cheap / sleeping

export class OgHunterRadar {
  // In-memory set so we don't re-query the DB on every 15s poll for already-checked mints
  private checked = new Set<string>()

  constructor(private bot: TelegramBot) {}

  /** Called from index.ts on every poller.on('data') event */
  handleDexData(mint: string, pair: DexScreenerPair): void {
    const mc = pair.fdv ?? pair.marketCap
    if (!mc || mc < MIGRATED_MC_THRESHOLD) return
    if (this.checked.has(mint)) return
    this.checked.add(mint)

    this.runCheck(mint, pair, mc).catch(err =>
      console.error('[OgRadar] check error:', err)
    )
  }

  private async runCheck(mint: string, pair: DexScreenerPair, mc: number): Promise<void> {
    const name = pair.baseToken?.name
    const symbol = pair.baseToken?.symbol
    if (!name || name === 'Unknown') return

    const og = await findOgToken(mint, name, symbol)
    if (!og) return
    if (og.marketCapUsd > OG_MC_THRESHOLD) return

    // Fetch buy activity for the OG token (last 3 hours)
    const buyActivity = await getOgBuyActivity(og.mint)

    // Store in DB — returns false if already stored (unique on migrated_mint)
    const stored = await db.addOgRadarHit({
      migratedMint: mint,
      migratedName: name,
      migratedSymbol: symbol,
      migratedMc: mc,
      ogMint: og.mint,
      ogName: og.name,
      ogSymbol: og.symbol,
      ogMc: og.marketCapUsd,
      ogAgeHours: og.ageHours,
      ogBuyCount: buyActivity.buyCount,
      ogBuyVolumeUsd: buyActivity.buyVolumeUsd,
    })
    if (!stored) return

    console.log(
      `[OgRadar] 🎯 Hit! ${name} (${mint.slice(0, 8)}) migrated $${fmtNum(mc)} ` +
      `→ OG ${og.name} (${og.mint.slice(0, 8)}) MC $${fmtNum(og.marketCapUsd)}` +
      (buyActivity.buyCount > 0 ? ` | OG buys 3h: ${buyActivity.buyCount} ($${fmtNum(buyActivity.buyVolumeUsd)})` : '')
    )

    await this.sendAlert(mint, name, symbol, mc, og, buyActivity)
  }

  private async sendAlert(
    migratedMint: string,
    name: string,
    symbol: string,
    migratedMc: number,
    og: { mint: string; name: string; symbol: string; ageHours: number; marketCapUsd: number },
    buyActivity: { buyCount: number; buyVolumeUsd: number }
  ): Promise<void> {
    const chatIds = config.telegram.users.map(u => u.chatId).filter(Boolean)
    if (chatIds.length === 0) return

    const ogMcStr = og.marketCapUsd > 0 ? `$${fmtNum(og.marketCapUsd)}` : 'unknown MC'
    const migratedMcStr = `$${fmtNum(migratedMc)}`

    const buyLine = buyActivity.buyCount > 0
      ? `🛒 OG recent buys (3h): <b>${buyActivity.buyCount}</b>  ·  <b>$${fmtNum(buyActivity.buyVolumeUsd)}</b>`
      : `🛒 OG recent buys (3h): <b>none yet</b>`

    const text = [
      `🎯 <b>OG HUNTER RADAR</b>`,
      ``,
      `A migrated token just pumped above $25K — and its OG is still sleeping!`,
      ``,
      `<b>Migrated token (pumping):</b>`,
      `<b>${escHtml(name)}</b>  $${escHtml(symbol)}`,
      `<code>${migratedMint}</code>`,
      `💎 MC: <b>${migratedMcStr}</b>`,
      ``,
      `<b>👑 OG Token (sleeping):</b>`,
      `<b>${escHtml(og.name)}</b>  $${escHtml(og.symbol)}`,
      `<code>${og.mint}</code>`,
      `⏳ Age: <b>${fmtAge(og.ageHours)}</b>`,
      `💎 MC: <b>${ogMcStr}</b>  ← still cheap`,
      buyLine,
      ``,
      `⚡ Community attention may rotate from the new token to this OG.`,
      ``,
      [
        `<a href="https://axiom.trade/t/${og.mint}">📊 Axiom OG</a>`,
        `<a href="https://dexscreener.com/solana/${og.mint}">📈 DexScr OG</a>`,
        `<a href="https://pump.fun/${og.mint}">🎱 pump.fun OG</a>`,
      ].join('  |  '),
    ].join('\n')

    for (const chatId of chatIds) {
      this.bot
        .sendMessage(chatId, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        })
        .catch(err => console.error('[OgRadar] Telegram send error:', err?.message))
    }
  }
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
