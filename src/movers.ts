/**
 * Pump.fun Movers Poller — Helius Edition
 *
 * Replaces the Cloudflare-blocked frontend-api.pump.fun with a Helius pipeline:
 *
 *   1. Helius Enhanced Transactions  → 100 most-recent SWAPs on the pump.fun
 *      bonding-curve program → extract recently-traded token mints.
 *
 *   2. DexScreener /tokens/{mints}   → graduated token metadata + native price
 *      changes (m5 / h1 / h6 / h24), volume, txn counts, pairCreatedAt.
 *
 *   3. Helius getMultipleAccountsInfo → bonding-curve account state for
 *      non-graduated tokens → compute MC entirely on-chain.
 *
 *   4. Helius /v0/token-metadata      → name / symbol for non-graduated mints
 *      not yet in DexScreener.
 *
 * A rolling mintCache (≤ 500 entries) accumulates mints across polls so that
 * tokens discovered earlier continue to be enriched via DexScreener even after
 * they graduate and stop appearing in bonding-curve transactions.
 *
 * Poll interval: configurable via MOVERS_POLL_MINUTES env var (default 5 min).
 *   5 min  → 100 credits × 288 polls/day ≈ 864 k credits/month
 *   15 min → 100 credits × 96 polls/day  ≈ 288 k credits/month
 * Metadata is only fetched for mints seen in ≥ 2 poll cycles (seenCount ≥ 2)
 * to avoid paying 100 credits for flash tokens that never recur.
 *
 * Dormant-coin detection (unchanged logic):
 *   age ≥ 25 days  AND  traded within last 24 h  AND  |1h| ≥ 30% OR |6h| ≥ 60%
 */

import axios from 'axios'
import { Connection, PublicKey } from '@solana/web3.js'
import { EventEmitter } from 'events'
import { config } from './config'
import * as db from './database'

// ── Constants ──────────────────────────────────────────────────────────────────

const PUMP_PROGRAM_STR = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const PUMP_PROGRAM     = new PublicKey(PUMP_PROGRAM_STR)
// Pump.fun AMM (pumpswap) — where graduated pump.fun tokens trade after the bonding curve.
// Watching this lets us catch OLD dormant tokens (any age) that are currently active.
const PUMP_AMM_STR     = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
// Raydium AMM V4 — the main Solana DEX for non-pump.fun tokens (pre-pumpswap graduates,
// legacy Raydium pairs, any old Solana token trading on Raydium).
// Watching this via Helius gives TRUE on-chain discovery for all Raydium pairs.
const RAYDIUM_AMM_STR  = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
// Orca Whirlpool — concentrated liquidity DEX; covers tokens NOT on Raydium or pump.fun.
const ORCA_WHIRLPOOL_STR = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const WSOL             = 'So11111111111111111111111111111111111111112'
// Stablecoins — filter these out when extracting the "interesting" side of a pair
const USDC             = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT             = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const STABLECOINS      = new Set([WSOL, USDC, USDT])

const HELIUS_API = 'https://api.helius.xyz/v0'
const DEX_API    = 'https://api.dexscreener.com/latest/dex/tokens'
const CMC_API    = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest'

// External discovery — fallback sources for old Raydium tokens (pre-pumpswap graduates)
const BIRDEYE_TOKENLIST_API  = 'https://public-api.birdeye.so/defi/tokenlist'
const DEX_BOOSTS_API         = 'https://api.dexscreener.com/token-boosts/active/v1'
// GeckoTerminal — free, no auth. Covers ALL Solana DEXes (Raydium, Orca, etc).
// trending_pools returns up to 20 currently-hot pools per page; paginate 3 pages = 60 pools.
const GECKO_TRENDING_BASE    = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools'
// GeckoTerminal top pools by 24h volume — h24_volume_usd_desc is a confirmed-valid sort.
// High volume reliably correlates with active movers. Paginate 3 pages = 60 pools.
const GECKO_VOLUME_BASE      = 'https://api.geckoterminal.com/api/v2/networks/solana/pools?sort=h24_volume_usd_desc'
// GeckoTerminal new pools — recently created Solana pairs across ALL DEXes.
const GECKO_NEW_POOLS_URL    = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools'
// Raydium v3 pools API — returns ALL Raydium pool types (Standard/CLMM/CPMM) sorted by
// 24h volume. This is the primary "from Solana chain" source for non-pump.fun pairs.
// 3 pages × 100 pools = 300 active Raydium pairs discovered per cycle.
const RAYDIUM_POOLS_API      = 'https://api-v3.raydium.io/pools/info/list'
// Pump.fun coins API — recently-active pump.fun tokens, including some graduated ones.
const PUMPFUN_COINS_API      = 'https://frontend-api.pump.fun/coins'
const EXTERNAL_DISCOVER_MS   = 2 * 60_000  // every 2 minutes

// Configurable via env vars — increase to save Helius credits at the cost of slower new-mint discovery.
// Note: enrichment (DexScreener, no Helius) still runs every 60s regardless, so price data stays fresh.
// Only new-mint *discovery* is delayed when this is raised.
const POLL_MS          = (parseInt(process.env.MOVERS_POLL_MINUTES   ?? '20') || 20) * 60_000   // default 20 min (was 5)
const ENRICH_MS        = (parseInt(process.env.MOVERS_ENRICH_SECONDS ?? '60') || 60) * 1_000    // default 60s
const DORMANT_AGE_DAYS    = 25
const DORMANT_MOVE_5M     = 5         // % — first-candle signal: +5% in last 5 min
const DORMANT_MOVE_1H     = 10        // % — early signal: +10% in last hour
const DORMANT_MOVE_6H     = 25        // % — sustained move: +25% over 6h
const DORMANT_MOVE_24H    = 15        // % — slow-build: +15% over 24h
// Alert only when CURRENT market cap is at or below this — entry point filter.
// Coins already at $1M+ are not useful entries. Buy when chilling at <$10K.
// Override with env: DORMANT_MAX_WAKE_MC (in USD)
const DORMANT_MAX_WAKE_MC = parseInt(process.env.DORMANT_MAX_WAKE_MC ?? '10000') || 10000
const HISTORY_MAX_MS   = 25 * 60 * 60_000  // 25 h of MC snapshots
const MAX_MINT_CACHE   = 3000         // large enough to hold TZ scan results + active tokens without evicting dormants
const MIN_MC_USD       = 2_900        // ignore tokens below $2.9K market cap

// Target Zone — coins older than 30 days sitting in the $8K-$14K MC range.
// These are "sleeping" pump.fun coins that still have holders and could explode.
const TARGET_ZONE_AGE_DAYS = 30
const TARGET_ZONE_MIN_MC   = parseInt(process.env.TARGET_ZONE_MIN_MC ?? '8000')  || 8_000
const TARGET_ZONE_MAX_MC   = parseInt(process.env.TARGET_ZONE_MAX_MC ?? '14000') || 14_000
// Holder count TTL — re-fetch at most once every 15 min (pump.fun has rate limits)
const HOLDER_COUNT_TTL_MS  = 15 * 60_000
// Pump.fun individual coin API — returns holder_count
const PUMPFUN_COIN_API     = 'https://frontend-api.pump.fun/coins'
// Target Zone active scanner: pages through pump.fun by MC desc to find dormant
// coins in range that are NEVER active enough to appear in normal discovery.
const TARGET_ZONE_SCAN_MS    = 10 * 60_000  // every 10 min
// 600 pages × 50 = 30 000 coins — enough to cover all tokens above the $8K range
// even if there are tens of thousands of them. 600 × 100ms ≈ 60s per scan run.
const TARGET_ZONE_SCAN_PAGES = 600

