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
const WSOL             = 'So11111111111111111111111111111111111111112'

const HELIUS_API = 'https://api.helius.xyz/v0'
const DEX_API    = 'https://api.dexscreener.com/latest/dex/tokens'
const CMC_API    = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest'

// External discovery — fallback sources for old Raydium tokens (pre-pumpswap graduates)
const BIRDEYE_TOKENLIST_API  = 'https://public-api.birdeye.so/defi/tokenlist'
const DEX_BOOSTS_API         = 'https://api.dexscreener.com/token-boosts/active/v1'
// Axiom meme-trending — the exact endpoint powering the Axiom Movers tab.
// Requires a valid AXIOM_COOKIE. Response fields: tokenAddress, tokenName, priceChange24h, etc.
// Source: AxiomTradeAPI-py SDK (https://github.com/ChipaDevTeam/AxiomTradeAPI-py)
const AXIOM_TRENDING_URL     = 'https://api6.axiom.trade/meme-trending?timePeriod=1h'
const EXTERNAL_DISCOVER_MS   = 5 * 60_000  // every 5 minutes

// Configurable via env vars — increase to save Helius credits at the cost of slower new-mint discovery.
// Note: enrichment (DexScreener, no Helius) still runs every 60s regardless, so price data stays fresh.
// Only new-mint *discovery* is delayed when this is raised.
const POLL_MS          = (parseInt(process.env.MOVERS_POLL_MINUTES   ?? '20') || 20) * 60_000   // default 20 min (was 5)
const ENRICH_MS        = (parseInt(process.env.MOVERS_ENRICH_SECONDS ?? '60') || 60) * 1_000    // default 60s
const DORMANT_AGE_DAYS    = 25
const DORMANT_MOVE_1H     = 30        // % threshold
const DORMANT_MOVE_6H     = 60        // % threshold
const DORMANT_MOVE_24H    = 25        // % threshold — catches slow-build wakeups
// Only alert/flag dormant tokens whose current MC is at or below this value.
// Coins waking up from $125K are not useful entry opportunities — we want bottom catches.
// Override with env: DORMANT_MAX_WAKE_MC (in USD)
const DORMANT_MAX_WAKE_MC = parseInt(process.env.DORMANT_MAX_WAKE_MC ?? '5000') || 5000
const HISTORY_MAX_MS   = 25 * 60 * 60_000  // 25 h of MC snapshots
const MAX_MINT_CACHE   = 1000         // rolling window of known mints (larger = fewer evictions of old dormant tokens)
const MIN_MC_USD       = 2_900        // ignore tokens below $2.9K market cap

// ── Internal types ─────────────────────────────────────────────────────────────

