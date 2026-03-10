/**
 * DexScreener poller
 *
 * Every N seconds, fetches market data for all active tokens from the
 * DexScreener API (no API key needed). Used for:
 *   - Price change % detection (5m, 1h)
 *   - Buy/sell count detection
 *   - Updating token metadata (name, symbol, price, market cap)
 *
 * Handles tokens that have graduated from pump.fun to Raydium.
 * Batches requests — DexScreener supports up to 30 tokens per call.
 */

import axios from 'axios'
import { EventEmitter } from 'events'
import { DexScreenerPair } from './types'
import { config } from './config'
import * as db from './database'

const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens'
// Jupiter v6 price API — free, no key, covers all Solana tokens with any liquidity
const JUPITER_PRICE_API = 'https://price.jup.ag/v6/price'
// Twitter widget endpoint — returns follower counts for public handles, no API key needed
const TWITTER_WIDGET_API = 'https://cdn.syndication.twimg.com/widgets/followbutton/info.json'
const BATCH_SIZE = 30
// How often to check Twitter follower counts (5 min — free, no auth)
const SOCIAL_POLL_INTERVAL_MS = 5 * 60_000
// Alert when followers jump by this % in one poll interval
const FOLLOWER_SPIKE_PCT = 5

export class DexScreenerPoller extends EventEmitter {
  private intervalId: NodeJS.Timeout | null = null
  private socialIntervalId: NodeJS.Timeout | null = null
  private lastPollAt: number | null = null
  private running = false