// ── Internal types ─────────────────────────────────────────────────────────────

interface MintRecord {
  name:               string
  symbol:             string
  firstSeen:          number   // epoch ms — proxy for token creation time
  lastTradeAt:        number   // epoch ms — most recent observed trade
  graduated:          boolean
  metadataFetched:    boolean  // true once Helius metadata has been loaded
  seenCount:          number   // polls in which this mint has appeared
  twitterHandle?:     string
  communityFollowers?: number
  communityCheckedAt?: number
  floorMc?:           number   // lowest MC ever observed in-cache
  holderCount?:       number   // from pump.fun /coins/{mint} API
  holderCountAt?:     number   // epoch ms — when holder count was last fetched
  pumpfunMc?:         number   // last-known MC from pump.fun API — fallback when Dex+curve both unavailable
}

interface BondingCurveData {
  virtualTokenReserves: bigint
  virtualSolReserves:   bigint
  tokenTotalSupply:     bigint
  complete:             boolean
}

interface DexPairData {
  name:           string
  symbol:         string
  fdv:            number | null
  pairAddress:    string          // Raydium pool address — used by Axiom for viewer counts
  pairCreatedAt:  number | null   // epoch ms
  priceChange:    { m5?: number; h1?: number; h6?: number; h24?: number } | null
  volume:         { h24?: number } | null
  txns:           { h24?: { buys: number; sells: number } } | null
  liquidityUsd:   number
  twitterHandle?: string          // extracted from pair.info.socials
}

interface Snap { ts: number; mc: number }

// ── Public types ───────────────────────────────────────────────────────────────

/** Raw pump.fun coin data collected during target-zone scans (no age filter). */
interface TzRaw {
  mint:         string
  name:         string
  symbol:       string
  createdAt:    number  // epoch ms — from pump.fun created_timestamp
  lastTradeAt:  number  // epoch ms
  pumpfunMc:    number  // usd_market_cap from pump.fun API
  holderCount?: number
}

export interface MoverEntry {
  mint:               string
  name:               string
  symbol:             string
  marketCap:          number
  ageHours:           number
  createdAt:          number   // epoch ms
  lastTradeAt:        number   // epoch ms
  change5m:           number | null
  change1h:           number | null
  change6h:           number | null
  change24h:          number | null
  volume24h:          number | null
  txns24h:            number | null
  graduated:          boolean
  isDormant:          boolean
  dormantFloorMc?:    number   // lowest MC ever seen in-cache — tells you how low the bottom was
  pairAddress?:       string   // Raydium pool address (graduated only) — used for Axiom viewer counts
  twitterHandle?:     string   // X / Twitter handle (without @)
  communityFollowers?: number  // follower count from widget API
  holderCount?:       number   // from pump.fun API
}

// ── SOL price cache ────────────────────────────────────────────────────────────

let _solPrice = { price: 150, ts: 0 }

async function getSolPrice(): Promise<number> {
  // 10-min cache to conserve CMC credits (~4,320 calls/month on free tier)
  if (Date.now() - _solPrice.ts < 10 * 60_000) return _solPrice.price
  try {
    const cmcKey = config.cmc.apiKey
    if (cmcKey) {
      const res = await axios.get(CMC_API, {
        params: { symbol: 'SOL', convert: 'USD' },
        headers: { 'X-CMC_PRO_API_KEY': cmcKey },
        timeout: 5_000,
      })
      const p = res.data?.data?.SOL?.quote?.USD?.price
      if (p > 0) _solPrice = { price: p, ts: Date.now() }
    } else {
      // Fallback: CoinGecko (no key needed)
      const res = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { timeout: 5_000 }
      )
      const p = res.data?.solana?.usd
      if (p > 0) _solPrice = { price: p, ts: Date.now() }
    }
  } catch { /* use cached */ }
  return _solPrice.price
}

// ── Bonding curve helpers ──────────────────────────────────────────────────────

function getBondingCurvePda(mint: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM
  )[0]
}

/**
 * Bonding curve account layout (Anchor, 8-byte discriminator prefix):
 *   offset  8 — virtual_token_reserves : u64
 *   offset 16 — virtual_sol_reserves   : u64
 *   offset 24 — real_token_reserves    : u64
 *   offset 32 — real_sol_reserves      : u64
 *   offset 40 — token_total_supply     : u64
 *   offset 48 — complete               : bool
 */
function parseBondingCurve(data: Buffer): BondingCurveData | null {
  if (data.length < 49) return null
  try {
    return {
      virtualTokenReserves: data.readBigUInt64LE(8),
      virtualSolReserves:   data.readBigUInt64LE(16),
      tokenTotalSupply:     data.readBigUInt64LE(40),
      complete:             data.readUInt8(48) !== 0,
    }
  } catch { return null }
}

/**
 * MC (USD) = (vSol_lamports / 1e9) / (vToken_units / 1e6) * totalSupply_tokens * solPrice
 * Simplifies to: vSolReserves * totalSupply / (vTokenReserves * 1000) * solPrice / 1e12
 */
function computeMcUsd(curve: BondingCurveData, solPrice: number): number {
  const pricePerTokenSol =
    (Number(curve.virtualSolReserves) / 1e9) /
    (Number(curve.virtualTokenReserves) / 1e6)
  const totalSupplyTokens = Number(curve.tokenTotalSupply) / 1e6
  return pricePerTokenSol * totalSupplyTokens * solPrice
}

// ── Class ──────────────────────────────────────────────────────────────────────

export class MoversPoller extends EventEmitter {
  private mintCache   = new Map<string, MintRecord>()   // mint → record
  private history     = new Map<string, Snap[]>()
  private movers      = new Map<string, MoverEntry>()
  // ALL coins found in the 8-14k MC range during the latest TZ scan (any age).
  // Separate from mintCache so young coins don't bloat or evict dormant candidates.
  private tzSnapshot: TzRaw[] = []
  // mint → timestamp of last dormant alert; allows re-alerting after 12h
  private dormantSeen = new Map<string, number>()
  private graduationEmitted       = new Set<string>()
  // Mints already persisted to dormant_candidates table (avoid redundant writes)
  private dormantCandidatesSaved  = new Set<string>()
  private discoverTimer:    NodeJS.Timeout | null = null
  private enrichTimer:      NodeJS.Timeout | null = null
  private externalTimer:    NodeJS.Timeout | null = null
  private targetZoneTimer:  NodeJS.Timeout | null = null
  // Rotates through all monitored programs each discover() call to spread Helius credit usage.
  // Cycle: PUMP_PROGRAM (bonding curve) → PUMP_AMM (pumpswap) → RAYDIUM_AMM → ORCA → repeat.
  // Each program is covered once per 4 × POLL_MS = 80 min at the default 20-min interval.
  private discoverIndex = 0
  private lastPollAt: number | null = null
  private lastError:  string | null = null
  private _conn:      Connection | null = null  // reuse to avoid GET_SLOT overhead

