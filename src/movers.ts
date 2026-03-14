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
 * Poll interval: 15 minutes (100 credits × 96 polls/day ≈ 288 k credits/month).
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

// ── Constants ──────────────────────────────────────────────────────────────────

const PUMP_PROGRAM_STR = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const PUMP_PROGRAM     = new PublicKey(PUMP_PROGRAM_STR)
const WSOL             = 'So11111111111111111111111111111111111111112'

const HELIUS_API = 'https://api.helius.xyz/v0'
const DEX_API    = 'https://api.dexscreener.com/latest/dex/tokens'
const CMC_API    = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest'

const POLL_MS          = 15 * 60_000  // 15 minutes (was 5 — saves ~19k credits/day)
const ENRICH_MS        =  2 * 60_000  // 2 minutes — refresh MC/price for known mints (free)
const DORMANT_AGE_DAYS = 25
const DORMANT_MOVE_1H  = 30           // % threshold
const DORMANT_MOVE_6H  = 60           // % threshold
const DORMANT_MOVE_24H = 25           // % threshold — catches slow-build wakeups
const HISTORY_MAX_MS   = 25 * 60 * 60_000  // 25 h of MC snapshots
const MAX_MINT_CACHE   = 500          // rolling window of known mints
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
  private graduationEmitted  = new Set<string>()
  private discoverTimer: NodeJS.Timeout | null = null
  private enrichTimer:   NodeJS.Timeout | null = null
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
    // Kick both loops immediately on startup
    this.discover().catch(err => console.error('[Movers] discover error:', err?.message))
    this.enrich().catch(err => console.error('[Movers] enrich error:', err?.message))

    // Discovery: 15 min — Helius Enhanced Txs (100 credits/call, kept slow)
    this.discoverTimer = setInterval(
      () => this.discover().catch(err => console.error('[Movers] discover error:', err?.message)),
      POLL_MS
    )
    // Enrichment: 2 min — DexScreener (free) + bonding curve RPC (~1 credit/batch)
    this.enrichTimer = setInterval(
      () => this.enrich().catch(err => console.error('[Movers] enrich error:', err?.message)),
      ENRICH_MS
    )
    console.log('[Movers] Poller started — discovery 15 min, enrichment 2 min')
  }

  stop(): void {
    if (this.discoverTimer) { clearInterval(this.discoverTimer); this.discoverTimer = null }
    if (this.enrichTimer)   { clearInterval(this.enrichTimer);   this.enrichTimer   = null }
  }

  getMovers(): MoverEntry[] { return Array.from(this.movers.values()) }

  getStatus() {
    return {
      count:      this.movers.size,
      lastPollAt: this.lastPollAt,
      lastError:  this.lastError,
    }
  }

  // ── Discovery (15 min) — find new mints via Helius Enhanced Txs ──────────────

  private async discover(): Promise<void> {
    if (!this.heliusKey) {
      this.lastError = 'HELIUS_API_KEY not set'
      console.warn('[Movers] HELIUS_API_KEY not set — skipping discover')
      return
    }
    await this.fetchRecentMints()
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

      // Creation timestamp: DexScreener pairCreatedAt is the best proxy
      const createdAt  = dex?.pairCreatedAt ?? rec.firstSeen
      const lastTradeAt = rec.lastTradeAt
      const ageMs    = now - createdAt
      const ageHours = Math.floor(ageMs / (60 * 60_000))
      const ageDays  = ageHours / 24

      // MC history snapshot → computed price changes (fallback for non-graduated)
      this.addSnap(mint, now, mc)
      const computed = this.computeChanges(mint, now)

      const change1h  = dex?.priceChange?.h1  ?? computed.c1h
      const change6h  = dex?.priceChange?.h6  ?? computed.c6h
      const change24h = dex?.priceChange?.h24 ?? computed.c24h

      const isDormant =
        ageDays >= DORMANT_AGE_DAYS &&
        lastTradeAt > now - 24 * 60 * 60_000 &&
        (Math.abs(change1h  ?? 0) >= DORMANT_MOVE_1H  ||
         Math.abs(change6h  ?? 0) >= DORMANT_MOVE_6H  ||
         Math.abs(change24h ?? 0) >= DORMANT_MOVE_24H)

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

      const lastDormantAt = this.dormantSeen.get(mint) ?? 0
      if (isDormant && now - lastDormantAt > 12 * 60 * 60_000) {
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

  private async fetchRecentMints(): Promise<void> {
    try {
      const res = await axios.get(
        `${HELIUS_API}/addresses/${PUMP_PROGRAM_STR}/transactions`,
        {
          params: { 'api-key': this.heliusKey, limit: 100, type: 'SWAP' },
          timeout: 20_000,
        }
      )

      const txList: any[] = Array.isArray(res.data) ? res.data : []
      const now = Date.now()

      for (const tx of txList) {
        const txTs: number = tx.timestamp ? tx.timestamp * 1000 : now

        for (const t of tx.tokenTransfers ?? []) {
          const mint: string | undefined = t.mint
          if (!mint || mint === WSOL) continue

          const existing = this.mintCache.get(mint)
          if (existing) {
            if (txTs > existing.lastTradeAt) existing.lastTradeAt = txTs
            existing.seenCount++
          } else {
            this.mintCache.set(mint, {
              name:            mint.slice(0, 8),   // placeholder until metadata loaded
              symbol:          '?',
              firstSeen:       txTs,
              lastTradeAt:     txTs,
              graduated:       false,
              metadataFetched: false,
              seenCount:       1,
            })
          }
        }
      }

      // Evict oldest entries if cache is over the limit
      if (this.mintCache.size > MAX_MINT_CACHE) {
        const sorted = Array.from(this.mintCache.entries())
          .sort((a, b) => a[1].lastTradeAt - b[1].lastTradeAt)
        const toRemove = sorted.slice(0, this.mintCache.size - MAX_MINT_CACHE)
        for (const [m] of toRemove) {
          this.mintCache.delete(m)
          this.history.delete(m)
          this.movers.delete(m)
          this.graduationEmitted.delete(m)
        }
      }

      console.log(
        `[Movers] Helius: ${txList.length} txs → ` +
        `${this.mintCache.size} mints in cache`
      )
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
