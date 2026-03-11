/**
 * Pump.fun Movers Poller
 *
 * Polls pump.fun every 60s for the most recently traded tokens and maintains
 * a rolling 25-hour market-cap history per token to compute price changes
 * (5m / 1h / 6h / 24h) entirely in-memory — no DB needed.
 *
 * For graduated tokens (complete=true), it enriches the data with DexScreener
 * pair data (which already carries native price-change percentages).
 *
 * Key feature: "dormant coin" detection.
 * A coin is considered DORMANT when:
 *   - Age ≥ 25 days (old / potentially OG coin)
 *   - Traded within the last 24 hours (it just woke up)
 *   - |1h change| ≥ 30%  OR  |6h change| ≥ 60%
 * When first detected, a 'dormant' event is emitted → Telegram alert.
 */

import axios from 'axios'
import { EventEmitter } from 'events'

const PUMP_API = 'https://frontend-api.pump.fun/coins'
const DEX_API  = 'https://api.dexscreener.com/latest/dex/tokens'

const POLL_MS           = 60_000  // 60 seconds
const DORMANT_AGE_DAYS  = 25
const DORMANT_MOVE_1H   = 30      // % threshold for 1h move
const DORMANT_MOVE_6H   = 60      // % threshold for 6h move
const HISTORY_MAX_MS    = 25 * 60 * 60_000  // keep 25h of snapshots

// ── Types ─────────────────────────────────────────────────────────────────────

interface PumpRaw {
  mint: string
  name: string
  symbol: string
  usd_market_cap: number
  created_timestamp: number       // epoch ms
  last_trade_unix_time: number    // epoch seconds
  complete: boolean
  reply_count: number
  image_uri?: string
  nsfw?: boolean
}

export interface MoverEntry {
  mint: string
  name: string
  symbol: string
  marketCap: number
  ageHours: number
  createdAt: number               // epoch ms
  lastTradeAt: number             // epoch ms
  change5m: number | null
  change1h: number | null
  change6h: number | null
  change24h: number | null
  volume24h: number | null
  txns24h: number | null
  graduated: boolean
  isDormant: boolean
}

interface Snap { ts: number; mc: number }

// ── Class ─────────────────────────────────────────────────────────────────────

export class MoversPoller extends EventEmitter {
  private history     = new Map<string, Snap[]>()
  private movers      = new Map<string, MoverEntry>()
  private dormantSeen = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  start(): void {
    this.poll().catch(err => console.error('[Movers] poll error:', err?.message))
    this.timer = setInterval(
      () => this.poll().catch(err => console.error('[Movers] poll error:', err?.message)),
      POLL_MS
    )
    console.log('[Movers] Poller started — 60s interval')
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  getMovers(): MoverEntry[] {
    return Array.from(this.movers.values())
  }

  // ── Core poll loop ──────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    const pumpTokens = await this.fetchPumpMovers()
    if (pumpTokens.length === 0) return

    // Enrich graduated tokens with DexScreener data
    const graduatedMints = pumpTokens.filter(t => t.complete).map(t => t.mint)
    const dexMap = graduatedMints.length > 0
      ? await this.fetchDexData(graduatedMints)
      : new Map<string, any>()

    const now = Date.now()

    for (const raw of pumpTokens) {
      // Record market cap snapshot
      this.addSnap(raw.mint, now, raw.usd_market_cap)

      // Compute price changes from history
      const computed = this.computeChanges(raw.mint, now)

      // DexScreener data (takes precedence for graduated tokens)
      const dex = dexMap.get(raw.mint)

      const ageMs    = now - raw.created_timestamp
      const ageHours = Math.floor(ageMs / (60 * 60_000))
      const ageDays  = ageHours / 24

      const change1h  = dex?.priceChange?.h1  ?? computed.c1h
      const change6h  = dex?.priceChange?.h6  ?? computed.c6h

      const isDormant =
        ageDays >= DORMANT_AGE_DAYS &&
        raw.last_trade_unix_time * 1000 > now - 24 * 60 * 60_000 &&
        (
          Math.abs(change1h  ?? 0) >= DORMANT_MOVE_1H ||
          Math.abs(change6h  ?? 0) >= DORMANT_MOVE_6H
        )

      const entry: MoverEntry = {
        mint:       raw.mint,
        name:       raw.name,
        symbol:     raw.symbol,
        marketCap:  raw.usd_market_cap,
        ageHours,
        createdAt:  raw.created_timestamp,
        lastTradeAt: raw.last_trade_unix_time * 1000,
        change5m:   dex?.priceChange?.m5  ?? computed.c5m,
        change1h,
        change6h,
        change24h:  dex?.priceChange?.h24 ?? computed.c24h,
        volume24h:  dex?.volume?.h24      ?? null,
        txns24h:    dex ? ((dex.txns?.h24?.buys ?? 0) + (dex.txns?.h24?.sells ?? 0)) : null,
        graduated:  raw.complete,
        isDormant,
      }

      this.movers.set(raw.mint, entry)

      if (isDormant && !this.dormantSeen.has(raw.mint)) {
        this.dormantSeen.add(raw.mint)
        this.emit('dormant', entry)
        console.log(`[Movers] 👴 Dormant wakeup: ${raw.name} (${raw.mint.slice(0, 8)}) age ${Math.floor(ageDays)}d 1h=${change1h?.toFixed(1)}%`)
      }
    }

    console.log(`[Movers] Updated ${pumpTokens.length} tokens (${graduatedMints.length} via DexScreener)`)
  }