  private get heliusKey(): string  { return config.solana.heliusApiKey }
  private get heliusRpc(): string  { return config.solana.rpcUrl }

  private get conn(): Connection {
    if (!this._conn) this._conn = new Connection(this.heliusRpc, 'confirmed')
    return this._conn
  }

  start(): void {
    // Seed mint cache from DB before starting polling loops — this ensures dormant-age
    // tokens that were previously seen survive restarts and cache evictions.
    this.loadPersistedCandidates().catch(err =>
      console.error('[Movers] Failed to load dormant candidates:', err?.message)
    )

    // Kick both loops immediately on startup
    this.discover().catch(err => console.error('[Movers] discover error:', err?.message))
    this.enrich().catch(err => console.error('[Movers] enrich error:', err?.message))

    // Discovery — Helius Enhanced Txs (100 credits/call); interval set by MOVERS_POLL_MINUTES
    this.discoverTimer = setInterval(
      () => this.discover().catch(err => console.error('[Movers] discover error:', err?.message)),
      POLL_MS
    )
    // Enrichment — DexScreener (free) + bonding curve RPC (~1 credit/batch); interval set by MOVERS_ENRICH_SECONDS
    this.enrichTimer = setInterval(
      () => this.enrich().catch(err => console.error('[Movers] enrich error:', err?.message)),
      ENRICH_MS
    )
    // External movers scanner — discovers OLD tokens currently pumping via Birdeye/DexScreener
    // boosts/Axiom. Runs every 2 min. Catches tokens never seen in bonding-curve discovery.
    this.discoverExternalMovers().catch(err => console.error('[Movers] external scan error:', err?.message))
    this.externalTimer = setInterval(
      () => this.discoverExternalMovers().catch(err => console.error('[Movers] external scan error:', err?.message)),
      EXTERNAL_DISCOVER_MS
    )
    // Target Zone scanner — proactively pages pump.fun by MC desc to find dormant
    // coins in the $8K-$14K range that never trade (invisible to all other sources).
    // Delay first run by 30s so the initial enrich() cycle completes first.
    setTimeout(
      () => this.scanTargetZoneCoins().catch(err => console.error('[Movers] TZ scan error:', err?.message)),
      30_000
    )
    this.targetZoneTimer = setInterval(
      () => this.scanTargetZoneCoins().catch(err => console.error('[Movers] TZ scan error:', err?.message)),
      TARGET_ZONE_SCAN_MS
    )
    console.log(
      `[Movers] Poller started — discovery ${POLL_MS / 60_000} min, enrichment ${ENRICH_MS / 1_000} s, external scan 2 min, TZ scan ${TARGET_ZONE_SCAN_MS / 60_000} min`
    )
  }

  stop(): void {
    if (this.discoverTimer)   { clearInterval(this.discoverTimer);   this.discoverTimer   = null }
    if (this.enrichTimer)     { clearInterval(this.enrichTimer);     this.enrichTimer     = null }
    if (this.externalTimer)   { clearInterval(this.externalTimer);   this.externalTimer   = null }
    if (this.targetZoneTimer) { clearInterval(this.targetZoneTimer); this.targetZoneTimer = null }
  }

  getMovers(): MoverEntry[] { return Array.from(this.movers.values()) }

  getStatus() {
    return {
      count:      this.movers.size,
      lastPollAt: this.lastPollAt,
      lastError:  this.lastError,
    }
  }

  /**
   * Returns coins in the $8K-$14K MC band that are at least 30 days old.
   * Source: tzSnapshot populated by scanTargetZoneCoins() every 10 min.
   *
   * Each entry is enriched with DexScreener/bonding-curve data if the coin is
   * already tracked in `movers`; otherwise falls back to raw pump.fun API data
   * (MC, age, holders). The frontend UI can still apply additional MC filters.
   */
  getTargetZone(): MoverEntry[] {
    const now = Date.now()
    return this.tzSnapshot.map(raw => {
      // Prefer the fully-enriched MoverEntry when available (has DexScreener data)
      const live = this.movers.get(raw.mint)
      if (live) return live

      // Fall back to raw pump.fun data — no price changes or volume, but shows
      // name, age, MC, and holders which is enough for the watchlist.
      const ageHours = Math.floor((now - raw.createdAt) / 3_600_000)
      const entry: MoverEntry = {
        mint:        raw.mint,
        name:        raw.name,
        symbol:      raw.symbol,
        marketCap:   raw.pumpfunMc,
        ageHours,
        createdAt:   raw.createdAt,
        lastTradeAt: raw.lastTradeAt,
        change5m:    null,
        change1h:    null,
        change6h:    null,
        change24h:   null,
        volume24h:   null,
        txns24h:     null,
        graduated:   false,
        isDormant:   false,
        holderCount: raw.holderCount,
      }
      return entry
    })
  }

  // ── Target Zone holder count fetcher ─────────────────────────────────────
  // Calls pump.fun /coins/{mint} for each target-zone coin that hasn't had its
  // holder count refreshed within the TTL. Rate-limited to 300ms between calls.

  private async fetchTargetZoneHolderCounts(): Promise<void> {
    const now = Date.now()
    const candidates = Array.from(this.mintCache.entries()).filter(([mint, rec]) => {
      const entry = this.movers.get(mint)
      if (!entry) return false
      const ageDays = entry.ageHours / 24
      if (ageDays < TARGET_ZONE_AGE_DAYS) return false
      if (entry.marketCap < TARGET_ZONE_MIN_MC * 0.8 || entry.marketCap > TARGET_ZONE_MAX_MC * 1.3) return false
      // Skip if count is fresh enough
      if (rec.holderCountAt && (now - rec.holderCountAt) < HOLDER_COUNT_TTL_MS) return false
      return true
    })

    if (candidates.length === 0) return

    for (const [mint, rec] of candidates) {
      try {
        const res = await axios.get(`${PUMPFUN_COIN_API}/${mint}`, {
          timeout: 6_000,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        })
        const count = res.data?.holder_count
        if (typeof count === 'number') {
          rec.holderCount  = count
          rec.holderCountAt = Date.now()
          // Propagate to live MoverEntry so the API endpoint sees it immediately
          const entry = this.movers.get(mint)
          if (entry) entry.holderCount = count
        }
      } catch { /* non-fatal — skip this mint */ }
      // 300ms between requests to avoid hammering pump.fun
      await new Promise(r => setTimeout(r, 300))
    }
  }

  // ── Target Zone proactive scanner (every 10 min) ──────────────────────────
  // Pages through pump.fun sorted by market_cap DESC, collecting every coin that:
  //   • is in the MC target range (with a generous buffer for DexScreener corrections)
  //   • is old enough (>= TARGET_ZONE_AGE_DAYS)
  // These coins are typically NEVER traded — so they never appear in Helius discovery
  // or the external recent-trade scan. Without this scan, the target zone only shows
  // coins that happen to have been active recently, missing the true "sleeping" pool.
  //
  // Stopping heuristic: once an entire page has NO coin above the floor MC, we've
  // passed the target band and can stop paging early.