interface MintRecord {
  name:               string
  symbol:             string
  firstSeen:          number   // epoch ms — proxy for token creation time
  lastTradeAt:        number   // epoch ms — most recent observed trade
  graduated:          boolean
  metadataFetched:    boolean  // true once Helius metadata has been loaded
  seenCount:          number   // polls in which this mint has appeared
  twitterHandle?:     string   // resolved from DexScreener socials or IPFS metadata
  communityFollowers?: number  // from Twitter widget API
  communityCheckedAt?: number  // epoch ms — last widget API check
  floorMc?:           number   // lowest MC ever observed in-cache — used for dormant entry-quality filter
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
  // mint → timestamp of last dormant alert; allows re-alerting after 12h
  private dormantSeen = new Map<string, number>()
  private graduationEmitted       = new Set<string>()
  // Mints already persisted to dormant_candidates table (avoid redundant writes)
  private dormantCandidatesSaved  = new Set<string>()
  private discoverTimer:  NodeJS.Timeout | null = null
  private enrichTimer:    NodeJS.Timeout | null = null
  private externalTimer:  NodeJS.Timeout | null = null
  // Alternates which program is polled each discover() call to halve Helius Enhanced Tx credits.
  // Cycle 1 → PUMP_PROGRAM (bonding curve), Cycle 2 → PUMP_AMM (graduated), repeat.
  private discoverFlip = false
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
    // boosts/Axiom. Runs every 5 min. Catches tokens never seen in bonding-curve discovery.
    this.discoverExternalMovers().catch(err => console.error('[Movers] external scan error:', err?.message))
    this.externalTimer = setInterval(
      () => this.discoverExternalMovers().catch(err => console.error('[Movers] external scan error:', err?.message)),
      EXTERNAL_DISCOVER_MS
    )
    console.log(
      `[Movers] Poller started — discovery ${POLL_MS / 60_000} min, enrichment ${ENRICH_MS / 1_000} s, external scan 5 min`
    )
  }

  stop(): void {
    if (this.discoverTimer)  { clearInterval(this.discoverTimer);  this.discoverTimer  = null }
    if (this.enrichTimer)    { clearInterval(this.enrichTimer);    this.enrichTimer    = null }
    if (this.externalTimer)  { clearInterval(this.externalTimer);  this.externalTimer  = null }
  }

  getMovers(): MoverEntry[] { return Array.from(this.movers.values()) }

  getStatus() {
    return {
      count:      this.movers.size,
      lastPollAt: this.lastPollAt,
      lastError:  this.lastError,
    }
  }

  // ── External movers scan (every 5 min) ────────────────────────────────────
  // Finds OLD tokens currently pumping via external data sources. This is the
  // critical path for tokens like "Happy Birthday Solana" or DIEGO (1y) that
  // are graduated, trading on Raydium, and thus invisible to bonding-curve discovery.

  private async discoverExternalMovers(): Promise<void> {
    const mints = new Set<string>()

    // 1. Birdeye top gainers — returns tokens sorted by 24h price change (free tier works)
    if (config.birdeye.apiKey) {
      try {
        const res = await axios.get(BIRDEYE_TOKENLIST_API, {
          params: {
            sort_by: 'v24hChangePercent',
            sort_type: 'desc',
            limit: 50,
            min_liquidity: 100,
          },
          headers: {
            'X-API-KEY': config.birdeye.apiKey,
            'x-chain': 'solana',
          },
          timeout: 10_000,
        })
        for (const token of (res.data?.data?.tokens ?? [])) {
          if (token.address && token.address !== WSOL) mints.add(token.address)
        }
        console.log(`[Movers] External: Birdeye returned ${res.data?.data?.tokens?.length ?? 0} gainers`)
      } catch (err: any) {
        console.warn('[Movers] External Birdeye scan error:', err?.message)
      }
    }

    // 2. DexScreener active token boosts (free, no auth needed)
    try {
      const res = await axios.get(DEX_BOOSTS_API, {
        timeout: 8_000,
        headers: { 'User-Agent': 'PumpAlert/1.0' },
      })
      let added = 0
      for (const boost of (res.data ?? [])) {
        if (boost.chainId === 'solana' && boost.tokenAddress) {
          mints.add(boost.tokenAddress)
          added++
        }
      }
      if (added > 0) console.log(`[Movers] External: DexScreener boosts returned ${added} Solana tokens`)
    } catch (err: any) {
      console.warn('[Movers] External DexScreener boosts error:', err?.message)
    }

    // 3. Axiom meme-trending — exact data source for the Axiom "Movers" tab (timePeriod=1h).
    //    Requires a valid AXIOM_COOKIE. This is the highest-quality source for catching
    //    old dormant tokens currently moving — activates automatically when cookie is valid.
    if (config.axiom.cookie) {
      try {
        const res = await axios.get(AXIOM_TRENDING_URL, {
          headers: {
            Cookie: config.axiom.cookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            Origin: 'https://axiom.trade',
            Referer: 'https://axiom.trade/',
          },
          timeout: 8_000,
          validateStatus: s => s === 200,
        })
        const items: any[] = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
        let axiomAdded = 0
        for (const item of items) {
          const mint = item.tokenAddress ?? item.mint ?? item.address
          if (mint && mint !== WSOL) { mints.add(mint); axiomAdded++ }
        }
        if (axiomAdded > 0) console.log(`[Movers] External: Axiom meme-trending returned ${axiomAdded} tokens`)
      } catch (err: any) {
        // 401/403 = cookie expired; log once so user knows to rotate it
        const status = (err as any)?.response?.status
        if (status === 401 || status === 403) {
          console.warn('[Movers] External: Axiom meme-trending auth failed — rotate AXIOM_COOKIE to enable this source')
        }
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

  // ── Discovery (5 min) — find new mints via Helius Enhanced Txs ──────────────
  // Watches two pump.fun programs:
  //   1. Bonding curve — pre-graduation SWAPs (new/young tokens)
  //   2. Pump AMM     — post-graduation SWAPs (graduated tokens, any age)
  // Together they cover every pump.fun token that has traded recently.

  private async discover(): Promise<void> {
    if (!this.heliusKey) {
      this.lastError = 'HELIUS_API_KEY not set'
      console.warn('[Movers] HELIUS_API_KEY not set — skipping discover')
      return
    }
    // Alternate between programs each cycle to halve Helius Enhanced Tx API credit usage.
    // Bonding curve (pre-graduation) and AMM (post-graduation) are each covered every 2 cycles.
    const useAMM = this.discoverFlip
    this.discoverFlip = !this.discoverFlip
    await this.fetchRecentMints(useAMM ? PUMP_AMM_STR : PUMP_PROGRAM_STR, useAMM)
  }

  // ── Enrichment (2 min) — refresh MC/price for all known mints ─────────────

  private async enrich(): Promise<void> {
    if (this.mintCache.size === 0) return

    const now      = Date.now()
    const solPrice = await getSolPrice()

    // 2. Enrich ALL cached mints via DexScreener (graduated tokens)
    const allMints = Array.from(this.mintCache.keys())
    const dexMap   = await this.fetchDexData(allMints)

    // 3. Bonding curve state for mints not found on DexScreener
    const nonGrad  = allMints.filter(m => !dexMap.has(m))
    const curveMap = await this.fetchBondingCurves(nonGrad)

    // 4. Token metadata (name/symbol) — only for non-graduated mints above the MC
    //    threshold that haven't had metadata fetched yet (saves TOKENS_METADATA_V2 credits)
    const needMeta = nonGrad.filter(m => {
      const rec = this.mintCache.get(m)
      if (!rec || rec.metadataFetched) return false
      if (rec.name && rec.name !== m.slice(0, 8)) return false  // already have a name
      if (rec.seenCount < 2) return false  // skip flash tokens seen only once (saves TOKENS_METADATA_V2)
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
      const mc = dex?.fdv ?? (curve ? computeMcUsd(curve, solPrice) : 0)
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

      // Track the floor (lowest MC ever seen in cache) — used to filter dormant alerts
      // to only bottom catches (e.g. ≤ $5K), not coins already at $125K.
      if (rec.floorMc === undefined || mc < rec.floorMc) rec.floorMc = mc

      const change1h  = dex?.priceChange?.h1  ?? computed.c1h
      const change6h  = dex?.priceChange?.h6  ?? computed.c6h
      const change24h = dex?.priceChange?.h24 ?? computed.c24h

      // For graduated tokens, DexScreener's own txns24h.buys tells us if the token
      // traded recently without waiting for the next discovery cycle to update lastTradeAt.
      // This cuts worst-case dormant alert latency from ~17 min to ~60 s for graduated tokens.
      const hasRecentActivity =
        lastTradeAt > now - 24 * 60 * 60_000 ||
        (graduated && (dex?.txns?.h24?.buys ?? 0) > 0)

      const meetsThreshold =
        ageDays >= DORMANT_AGE_DAYS &&
        hasRecentActivity &&
        mc <= DORMANT_MAX_WAKE_MC &&   // only bottom catches — skip coins already at high MC
        (Math.abs(change1h  ?? 0) >= DORMANT_MOVE_1H  ||
         Math.abs(change6h  ?? 0) >= DORMANT_MOVE_6H  ||
         Math.abs(change24h ?? 0) >= DORMANT_MOVE_24H)

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

    try {
      const BATCH = 30
      for (let i = 0; i < mints.length; i += BATCH) {
        const batch = mints.slice(i, i + BATCH)
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
      }
    } catch (err: any) {
      console.warn('[Movers] DexScreener error:', err?.message)
    }

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
