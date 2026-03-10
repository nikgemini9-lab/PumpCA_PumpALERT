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