  private async scanTargetZoneCoins(): Promise<void> {
    const now = Date.now()
    // Generous MC window — pumpfunMc vs DexScreener FDV can differ; enrich() corrects it
    const scanFloor = TARGET_ZONE_MIN_MC * 0.4   // $3.2K
    const scanCeil  = TARGET_ZONE_MAX_MC * 3.0   // $42K

    // Fetch SOL price once for fallback MC computation.
    // pump.fun API sometimes omits usd_market_cap — in that case we compute it
    // from market_cap (SOL units) × solPrice so the stopping heuristic still works.
    const solPrice = await getSolPrice()

    // ── Strategy: sort by market_cap DESC ────────────────────────────────────
    // Pages from highest MC downward. We collect every coin in the scan window
    // ($3.2K–$42K) that is at least TARGET_ZONE_AGE_DAYS old.
    //
    // We do NOT use min/max_market_cap server-side — those params return a fixed
    // cap of ~22 results from pump.fun regardless of pagination. Instead we
    // filter MC client-side from the usd_market_cap field on each coin (with
    // a market_cap × solPrice fallback when usd_market_cap is absent).
    //
    // Two output paths:
    //   tzSnapshot  — coins strictly in [TARGET_ZONE_MIN_MC, TARGET_ZONE_MAX_MC]
    //                 AND at least TARGET_ZONE_AGE_DAYS old. Replaces previous
    //                 snapshot atomically at end.
    //   mintCache   — only 30+ day old coins, for dormant-alert tracking.
    //
    // Stop once an entire page is below the scan floor — no more target coins exist.
    let added = 0
    let pages = 0
    const freshTz: TzRaw[] = []  // accumulate strict-range coins (>= 30 days old)

    for (let page = 0; page < TARGET_ZONE_SCAN_PAGES; page++) {
      let coins: any[]
      try {
        const res = await axios.get(PUMPFUN_COINS_API, {
          params: {
            sort:        'market_cap',
            order:       'DESC',
            limit:       50,
            offset:      page * 50,
            includeNsfw: false,
          },
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          timeout: 10_000,
        })
        coins = Array.isArray(res.data) ? res.data : []
      } catch (err: any) {
        console.warn('[Movers] TZ scan error (page', page, '):', err?.message)
        break
      }
      if (coins.length === 0) break
      pages++

      let aboveFloor = 0
      for (const coin of coins) {
        // Use usd_market_cap when available; fall back to market_cap (SOL) × solPrice.
        const mc: number = (coin.usd_market_cap > 0)
          ? coin.usd_market_cap
          : (coin.market_cap > 0 ? coin.market_cap * solPrice : 0)
        if (mc >= scanFloor) aboveFloor++

        // Collect coins in the strict target band that are old enough for TZ
        if (mc >= TARGET_ZONE_MIN_MC && mc <= TARGET_ZONE_MAX_MC) {
          const mint: string | undefined = coin.mint
          const createdAt: number = coin.created_timestamp ?? now
          const ageDays = (now - createdAt) / (24 * 60 * 60_000)
          if (mint && mint !== WSOL && ageDays >= TARGET_ZONE_AGE_DAYS) {
            freshTz.push({
              mint,
              name:        coin.name   || mint.slice(0, 8),
              symbol:      coin.symbol || '?',
              createdAt,
              lastTradeAt: coin.last_trade_timestamp ?? createdAt,
              pumpfunMc:   mc,
              holderCount: typeof coin.holder_count === 'number' ? coin.holder_count : undefined,
            })
          }
        }

        // Seed mintCache only for 30+ day old coins (dormant-alert tracking)
        added += this.seedCoinToCache(coin, mc, scanFloor, scanCeil, now)
      }

      // Stop once the entire page is below the scan floor — no more target coins exist.
      if (aboveFloor === 0) break

      await new Promise(r => setTimeout(r, 120))
    }

    // Replace snapshot atomically so readers always see a complete list
    this.tzSnapshot = freshTz

    console.log(`[Movers] TZ scan: ${pages} pages, +${added} mintCache new, ${freshTz.length} in TZ snapshot → cache ${this.mintCache.size}`)
  }

  /** Seed a pump.fun coin API response object into mintCache if it's in the scan window.
   *  Returns 1 if a new entry was added, 0 otherwise. */
  private seedCoinToCache(
    coin: any, mc: number,
    scanFloor: number, scanCeil: number,
    now: number
  ): number {
    if (mc < scanFloor || mc > scanCeil) return 0
    const mint: string | undefined = coin.mint
    if (!mint || mint === WSOL) return 0
    // Only seed coins old enough for Target Zone — avoids bloating mintCache with
    // young coins that getTargetZone() would immediately reject.
    const createdAt: number = coin.created_timestamp ?? now
    const ageDays = (now - createdAt) / (24 * 60 * 60_000)
    if (ageDays < TARGET_ZONE_AGE_DAYS) return 0

    const existing = this.mintCache.get(mint)
    if (existing) {
      // Refresh stale holder count
      if (typeof coin.holder_count === 'number' &&
          (!existing.holderCountAt || now - existing.holderCountAt > HOLDER_COUNT_TTL_MS)) {
        existing.holderCount   = coin.holder_count
        existing.holderCountAt = now
      }
      const lastTrade: number = coin.last_trade_timestamp ?? 0
      if (lastTrade > existing.lastTradeAt) existing.lastTradeAt = lastTrade
      // Keep pump.fun MC fresh so enrich() has a fallback
      if (mc > 0) existing.pumpfunMc = mc
      return 0
    }

    this.mintCache.set(mint, {
      name:            coin.name   || mint.slice(0, 8),
      symbol:          coin.symbol || '?',
      firstSeen:       createdAt,
      lastTradeAt:     coin.last_trade_timestamp ?? createdAt,
      graduated:       false,
      metadataFetched: true,
      seenCount:       2,
      holderCount:     typeof coin.holder_count === 'number' ? coin.holder_count : undefined,
      holderCountAt:   typeof coin.holder_count === 'number' ? now : undefined,
      pumpfunMc:       mc > 0 ? mc : undefined,
    })
    return 1
  }

  // ── External movers scan (every 2 min) ────────────────────────────────────
  // Finds OLD tokens currently pumping via external data sources. This is the
  // critical path for tokens like "Happy Birthday Solana" or DIEGO (1y) that
  // are graduated, trading on Raydium, and thus invisible to bonding-curve discovery.