  // ── History helpers ─────────────────────────────────────────────────────────

  private addSnap(mint: string, ts: number, mc: number): void {
    if (!this.history.has(mint)) this.history.set(mint, [])
    const snaps = this.history.get(mint)!
    snaps.push({ ts, mc })
    // Prune old snapshots
    const cutoff = ts - HISTORY_MAX_MS
    while (snaps.length > 0 && snaps[0].ts < cutoff) snaps.shift()
  }

  private computeChanges(mint: string, now: number) {
    const snaps = this.history.get(mint) ?? []
    const current = snaps[snaps.length - 1]?.mc

    const pct = (target: number, tol: number): number | null => {
      if (!current || snaps.length < 2) return null
      const ref = this.nearest(snaps, now - target, tol)
      if (!ref || !ref.mc) return null
      return ((current - ref.mc) / ref.mc) * 100
    }

    return {
      c5m:  pct(5  * 60_000,      2 * 60_000),
      c1h:  pct(60 * 60_000,      5 * 60_000),
      c6h:  pct(6  * 60 * 60_000, 15 * 60_000),
      c24h: pct(24 * 60 * 60_000, 30 * 60_000),
    }
  }

  private nearest(snaps: Snap[], target: number, tolerance: number): Snap | undefined {
    return snaps.reduce<Snap | undefined>((best, s) => {
      const dist = Math.abs(s.ts - target)
      if (dist > tolerance) return best
      if (!best) return s
      return dist < Math.abs(best.ts - target) ? s : best
    }, undefined)
  }

  // ── Data fetchers ───────────────────────────────────────────────────────────

  private async fetchPumpMovers(): Promise<PumpRaw[]> {
    try {
      const url = `${PUMP_API}?offset=0&limit=50&sort=last_trade_unix_time&order=DESC&includeNsfw=false`
      const res = await axios.get<PumpRaw[]>(url, {
        timeout: 12_000,
        headers: { 'User-Agent': 'PumpAlert/1.0' },
      })
      const data = Array.isArray(res.data) ? res.data : []
      return data.filter(t => t.mint && t.name && t.usd_market_cap > 0)
    } catch (err: any) {
      const status = err?.response?.status
      if (!(status >= 500)) {
        console.warn('[Movers] pump.fun fetch error:', err?.message)
      }
      return []
    }
  }

  private async fetchDexData(mints: string[]): Promise<Map<string, any>> {
    const result = new Map<string, any>()
    if (mints.length === 0) return result

    try {
      const BATCH = 30
      for (let i = 0; i < mints.length; i += BATCH) {
        const batch = mints.slice(i, i + BATCH)
        const res = await axios.get(`${DEX_API}/${batch.join(',')}`, {
          timeout: 10_000,
          headers: { 'User-Agent': 'PumpAlert/1.0' },
        })
        const pairs: any[] = res.data?.pairs ?? []
        for (const pair of pairs) {
          if (pair.chainId === 'solana' && pair.baseToken?.address) {
            // Prefer the pair with highest liquidity if multiple exist
            const prev = result.get(pair.baseToken.address)
            if (!prev || (pair.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) {
              result.set(pair.baseToken.address, pair)
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('[Movers] DexScreener enrich error:', err?.message)
    }

    return result
  }
}
