/**
 * OG MC Tracker
 *
 * After OG Hunter Radar stores a hit, this tracker keeps polling the OG token's
 * market cap every 3 minutes and fires a Telegram alert each time it crosses a
 * milestone (2x, 3x, 5x, 10x) from the MC recorded at detection time.
 *
 * Zero Helius credits — uses the free pump.fun coin API directly.
 * API failures are logged as warnings; the poll gracefully continues.
 */

import TelegramBot from 'node-telegram-bot-api'
import { config } from './config'
import { getOgRadarHits } from './database'
import { fetchPumpCoin } from './ogFinder'

const POLL_MS    = 3 * 60_000         // check every 3 minutes
const TRACK_MS   = 24 * 60 * 60_000  // track OG hits for 24 h after detection
const MILESTONES = [2, 3, 5, 10]     // fire alert at these multipliers

export class OgMcTracker {
  /** ogMint → set of milestone multipliers already alerted (in-memory, resets on restart) */
  private fired = new Map<string, Set<number>>()
  private timer: NodeJS.Timeout | null = null

  constructor(private bot: TelegramBot) {}

  start(): void {
    // Delay first poll 90s so OG radar has time to populate on startup
    setTimeout(() => this.poll().catch(err => console.error('[OgMcTracker] poll error:', err)), 90_000)
    this.timer = setInterval(
      () => this.poll().catch(err => console.error('[OgMcTracker] poll error:', err)),
      POLL_MS
    )
    console.log('[OgMcTracker] Started — checking OG MCs every 3 min')
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async poll(): Promise<void> {
    const hits  = await getOgRadarHits(50)
    const now   = Date.now()
    const fresh = hits.filter(h => h.ogMc > 0 && now - h.detectedAt < TRACK_MS)
    if (fresh.length === 0) return

    let ok = 0
    let fail = 0

    for (const hit of fresh) {
      const coin = await fetchPumpCoin(hit.ogMint)
      if (!coin?.usd_market_cap) {
        fail++
        console.warn(
          `[OgMcTracker] pump.fun API failed for OG ${hit.ogName} (${hit.ogMint.slice(0, 8)})`
        )
        continue
      }
      ok++

      const currentMc = coin.usd_market_cap
      const mult      = currentMc / hit.ogMc

      const alerted = this.fired.get(hit.ogMint) ?? new Set<number>()
      this.fired.set(hit.ogMint, alerted)

      for (const m of MILESTONES) {
        if (mult >= m && !alerted.has(m)) {
          alerted.add(m)
          console.log(
            `[OgMcTracker] 🚀 ${hit.ogName} hit ${m}x! ` +
            `$${fmtNum(hit.ogMc)} → $${fmtNum(currentMc)} ` +
            `(context: ${hit.migratedName})`
          )
          await this.sendAlert(hit, currentMc, mult, m)
        }
      }
    }

    console.log(
      `[OgMcTracker] Poll done — ${fresh.length} active hits, ${ok} updated, ` +
      (fail > 0 ? `⚠ ${fail} pump.fun API failures` : 'all API calls OK')
    )
  }

  private async sendAlert(
    hit: Awaited<ReturnType<typeof getOgRadarHits>>[number],
    currentMc: number,
    mult: number,
    milestone: number,
  ): Promise<void> {
    const chatIds = config.telegram.users.map(u => u.chatId).filter(Boolean)
    if (chatIds.length === 0) return

    const arrow   = milestone >= 5 ? '🚀🚀' : milestone >= 3 ? '🚀' : '📈'
    const multStr = mult >= 10
      ? `${mult.toFixed(1)}x`
      : `${mult.toFixed(2)}x`

    const text = [
      `${arrow} <b>OG RADAR — ${milestone}x HIT!</b>`,
      ``,
      `<b>${escHtml(hit.ogName)}</b>  $${escHtml(hit.ogSymbol)}`,
      `<code>${hit.ogMint}</code>`,
      ``,
      `💎 Detection MC:  <b>$${fmtNum(hit.ogMc)}</b>`,
      `💎 Current MC:    <b>$${fmtNum(currentMc)}</b>  (<b>${multStr}</b>)`,
      ``,
      `🔗 Context: <b>${escHtml(hit.migratedName)}</b> migrated @ $${fmtNum(hit.migratedMc)}`,
      ``,
      [
        `<a href="https://axiom.trade/t/${hit.ogMint}">📊 Axiom</a>`,
        `<a href="https://dexscreener.com/solana/${hit.ogMint}">📈 DexScr</a>`,
        `<a href="https://pump.fun/${hit.ogMint}">🎱 pump.fun</a>`,
      ].join('  |  '),
    ].join('\n')

    for (const chatId of chatIds) {
      this.bot
        .sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true })
        .catch(err => console.error('[OgMcTracker] Telegram send error:', err?.message))
    }
  }
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