  private async discoverExternalMovers(): Promise<void> {
    const mints = new Set<string>()

    // Helper: extract base token mint from GeckoTerminal pool entry.
    // relationship id is formatted as "solana_<mint_address>"
    const extractGeckoMint = (entry: any): string | undefined => {
      const id: string = entry?.relationships?.base_token?.data?.id ?? ''
      const addr = id.startsWith('solana_') ? id.slice(7) : ''
      return addr && addr !== WSOL ? addr : undefined
    }

    // 1. Raydium v3 pools API — the primary "from Solana chain" source for non-pump.fun pairs.
    //    Returns ALL Raydium pool types (Standard AMM / CLMM / CPMM) sorted by 24h volume.
    //    3 pages × 100 pools = up to 300 active Raydium pairs per cycle.
    //    This replaces the pump.fun-only discovery that was capped at ~22 results.
    {
      let raydiumAdded = 0
      for (let page = 1; page <= 3; page++) {
        try {
          const res = await axios.get(RAYDIUM_POOLS_API, {
            params: {
              poolType:      'all',
              poolSortField: 'volume24h',
              sortType:      'desc',
              pageSize:      100,
              page,
            },
            headers: { Accept: 'application/json' },
            timeout: 12_000,
          })
          const pools: any[] = res.data?.data?.data ?? []
          for (const pool of pools) {
            // Each pool has mintA + mintB; add whichever side isn't a stablecoin/SOL
            for (const addr of [pool.mintA?.address, pool.mintB?.address]) {
              if (addr && !STABLECOINS.has(addr)) { mints.add(addr); raydiumAdded++ }
            }
          }
          if (pools.length < 100) break  // last page
        } catch (err: any) {
          console.warn(`[Movers] External Raydium pools page ${page} error:`, err?.message)
          break
        }
      }
      if (raydiumAdded > 0) console.log(`[Movers] External: Raydium pools API added ${raydiumAdded} tokens`)
    }

    // 2. GeckoTerminal trending pools — free, no auth, covers ALL Solana DEXes including old Raydium.
    //    Paginate 3 pages = up to 60 trending pools (previously only 1 page = 20).
    {
      let trendAdded = 0
      for (let page = 1; page <= 3; page++) {
        try {
          const res = await axios.get(`${GECKO_TRENDING_BASE}?page=${page}`, {
            headers: { Accept: 'application/json' },
            timeout: 10_000,
          })
          const pools: any[] = res.data?.data ?? []
          for (const pool of pools) {
            const mint = extractGeckoMint(pool)
            if (mint) { mints.add(mint); trendAdded++ }
          }
          if (pools.length < 20) break  // last page
        } catch (err: any) {
          console.warn(`[Movers] External GeckoTerminal trending page ${page} error:`, err?.message)
          break
        }
      }
      console.log(`[Movers] External: GeckoTerminal trending returned ${trendAdded} tokens`)
    }

    // 3. GeckoTerminal new pools — recently created Solana pairs across ALL DEXes.
    //    Catches brand-new tokens immediately after their pool is created on any DEX.
    try {
      const res = await axios.get(GECKO_NEW_POOLS_URL, {
        headers: { Accept: 'application/json' },
        timeout: 10_000,
      })
      let newAdded = 0
      for (const pool of (res.data?.data ?? [])) {
        const mint = extractGeckoMint(pool)
        if (mint) { mints.add(mint); newAdded++ }
      }
      if (newAdded > 0) console.log(`[Movers] External: GeckoTerminal new pools added ${newAdded} tokens`)
    } catch (err: any) {
      console.warn('[Movers] External GeckoTerminal new pools error:', err?.message)
    }

    // 4. GeckoTerminal top-volume pools (pages 1-3 = 60 pools) — h24_volume_usd_desc is
    //    a confirmed-valid sort. High 24h volume reliably captures active movers on any DEX.
    {
      let volAdded = 0
      for (let page = 1; page <= 3; page++) {
        try {
          const res = await axios.get(`${GECKO_VOLUME_BASE}&page=${page}`, {
            headers: { Accept: 'application/json' },
            timeout: 10_000,
          })
          for (const pool of (res.data?.data ?? [])) {
            const mint = extractGeckoMint(pool)
            if (mint) { mints.add(mint); volAdded++ }
          }
        } catch (err: any) {
          console.warn(`[Movers] External GeckoTerminal vol page ${page} error:`, err?.message)
          break
        }
      }
      console.log(`[Movers] External: GeckoTerminal volume scan returned ${volAdded} tokens`)
    }

    // 5. Pump.fun coins API — recently-active pump.fun tokens (free, no auth).
    //    Covers tokens still on the bonding curve + recently-graduated.
    try {
      const res = await axios.get(PUMPFUN_COINS_API, {
        params: { sort: 'last_trade_timestamp', order: 'DESC', limit: 50, includeNsfw: false },
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        timeout: 8_000,
      })
      const coins: any[] = Array.isArray(res.data) ? res.data : []
      let added = 0
      for (const coin of coins) {
        const mint: string | undefined = coin.mint
        if (mint && mint !== WSOL) {
          mints.add(mint)
          added++
          // Opportunistically cache holder_count if the API returned it
          if (typeof coin.holder_count === 'number') {
            const rec = this.mintCache.get(mint)
            if (rec && (!rec.holderCountAt || Date.now() - rec.holderCountAt > HOLDER_COUNT_TTL_MS)) {
              rec.holderCount   = coin.holder_count
              rec.holderCountAt = Date.now()
            }
          }
        }
      }
      if (added > 0) console.log(`[Movers] External: pump.fun coins API returned ${added} tokens`)
    } catch (err: any) {
      console.warn('[Movers] External pump.fun coins error:', err?.message)
    }

    // 6. DexScreener paid boosts — minor supplement, mostly promoted tokens.
    try {
      const res = await axios.get(DEX_BOOSTS_API, {
        timeout: 8_000,
        headers: { 'User-Agent': 'PumpAlert/1.0' },
      })
      for (const boost of (res.data ?? [])) {
        if (boost.chainId === 'solana' && boost.tokenAddress) mints.add(boost.tokenAddress)
      }
    } catch { /* non-critical */ }

    // 7. Birdeye — only used if API key is configured (paid)
    if (config.birdeye.apiKey) {
      try {
        const res = await axios.get(BIRDEYE_TOKENLIST_API, {
          params: { sort_by: 'v24hChangePercent', sort_type: 'desc', limit: 50, min_liquidity: 100 },
          headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': 'solana' },
          timeout: 10_000,
        })
        for (const token of (res.data?.data?.tokens ?? [])) {
          if (token.address && token.address !== WSOL) mints.add(token.address)
        }
      } catch (err: any) {
        console.warn('[Movers] External Birdeye error:', err?.message)
      }
    }

    // Add newly-discovered mints to cache — enrichment will compute real age from DexScreener
    const now = Date.now()
    let added = 0
    for (const mint of mints) {
      if (!this.mintCache.has(mint)) {
        this.mintCache.set(mint, {
          name:            mint.slice(0, 8),
          symbol:          '?',
          firstSeen:       now,       // corrected to real pairCreatedAt by enrich()
          lastTradeAt:     now,
          graduated:       true,      // externally-discovered = likely graduated
          metadataFetched: false,
          seenCount:       2,         // skip single-poll metadata gate
        })
        added++
      }
    }
    if (added > 0) {
      console.log(`[Movers] External scan: added ${added} new mints (${mints.size} total from all sources)`)
    }
  }

  // ── Startup: seed cache from persisted dormant candidates ─────────────────

  private async loadPersistedCandidates(): Promise<void> {
    try {
      const saved = await db.getDormantCandidates()
      let loaded = 0
      for (const c of saved) {
        this.dormantCandidatesSaved.add(c.mint)
        if (!this.mintCache.has(c.mint)) {
          this.mintCache.set(c.mint, {
            name:            c.name,
            symbol:          c.symbol,
            firstSeen:       c.firstSeen,
            lastTradeAt:     c.firstSeen,   // enrichment will update via DexScreener txns
            graduated:       false,
            metadataFetched: true,           // name/symbol already known
            seenCount:       2,             // skip single-poll metadata gate
          })
          loaded++
        }
      }
      if (loaded > 0) console.log(`[Movers] Seeded ${loaded} dormant candidates from DB`)
    } catch (err: any) {
      console.warn('[Movers] Could not load dormant candidates:', err?.message)
    }
  }

