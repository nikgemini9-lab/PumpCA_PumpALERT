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
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2'
const BATCH_SIZE = 30

export class DexScreenerPoller extends EventEmitter {
  private intervalId: NodeJS.Timeout | null = null
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
    console.log(`[Poller] Started — polling every ${config.alerts.pollIntervalSeconds}s`)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
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

          // Prefer circulating marketCap over FDV — they're very different for
          // tokens where not all supply is in circulation
          db.updateTokenMetadata(mint, {
            name: pair.baseToken.name,
            symbol: pair.baseToken.symbol,
            priceUsd: pair.priceUsd,
            marketCap: pair.marketCap ?? pair.fdv,
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
   * Jupiter Price API covers tokens with no DexScreener listing (Token-2022,
   * newly launched, low-liquidity). Free, no API key needed.
   */
  private async fetchJupiterPrices(mints: string[]): Promise<void> {
    const batches = chunk(mints, 100) // Jupiter supports large batches
    for (const batch of batches) {
      try {
        const res = await axios.get<{ data: Record<string, { id: string; price: string }> }>(
          `${JUPITER_PRICE_API}?ids=${batch.join(',')}`,
          { timeout: 8_000, headers: { 'User-Agent': 'PumpAlert/1.0' } }
        )
        const data = res.data?.data ?? {}
        for (const [mint, info] of Object.entries(data)) {
          if (!info?.price) continue
          db.updateTokenMetadata(mint, { priceUsd: info.price })
          console.log(`[Poller] Jupiter price for ${mint.slice(0, 8)}...: $${info.price}`)
        }
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