  start(): void {
    if (this.running) return
    this.running = true
    this.poll() // immediate first run
    this.intervalId = setInterval(
      () => this.poll(),
      config.alerts.pollIntervalSeconds * 1000
    )
    // Social follower polling — staggered 30s after startup
    setTimeout(() => {
      this.pollSocial()
      this.socialIntervalId = setInterval(() => this.pollSocial(), SOCIAL_POLL_INTERVAL_MS)
    }, 30_000)
    console.log(`[Poller] Started — polling every ${config.alerts.pollIntervalSeconds}s, social every ${SOCIAL_POLL_INTERVAL_MS / 1000}s`)
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null }
    if (this.socialIntervalId) { clearInterval(this.socialIntervalId); this.socialIntervalId = null }
    this.running = false
  }

  getLastPollAt(): number | null {
    return this.lastPollAt
  }

  private async poll(): Promise<void> {
    const tokens = db.getActiveTokens()
    if (tokens.length === 0) return

    const mints = tokens.map(t => t.mint)
    const batches = chunk(mints, BATCH_SIZE)
    const foundOnDex = new Set<string>()

    for (const batch of batches) {
      try {
        const url = `${DEXSCREENER_API}/${batch.join(',')}`
        const res = await axios.get<{ pairs: DexScreenerPair[] }>(url, {
          timeout: 10_000,
          headers: { 'User-Agent': 'PumpAlert/1.0' },
        })

        const pairs = res.data?.pairs ?? []

        for (const pair of pairs) {
          if (pair.chainId !== 'solana') continue

          const mint = pair.baseToken?.address
          if (!mint || !mints.includes(mint)) continue

          foundOnDex.add(mint)

          // Extract Twitter handle from DexScreener socials if present
          const twitterUrl = pair.info?.socials?.find(s => s.type === 'twitter')?.url
          const twitterHandle = twitterUrl ? extractTwitterHandle(twitterUrl) : undefined

          // Prefer circulating marketCap over FDV — they're very different for
          // tokens where not all supply is in circulation
          db.updateTokenMetadata(mint, {
            name: pair.baseToken.name,
            symbol: pair.baseToken.symbol,
            priceUsd: pair.priceUsd,
            marketCap: pair.fdv ?? pair.marketCap,
            ...(twitterHandle ? { twitterHandle } : {}),
          })

          // Emit event with full pair data for alert logic
          this.emit('data', mint, pair)
        }

        this.lastPollAt = Date.now()
      } catch (err: any) {
        const msg = err?.message ?? String(err)
        console.warn(`[Poller] DexScreener error: ${msg}`)
      }
    }

    // Jupiter fallback: fetch prices for tokens that have no DexScreener pair
    const missingMints = mints.filter(m => !foundOnDex.has(m))
    if (missingMints.length > 0) {
      await this.fetchJupiterPrices(missingMints)
    }
  }

  /**
   * Twitter follower count polling — uses the legacy Twitter widget endpoint
   * which returns public follower counts without any API key or auth.
   * Emits 'social' events when follower counts spike by >= FOLLOWER_SPIKE_PCT.
   */
  private async pollSocial(): Promise<void> {
    const tokens = db.getTokensWithTwitter()
    if (tokens.length === 0) return

    const handles = tokens.map(t => t.twitterHandle!).filter(Boolean)
    const handleBatches = chunk(handles, 100)

    for (const batch of handleBatches) {
      try {
        const res = await axios.get<Array<{ screen_name: string; followers_count: number }>>(
          `${TWITTER_WIDGET_API}?screen_names=${batch.join(',')}`,
          { timeout: 8_000, headers: { 'User-Agent': 'PumpAlert/1.0' } }
        )
        const results = res.data ?? []
        for (const item of results) {
          const handle = item.screen_name?.toLowerCase()
          if (!handle || !item.followers_count) continue

          const token = tokens.find(t => t.twitterHandle?.toLowerCase() === handle)
          if (!token) continue

          db.updateTwitterFollowers(token.mint, item.followers_count)

          // Check for a spike: compare against previous reading
          const prev = token.twitterFollowers
          if (prev && prev > 0) {
            const delta = item.followers_count - prev
            const deltaPct = (delta / prev) * 100
            if (delta > 0 && deltaPct >= FOLLOWER_SPIKE_PCT) {
              console.log(`[Social] Follower spike for @${handle}: +${delta} (+${deltaPct.toFixed(1)}%)`)
              this.emit('social', token.mint, handle, item.followers_count, delta, deltaPct)
            }
          } else {
            console.log(`[Social] @${handle}: ${item.followers_count.toLocaleString()} followers (baseline set)`)
          }
        }
      } catch (err: any) {
        console.warn(`[Social] Twitter widget fetch failed: ${err?.message ?? err}`)
      }
    }
  }

  /**
   * Jupiter Price API covers tokens with no DexScreener listing (Token-2022,
   * newly launched, low-liquidity). Free, no API key needed.
   */
  private async fetchJupiterPrices(mints: string[]): Promise<void> {
    // Jupiter v6 accepts up to 100 ids per request
    const batches = chunk(mints, 100)
    for (const batch of batches) {
      try {
        // v6 response: { data: { MINT: { id, mintSymbol, vsToken, vsTokenSymbol, price } } }
        const res = await axios.get<{ data: Record<string, { id: string; price: number }> }>(
          `${JUPITER_PRICE_API}?ids=${batch.join(',')}`,
          { timeout: 8_000, headers: { 'User-Agent': 'PumpAlert/1.0' } }
        )
        const data = res.data?.data ?? {}
        let updated = 0
        for (const [mint, info] of Object.entries(data)) {
          if (!info?.price || info.price === 0) continue
          db.updateTokenMetadata(mint, { priceUsd: String(info.price) })
          updated++
        }
        if (updated > 0) console.log(`[Poller] Jupiter: prices updated for ${updated} tokens`)
        this.lastPollAt = Date.now()
      } catch (err: any) {
        console.warn(`[Poller] Jupiter price fallback error: ${err?.message ?? err}`)
      }
    }
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size))
  }
  return out
}

function extractTwitterHandle(url: string): string | undefined {
  try {
    const u = new URL(url)
    // Handle https://twitter.com/handle or https://x.com/handle
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length > 0) return parts[0].toLowerCase()
  } catch {}
  return undefined
}