  // ── Discovery — find new mints via Helius Enhanced Txs on all major Solana DEXes ──
  // Rotates through 4 programs each cycle (one per call) to cover ALL Solana trading:
  //   0. Pump bonding curve — pre-graduation SWAPs (new/young pump.fun tokens)
  //   1. Pump AMM (pumpswap) — post-graduation SWAPs (graduated pump.fun tokens, any age)
  //   2. Raydium AMM V4 — the dominant Solana DEX for non-pump.fun / legacy pairs
  //   3. Orca Whirlpool — concentrated-liquidity DEX; catches tokens not on Raydium
  // At the default 20-min POLL_MS, each program is covered once every 80 min.
  // The external movers scan (every 2 min) keeps enrichment fast between Helius cycles.

  private async discover(): Promise<void> {
    if (!this.heliusKey) {
      this.lastError = 'HELIUS_API_KEY not set'
      console.warn('[Movers] HELIUS_API_KEY not set — skipping discover')
      return
    }
    const programs: Array<{ addr: string; graduated: boolean; label: string }> = [
      { addr: PUMP_PROGRAM_STR,   graduated: false, label: 'Pump bonding curve' },
      { addr: PUMP_AMM_STR,       graduated: true,  label: 'Pump AMM'           },
      { addr: RAYDIUM_AMM_STR,    graduated: true,  label: 'Raydium AMM V4'     },
      { addr: ORCA_WHIRLPOOL_STR, graduated: true,  label: 'Orca Whirlpool'     },
    ]
    const prog = programs[this.discoverIndex % programs.length]
    this.discoverIndex++
    await this.fetchRecentMints(prog.addr, prog.graduated)
  }

  // ── Enrichment (2 min) — refresh MC/price for all known mints ─────────────

  private async enrich(): Promise<void> {
    if (this.mintCache.size === 0) return

    const now      = Date.now()
    const solPrice = await getSolPrice()

    // 2. Enrich graduated tokens via DexScreener.
    // Skip mints that are known bonding-curve coins (graduated=false + pumpfunMc set) —
    // DexScreener has no pair for them and including them just wastes batch slots and
    // triggers rate limiting when the cache contains hundreds of TZ scanner coins.
    const allMints  = Array.from(this.mintCache.keys())
    const dexMints  = allMints.filter(m => {
      const rec = this.mintCache.get(m)!
      return rec.graduated || rec.pumpfunMc === undefined
    })
    const dexMap   = await this.fetchDexData(dexMints)

    // 3. Bonding curve state for mints not found on DexScreener.
    // Skip coins that already have a pumpfunMc fallback — fetching the bonding curve
    // for those is unnecessary and wastes Helius RPC credits (especially after the
    // Target Zone scanner seeds hundreds of bonding-curve coins into mintCache).
    const nonGrad  = allMints.filter(m => !dexMap.has(m))
    const needCurve = nonGrad.filter(m => !this.mintCache.get(m)?.pumpfunMc)
    const curveMap = await this.fetchBondingCurves(needCurve)

    // 4. Token metadata (name/symbol) — only for non-graduated mints above the MC
    //    threshold that haven't had metadata fetched yet (saves TOKENS_METADATA_V2 credits).
    // Coins from pump.fun scan already have metadataFetched=true so they're excluded.
    const needMeta = needCurve.filter(m => {
      const rec = this.mintCache.get(m)
      if (!rec || rec.metadataFetched) return false
      if (rec.name && rec.name !== m.slice(0, 8)) return false
      if (rec.seenCount < 2) return false
      const curve = curveMap.get(m)
      if (!curve) return false
      const mc = computeMcUsd(curve, solPrice)
      return mc >= MIN_MC_USD
    })
    if (needMeta.length > 0) await this.fetchTokenMetadata(needMeta)

    // 4.5 Propagate twitter handles from DexScreener to mintCache (graduated tokens)
    for (const [mint, dex] of dexMap) {
      const rec = this.mintCache.get(mint)
      if (rec && dex.twitterHandle && !rec.twitterHandle) rec.twitterHandle = dex.twitterHandle
    }

    // 4.6 Twitter widget API — community follower counts (free, no auth)
    await this.fetchCommunityFollowers(allMints)

    // 5. Build MoverEntry for every mint in cache
    let updated = 0
    for (const mint of allMints) {
      const rec   = this.mintCache.get(mint)!
      const dex   = dexMap.get(mint)
      const curve = curveMap.get(mint)

      // Skip if we have no usable data or below the MC threshold (pump.fun + $2.9K filter)
      const graduated = dex ? true : (curve?.complete ?? rec.graduated)
      // MC priority: DexScreener FDV > bonding-curve on-chain > pump.fun API snapshot
      // The pump.fun fallback is critical for bonding-curve coins not yet on DexScreener —
      // without it, coins seeded by the Target Zone scanner are silently dropped here.
      const mc = dex?.fdv ?? (curve ? computeMcUsd(curve, solPrice) : (rec.pumpfunMc ?? 0))
      if (!mc || mc < MIN_MC_USD) continue

      // Creation timestamp: DexScreener pairCreatedAt is the best proxy.
      // Also correct rec.firstSeen so that eviction protection uses the real token age —
      // externally-discovered tokens start with firstSeen = now until this correction runs.
      if (dex?.pairCreatedAt && dex.pairCreatedAt < rec.firstSeen) {
        rec.firstSeen = dex.pairCreatedAt
      }
      const createdAt  = dex?.pairCreatedAt ?? rec.firstSeen
      const lastTradeAt = rec.lastTradeAt
      const ageMs    = now - createdAt
      const ageHours = Math.floor(ageMs / (60 * 60_000))
      const ageDays  = ageHours / 24

      // MC history snapshot → computed price changes (fallback for non-graduated)
      this.addSnap(mint, now, mc)
      const computed = this.computeChanges(mint, now)

      // Track floor MC (informational — shown on dashboard, not used for alert gating)
      if (rec.floorMc === undefined || mc < rec.floorMc) rec.floorMc = mc

      const change5m  = dex?.priceChange?.m5  ?? computed.c5m
      const change1h  = dex?.priceChange?.h1  ?? computed.c1h
      const change6h  = dex?.priceChange?.h6  ?? computed.c6h
      const change24h = dex?.priceChange?.h24 ?? computed.c24h

      // Net positive buy pressure: more buys than sells in 24h.
      // If DexScreener has no txn data (bonding curve / no dex pair), allow through.
      const buys  = dex?.txns?.h24?.buys  ?? null
      const sells = dex?.txns?.h24?.sells ?? null
      const hasBuyPressure = buys === null || buys >= (sells ?? 0)

      // For graduated tokens, DexScreener's own txns24h.buys tells us if the token
      // traded recently without waiting for the next discovery cycle to update lastTradeAt.
      const hasRecentActivity =
        lastTradeAt > now - 24 * 60 * 60_000 ||
        (graduated && (dex?.txns?.h24?.buys ?? 0) > 0)

      const meetsThreshold =
        ageDays >= DORMANT_AGE_DAYS &&        // old/dormant token
        hasRecentActivity &&                   // actively trading now
        mc <= DORMANT_MAX_WAKE_MC &&           // still at low MC — good entry point (<$10K)
        hasBuyPressure &&                      // net positive buy volume
        // Upward price movement only — crash/rug is not a wakeup.
        // 5m is the primary sensitivity window: catches the first candle of a wakeup.
        ((change5m  ?? 0) >= DORMANT_MOVE_5M  ||
         (change1h  ?? 0) >= DORMANT_MOVE_1H  ||
         (change6h  ?? 0) >= DORMANT_MOVE_6H  ||
         (change24h ?? 0) >= DORMANT_MOVE_24H)

      // Pin isDormant = true for 2h after an alert fires so the token stays visible
      // on the dashboard "Dormant" tab. Without this, the flag flips to false as soon
      // as DexScreener's 1h candle rolls below the threshold — making it disappear from
      // the UI immediately after the Telegram alert sends.
      const lastDormantAt = this.dormantSeen.get(mint) ?? 0
      const pinnedDormant  = now - lastDormantAt < 2 * 60 * 60_000
      const isDormant      = meetsThreshold || pinnedDormant

      const entry: MoverEntry = {
        mint,
        name:      dex?.name   ?? rec.name,
        symbol:    dex?.symbol ?? rec.symbol,
        marketCap: mc,
        ageHours,
        createdAt,
        lastTradeAt,
        change5m:  dex?.priceChange?.m5  ?? computed.c5m,
        change1h,
        change6h,
        change24h,
        volume24h: dex?.volume?.h24      ?? null,
        txns24h:   dex
          ? ((dex.txns?.h24?.buys ?? 0) + (dex.txns?.h24?.sells ?? 0))
          : null,
        graduated,
        isDormant,
        dormantFloorMc:     rec.floorMc,
        pairAddress:        dex?.pairAddress || undefined,
        twitterHandle:      rec.twitterHandle,
        communityFollowers: rec.communityFollowers,
        holderCount:        rec.holderCount,
      }

      // Keep mintCache name/symbol up-to-date
      if (dex) {
        rec.name     = dex.name
        rec.symbol   = dex.symbol
        rec.graduated = true
      }

      this.movers.set(mint, entry)
      updated++

      // Persist dormant candidates to DB the first time they reach 25+ days old.
      // This ensures they re-enter the mint cache on restart and are never permanently
      // evicted — critical for catching graduated tokens (Raydium) that don't appear
      // in bonding-curve discovery transactions.
      if (ageDays >= DORMANT_AGE_DAYS && !this.dormantCandidatesSaved.has(mint)) {
        this.dormantCandidatesSaved.add(mint)
        db.upsertDormantCandidate(mint, entry.name, entry.symbol, createdAt).catch(() => {})
      }

      if (meetsThreshold && now - lastDormantAt > 12 * 60 * 60_000) {
        this.dormantSeen.set(mint, now)
        this.emit('dormant', entry)
        console.log(
          `[Movers] 👴 Dormant wakeup: ${entry.name} (${mint.slice(0, 8)}) ` +
          `age ${Math.floor(ageDays)}d 1h=${change1h?.toFixed(1)}%`
        )
      }

      // Emit 'graduated' once per mint so OG radar can check it
      if (entry.graduated && entry.marketCap > 0 &&
          entry.name && entry.name !== 'Unknown') {
        if (!this.graduationEmitted.has(mint)) {
          this.graduationEmitted.add(mint)
          this.emit('graduated', mint, entry.name, entry.symbol, entry.marketCap)
        }
      }
    }

    this.lastPollAt = Date.now()
    this.lastError  = null
    console.log(
      `[Movers] Enriched ${updated}/${allMints.length} tokens ` +
      `(${dexMap.size} DexScreener, ${curveMap.size} bonding-curve)`
    )

    // Fetch holder counts for target-zone candidates (async, non-blocking)
    this.fetchTargetZoneHolderCounts().catch(() => {})
  }

