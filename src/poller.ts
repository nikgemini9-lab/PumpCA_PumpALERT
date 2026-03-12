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
// Birdeye multi-price API — replaces Jupiter (which now requires a paid key)
const BIRDEYE_PRICE_API = 'https://public-api.birdeye.so/defi/multi_price'
// Pump.fun frontend API — covers pre-graduation bonding curve tokens, no key needed
const PUMPFUN_API = 'https://frontend-api.pump.fun/coins'
const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000 // all pump.fun tokens launch with 1B supply
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
    const tokens = await db.getActiveTokens()
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
          await db.updateTokenMetadata(mint, {
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

    // Birdeye fallback: fetch prices for tokens that have no DexScreener pair
    const missingMints = mints.filter(m => !foundOnDex.has(m))
    if (missingMints.length > 0) {
      const foundOnBirdeye = await this.fetchBirdeyePrices(missingMints)
      // Pump.fun fallback: for tokens still missing after Birdeye (pre-graduation bonding curve)
      const stillMissing = missingMints.filter(m => !foundOnBirdeye.has(m))
      if (stillMissing.length > 0) {
        await this.fetchPumpFunPrices(stillMissing)
      }
    }
  }

  /**
   * Twitter follower count polling — uses the legacy Twitter widget endpoint
   * which returns public follower counts without any API key or auth.
   * Emits 'social' events when follower counts spike by >= FOLLOWER_SPIKE_PCT.
   */
  private async pollSocial(): Promise<void> {
    const tokens = await db.getTokensWithTwitter()
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

          await db.updateTwitterFollowers(token.mint, item.followers_count)

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
   * Birdeye multi-price API — replaces Jupiter (which now requires a paid key).
   * Batches up to 100 mints per request. Requires BIRDEYE_API_KEY env var.
   * Response: { data: { MINT: { value: number, ... } }, success: true }
   * Returns the set of mints that Birdeye returned a price for.
   */
  private async fetchBirdeyePrices(mints: string[]): Promise<Set<string>> {
    const found = new Set<string>()
    if (!config.birdeye.apiKey) {
      console.warn('[Poller] BIRDEYE_API_KEY not set — skipping Birdeye price fallback')
      return found
    }
    const batches = chunk(mints, 100)
    for (const batch of batches) {
      try {
        const res = await axios.get<{ data: Record<string, { value: number }>, success: boolean }>(
          `${BIRDEYE_PRICE_API}?list_address=${batch.join(',')}`,
          {
            timeout: 8_000,
            headers: {
              'X-API-KEY': config.birdeye.apiKey,
              'x-chain': 'solana',
            },
          }
        )
        if (!res.data?.success) continue
        const data = res.data.data ?? {}
        let updated = 0
        for (const [mint, info] of Object.entries(data)) {
          const price = info?.value
          if (!price || price === 0) continue
          await db.updateTokenMetadata(mint, { priceUsd: String(price) })
          found.add(mint)
          updated++
        }
        if (updated > 0) console.log(`[Poller] Birdeye: prices updated for ${updated} tokens`)
        this.lastPollAt = Date.now()
      } catch (err: any) {
        console.warn(`[Poller] Birdeye price fallback error: ${err?.message ?? err}`)
      }
    }
    return found
  }

  /**
   * Pump.fun fallback — for tokens still on the bonding curve that have no
   * DEX pair yet. Calls the pump.fun frontend API per-mint (no batch endpoint).
   * Also extracts Twitter handle and token name/symbol if not already set.
   */
  private async fetchPumpFunPrices(mints: string[]): Promise<void> {
    let updated = 0
    await Promise.all(mints.map(async mint => {
      try {
        const res = await axios.get<{
          name?: string
          symbol?: string
          usd_market_cap?: number
          twitter?: string
        }>(`${PUMPFUN_API}/${mint}`, {
          timeout: 8_000,
          headers: { 'User-Agent': 'PumpAlert/1.0' },
        })
        const d = res.data
        if (!d?.usd_market_cap) return

        const price = d.usd_market_cap / PUMPFUN_TOTAL_SUPPLY
        const twitterHandle = d.twitter ? extractTwitterHandle(d.twitter) : undefined

        await db.updateTokenMetadata(mint, {
          ...(d.name ? { name: d.name } : {}),
          ...(d.symbol ? { symbol: d.symbol } : {}),
          priceUsd: String(price),
          marketCap: d.usd_market_cap,
          ...(twitterHandle ? { twitterHandle } : {}),
        })
        updated++
      } catch (err: any) {
        const status = err?.response?.status
        // 404 = not a pump.fun token; 5xx = Cloudflare/server transient — all silent
        if (status !== 404 && !(status >= 500)) {
          console.warn(`[Poller] pump.fun fetch error for ${mint}: ${err?.message ?? err}`)
        }
      }
    }))
    if (updated > 0) console.log(`[Poller] pump.fun: prices updated for ${updated} tokens`)
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
