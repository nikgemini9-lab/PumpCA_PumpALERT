/**
 * OG Token Finder
 *
 * When a new token is added, checks if an older token with the same name or
 * symbol already exists on pump.fun. If found, sends a follow-up warning so
 * the user knows people may migrate to the OG token instead.
 *
 * Also powers the /og <name> manual lookup command.
 */

const PUMP_API = 'https://frontend-api.pump.fun/coins'

interface PumpCoin {
  mint: string
  name: string
  symbol: string
  created_timestamp: number  // epoch ms
  usd_market_cap: number
}

export interface OgResult {
  mint: string
  name: string
  symbol: string
  ageHours: number
  marketCapUsd: number
}

/** Fetch a single coin's metadata from pump.fun */
export async function fetchPumpCoin(mint: string): Promise<PumpCoin | null> {
  try {
    const res = await fetch(`${PUMP_API}/${mint}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    return (await res.json()) as PumpCoin
  } catch {
    return null
  }
}

/** Search pump.fun for coins matching a text term, sorted oldest-first */
async function searchPump(term: string): Promise<PumpCoin[]> {
  try {
    const url =
      `${PUMP_API}?offset=0&limit=50` +
      `&sort=created_timestamp&order=ASC` +
      `&searchTerm=${encodeURIComponent(term)}`
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as PumpCoin[]
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/**
 * Given a token mint + its name/symbol, search for the oldest other token on
 * pump.fun that shares the same name or symbol.
 *
 * Returns the oldest match (the OG), or null if none found.
 */
export async function findOgToken(
  currentMint: string,
  name: string,
  symbol: string,
  currentCreatedAt?: number
): Promise<OgResult | null> {
  if (!name || name === 'Unknown') return null

  // Search by both name and symbol, deduplicate
  const [byName, bySymbol] = await Promise.all([
    searchPump(name),
    searchPump(symbol),
  ])

  const seen = new Set<string>()
  const all: PumpCoin[] = []
  for (const coin of [...byName, ...bySymbol]) {
    if (!seen.has(coin.mint)) {
      seen.add(coin.mint)
      all.push(coin)
    }
  }

  // Determine current token's creation time
  let currentTs = currentCreatedAt
  if (!currentTs) {
    const current = all.find(c => c.mint === currentMint)
    currentTs = current?.created_timestamp ?? Date.now()
  }

  const nameLower = name.toLowerCase()
  const symbolLower = symbol.toLowerCase()

  // Find tokens with same name or symbol that are OLDER than the current one
  const candidates = all
    .filter(c => c.mint !== currentMint)
    .filter(
      c =>
        c.name?.toLowerCase() === nameLower ||
        c.symbol?.toLowerCase() === symbolLower
    )
    .filter(c => c.created_timestamp != null && c.created_timestamp < currentTs!)
    .sort((a, b) => a.created_timestamp - b.created_timestamp)

  if (candidates.length === 0) return null

  const og = candidates[0]
  const ageMs = Date.now() - og.created_timestamp
  const ageHours = Math.max(0, Math.floor(ageMs / (1000 * 60 * 60)))

  return {
    mint: og.mint,
    name: og.name,
    symbol: og.symbol,
    ageHours,
    marketCapUsd: og.usd_market_cap ?? 0,
  }
}

/**
 * Search for all tokens matching a name/symbol term, sorted oldest-first.
 * Used by the /og <name> manual command.
 */
export async function searchAllByName(term: string): Promise<OgResult[]> {
  const coins = await searchPump(term)

  const termLower = term.toLowerCase()
  return coins
    .filter(
      c =>
        c.name?.toLowerCase().includes(termLower) ||
        c.symbol?.toLowerCase().includes(termLower)
    )
    .sort((a, b) => (a.created_timestamp ?? 0) - (b.created_timestamp ?? 0))
    .map(c => {
      const ageMs = Date.now() - (c.created_timestamp ?? Date.now())
      return {
        mint: c.mint,
        name: c.name,
        symbol: c.symbol,
        ageHours: Math.max(0, Math.floor(ageMs / (1000 * 60 * 60))),
        marketCapUsd: c.usd_market_cap ?? 0,
      }
    })
}

/** Format age in hours into a human-readable string */
export function fmtAge(ageHours: number): string {
  if (ageHours < 1) return 'less than 1h'
  if (ageHours < 24) return `${ageHours}h`
  const days = Math.floor(ageHours / 24)
  const hrs = ageHours % 24
  if (hrs === 0) return `${days}d`
  return `${days}d ${hrs}h`
}

// ── OG Buy Activity ────────────────────────────────────────────────────────────

export interface OgBuyActivity {
  buyCount: number
  buyVolumeSol: number
  buyVolumeUsd: number
}

// SOL price cache — refreshed at most once every 5 minutes
const SOL_MINT = 'So11111111111111111111111111111111111111112'
let _cachedSolPrice = 150  // safe fallback
let _solPriceFetchedAt = 0

async function getSolPrice(): Promise<number> {
  if (Date.now() - _solPriceFetchedAt < 5 * 60_000) return _cachedSolPrice
  try {
    const res = await fetch(
      `https://api.jup.ag/price/v2?ids=${SOL_MINT}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) }
    )
    if (res.ok) {
      const data = (await res.json()) as any
      const price = parseFloat(String(data?.data?.[SOL_MINT]?.price ?? '0'))
      if (price > 0) {
        _cachedSolPrice = price
        _solPriceFetchedAt = Date.now()
      }
    }
  } catch { /* use cached fallback */ }
  return _cachedSolPrice
}

/**
 * Fetch the last 3 hours of buy activity for an OG token from pump.fun.
 * Returns buy count + volume in SOL and USD.
 */
export async function getOgBuyActivity(mint: string): Promise<OgBuyActivity> {
  const empty: OgBuyActivity = { buyCount: 0, buyVolumeSol: 0, buyVolumeUsd: 0 }
  try {
    const threeHoursAgo = Math.floor((Date.now() - 3 * 60 * 60 * 1000) / 1000)
    const url = `${PUMP_API}/${mint}/trades?offset=0&limit=200`
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return empty

    const trades = (await res.json()) as Array<{
      is_buy: boolean
      sol_amount: number
      timestamp: number
    }>
    if (!Array.isArray(trades)) return empty

    const recentBuys = trades.filter(t => t.is_buy && t.timestamp >= threeHoursAgo)
    const buyVolumeSol = recentBuys.reduce((sum, t) => sum + (Number(t.sol_amount) || 0), 0)
    const solPrice = await getSolPrice()

    return {
      buyCount: recentBuys.length,
      buyVolumeSol,
      buyVolumeUsd: buyVolumeSol * solPrice,
    }
  } catch {
    return empty
  }
}