  // ── Step 1: Helius Enhanced Transactions ────────────────────────────────────
  // Called twice per discovery cycle: once for the bonding curve (pre-graduation)
  // and once for the pump AMM (post-graduation). Together they cover every
  // pump.fun token that has traded recently, regardless of age.

  private async fetchRecentMints(programStr: string, isGraduated: boolean): Promise<void> {
    try {
      const res = await axios.get(
        `${HELIUS_API}/addresses/${programStr}/transactions`,
        {
          params: { 'api-key': this.heliusKey, limit: 100, type: 'SWAP' },
          timeout: 20_000,
        }
      )

      const txList: any[] = Array.isArray(res.data) ? res.data : []
      const now = Date.now()
      let newMints = 0

      for (const tx of txList) {
        const txTs: number = tx.timestamp ? tx.timestamp * 1000 : now

        for (const t of tx.tokenTransfers ?? []) {
          const mint: string | undefined = t.mint
          if (!mint || mint === WSOL) continue

          const existing = this.mintCache.get(mint)
          if (existing) {
            if (txTs > existing.lastTradeAt) existing.lastTradeAt = txTs
            if (isGraduated) existing.graduated = true
            existing.seenCount++
          } else {
            this.mintCache.set(mint, {
              name:            mint.slice(0, 8),   // placeholder until metadata loaded
              symbol:          '?',
              firstSeen:       txTs,
              lastTradeAt:     txTs,
              graduated:       isGraduated,
              metadataFetched: false,
              seenCount:       1,
            })
            newMints++
          }
        }
      }

      // Evict entries if cache is over the limit.
      // CRITICAL: protect dormant candidates (age >= DORMANT_AGE_DAYS) from eviction —
      // they must stay in cache so the enrichment cycle can detect when they wake up.
      // Evict young tokens (< DORMANT_AGE_DAYS) sorted by least-recently-active first.
      if (this.mintCache.size > MAX_MINT_CACHE) {
        const dormantAgeMs = DORMANT_AGE_DAYS * 24 * 60 * 60_000
        const evictNow = Date.now()
        const sorted = Array.from(this.mintCache.entries())
          .sort((a, b) => {
            const aOld = (evictNow - a[1].firstSeen) >= dormantAgeMs
            const bOld = (evictNow - b[1].firstSeen) >= dormantAgeMs
            if (aOld && !bOld) return 1   // protect a — sort to end
            if (!aOld && bOld) return -1  // protect b — sort to end
            return a[1].lastTradeAt - b[1].lastTradeAt  // evict youngest-inactive first
          })
        const toRemove = sorted.slice(0, this.mintCache.size - MAX_MINT_CACHE)
        for (const [m] of toRemove) {
          this.mintCache.delete(m)
          this.history.delete(m)
          this.movers.delete(m)
          this.graduationEmitted.delete(m)
        }
      }

      const label = isGraduated ? 'Pump AMM' : 'Bonding curve'
      console.log(`[Movers] Helius ${label}: ${txList.length} txs, ${newMints} new mints → ${this.mintCache.size} total`)
    } catch (err: any) {
      const status = err?.response?.status ?? 'net'
      const msg    = `[${status}] ${err?.message}`
      console.warn('[Movers] Helius Enhanced Tx error:', msg)
      this.lastError = msg
    }
  }

  // ── Step 2: DexScreener enrichment ─────────────────────────────────────────

  private async fetchDexData(mints: string[]): Promise<Map<string, DexPairData>> {
    const result = new Map<string, DexPairData>()
    if (mints.length === 0) return result

    const BATCH = 30
    let errors = 0
    for (let i = 0; i < mints.length; i += BATCH) {
      const batch = mints.slice(i, i + BATCH)
      try {
        const res   = await axios.get(`${DEX_API}/${batch.join(',')}`, {
          timeout: 10_000,
          headers: { 'User-Agent': 'PumpAlert/1.0' },
        })
        const pairs: any[] = res.data?.pairs ?? []
        for (const pair of pairs) {
          if (pair.chainId !== 'solana' || !pair.baseToken?.address) continue
          const addr = pair.baseToken.address as string
          const prev = result.get(addr)
          const liq  = pair.liquidity?.usd ?? 0
          if (!prev || liq > prev.liquidityUsd) {
            const twitterUrl    = pair.info?.socials?.find((s: any) => s.type === 'twitter')?.url
            const twitterHandle = twitterUrl ? parseTwitterHandle(twitterUrl) : undefined
            result.set(addr, {
              name:           pair.baseToken.name   ?? '',
              symbol:         pair.baseToken.symbol ?? '',
              fdv:            pair.fdv               ?? null,
              pairAddress:    pair.pairAddress       ?? '',
              pairCreatedAt:  pair.pairCreatedAt     ?? null,
              priceChange:    pair.priceChange        ?? null,
              volume:         pair.volume             ?? null,
              txns:           pair.txns               ?? null,
              liquidityUsd:   liq,
              twitterHandle,
            })
          }
        }
      } catch (err: any) {
        errors++
        console.warn(`[Movers] DexScreener batch ${i / BATCH + 1} error:`, err?.message)
        // Back off on rate-limit (429) or server errors; continue with remaining batches
        if (err?.response?.status === 429 || (err?.response?.status ?? 0) >= 500) {
          await new Promise(r => setTimeout(r, 2_000))
        }
      }
      // Throttle between batches to stay within DexScreener's rate limit
      if (i + BATCH < mints.length) await new Promise(r => setTimeout(r, 200))
    }

    if (errors > 0) console.warn(`[Movers] DexScreener: ${errors} batch error(s), ${result.size} tokens enriched`)
    return result
  }

  // ── Step 3: Bonding curve on-chain state ───────────────────────────────────

  private async fetchBondingCurves(
    mints: string[]
  ): Promise<Map<string, BondingCurveData>> {
    const result = new Map<string, BondingCurveData>()
    if (mints.length === 0) return result

    try {
      const BATCH = 100   // getMultipleAccountsInfo limit

      for (let i = 0; i < mints.length; i += BATCH) {
        const batch = mints.slice(i, i + BATCH)
        const pdas  = batch.map(m => getBondingCurvePda(m))
        const infos = await this.conn.getMultipleAccountsInfo(pdas)

        for (let j = 0; j < batch.length; j++) {
          const info = infos[j]
          if (!info?.data) continue
          const curve = parseBondingCurve(Buffer.from(info.data))
          if (curve) result.set(batch[j], curve)
        }
      }
    } catch (err: any) {
      console.warn('[Movers] Bonding curve fetch error:', err?.message)
    }

    return result
  }

  // ── Step 4: Helius token metadata (name / symbol) ─────────────────────────

  private async fetchTokenMetadata(mints: string[]): Promise<void> {
    if (mints.length === 0) return
    try {
      const res = await axios.post(
        `${HELIUS_API}/token-metadata?api-key=${this.heliusKey}`,
        { mintAccounts: mints.slice(0, 100) },
        { timeout: 10_000 }
      )
      for (const item of res.data ?? []) {
        if (!item.account) continue
        const rec = this.mintCache.get(item.account)
        if (!rec) continue

        // Helius returns on-chain Metaplex metadata (name/symbol) + off-chain IPFS JSON
        const d = item.onChainMetadata?.metadata?.data ?? item.legacyMetadata
        if (d) {
          rec.name   = (d.name   ?? '').replace(/\0/g, '').trim() || rec.name
          rec.symbol = (d.symbol ?? '').replace(/\0/g, '').trim() || rec.symbol
        }
        // Off-chain metadata (IPFS JSON) contains twitter/website/telegram set at mint time
        const offChain = item.offChainMetadata?.metadata
        if (offChain?.twitter && !rec.twitterHandle) {
          rec.twitterHandle = parseTwitterHandle(offChain.twitter) ?? undefined
        }
        rec.metadataFetched = true  // don't re-fetch next poll
      }
    } catch (err: any) {
      console.warn('[Movers] Token metadata error:', err?.message)
    }
  }

  // ── Step 5: Twitter community followers (widget API, no auth) ──────────────

  private async fetchCommunityFollowers(mints: string[]): Promise<void> {
    const now = Date.now()
    const TTL = 2 * 60 * 60_000  // re-check followers every 2 hours

    const toCheck: { mint: string; handle: string }[] = []
    for (const mint of mints) {
      const rec = this.mintCache.get(mint)
      if (!rec?.twitterHandle) continue
      if (rec.communityCheckedAt && (now - rec.communityCheckedAt) < TTL) continue
      toCheck.push({ mint, handle: rec.twitterHandle })
    }
    if (toCheck.length === 0) return

    const BATCH = 100
    const WIDGET = 'https://cdn.syndication.twimg.com/widgets/followbutton/info.json'

    for (let i = 0; i < toCheck.length; i += BATCH) {
      const batch = toCheck.slice(i, i + BATCH)
      try {
        const res = await axios.get<Array<{ screen_name: string; followers_count: number }>>(
          `${WIDGET}?screen_names=${batch.map(x => x.handle).join(',')}`,
          { timeout: 8_000, headers: { 'User-Agent': 'PumpAlert/1.0' } }
        )
        const byHandle = new Map((res.data ?? []).map(r => [r.screen_name?.toLowerCase(), r.followers_count]))
        for (const { mint, handle } of batch) {
          const rec = this.mintCache.get(mint)
          if (!rec) continue
          rec.communityFollowers = byHandle.get(handle.toLowerCase()) ?? 0
          rec.communityCheckedAt = now
        }
      } catch (err: any) {
        console.warn('[Movers] Twitter widget error:', err?.message)
      }
    }
  }

  // ── History helpers ─────────────────────────────────────────────────────────

  private addSnap(mint: string, ts: number, mc: number): void {
    if (!this.history.has(mint)) this.history.set(mint, [])
    const snaps = this.history.get(mint)!
    snaps.push({ ts, mc })
    const cutoff = ts - HISTORY_MAX_MS
    while (snaps.length > 0 && snaps[0].ts < cutoff) snaps.shift()
  }

  private computeChanges(mint: string, now: number) {
    const snaps   = this.history.get(mint) ?? []
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
}

// ── Meta Radar ───────────────────────────────────────────────────────────────

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a lowercase Twitter/X handle from a URL or bare handle string. */
function parseTwitterHandle(input: string): string | undefined {
  if (!input) return undefined
  try {
    const u = new URL(input)
    const parts = u.pathname.split('/').filter(Boolean)
    const handle = parts[0]?.toLowerCase()
    // Skip non-handle URL paths (e.g. twitter.com/intent/tweet)
    if (handle && !['intent', 'share', 'search', 'hashtag', 'i'].includes(handle)) {
      return handle
    }
  } catch {
    // Not a URL — treat as bare handle (strip leading @)
    const bare = input.replace(/^@/, '').trim().toLowerCase()
    if (bare && /^[a-z0-9_]{1,50}$/.test(bare)) return bare
  }
  return undefined
}
