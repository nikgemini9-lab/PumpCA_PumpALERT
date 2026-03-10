import { createClient, Client } from '@libsql/client'
import path from 'path'
import { Token, Wallet, WalletHolding, RecentAlert, OgRadarHit } from './types'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'pump_alert.db')

let client: Client

export async function initDatabase(): Promise<void> {
  const tursoUrl = process.env.TURSO_DATABASE_URL
  const tursoToken = process.env.TURSO_AUTH_TOKEN

  if (tursoUrl) {
    client = createClient({ url: tursoUrl, authToken: tursoToken })
    console.log('[DB] Connected to Turso (persistent cloud SQLite)')
  } else {
    // Local SQLite file — dev / fallback
    const fs = require('fs')
    const dir = path.dirname(DB_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    client = createClient({ url: `file:${DB_PATH}` })
    console.log(`[DB] Using local SQLite at ${DB_PATH}`)
  }

  // Create schema
  const statements = [
    `CREATE TABLE IF NOT EXISTS tokens (
      mint        TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT 'Unknown',
      symbol      TEXT NOT NULL DEFAULT '?',
      price_usd   TEXT,
      market_cap  REAL,
      added_at    INTEGER NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      source      TEXT NOT NULL DEFAULT 'manual',
      wallet_source TEXT,
      initial_market_cap REAL
    )`,
    `CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mint        TEXT NOT NULL,
      alert_type  TEXT NOT NULL,
      sent_at     INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS wallets (
      address       TEXT PRIMARY KEY,
      label         TEXT NOT NULL,
      owner_chat_id TEXT NOT NULL,
      added_at      INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS wallet_holdings (
      wallet_address TEXT NOT NULL,
      mint           TEXT NOT NULL,
      amount         REAL DEFAULT 0,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (wallet_address, mint)
    )`,
    `CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS og_radar (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      migrated_mint       TEXT NOT NULL UNIQUE,
      migrated_name       TEXT NOT NULL,
      migrated_symbol     TEXT NOT NULL,
      migrated_mc         REAL NOT NULL,
      og_mint             TEXT NOT NULL,
      og_name             TEXT NOT NULL,
      og_symbol           TEXT NOT NULL,
      og_mc               REAL NOT NULL,
      og_age_hours        INTEGER NOT NULL,
      og_buy_count        INTEGER NOT NULL DEFAULT 0,
      og_buy_volume_usd   REAL NOT NULL DEFAULT 0,
      detected_at         INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_alerts_mint_sent ON alerts(mint, sent_at)`,
    `CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(active)`,
    `CREATE INDEX IF NOT EXISTS idx_holdings_wallet ON wallet_holdings(wallet_address)`,
    `CREATE INDEX IF NOT EXISTS idx_og_radar_detected ON og_radar(detected_at)`,
  ]

  for (const sql of statements) {
    await client.execute(sql)
  }

  // Migrations — add columns silently if they don't exist yet
  await migrateColumn('tokens', 'source', "TEXT NOT NULL DEFAULT 'manual'")
  await migrateColumn('tokens', 'wallet_source', 'TEXT')
  await migrateColumn('tokens', 'twitter_handle', 'TEXT')
  await migrateColumn('tokens', 'twitter_followers', 'INTEGER')
  await migrateColumn('tokens', 'twitter_followers_prev', 'INTEGER')
  await migrateColumn('tokens', 'initial_market_cap', 'REAL')
  await migrateColumn('og_radar', 'og_buy_count', 'INTEGER NOT NULL DEFAULT 0')
  await migrateColumn('og_radar', 'og_buy_volume_usd', 'REAL NOT NULL DEFAULT 0')
}

async function migrateColumn(table: string, column: string, type: string): Promise<void> {
  try {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  } catch {
    // Column already exists — fine
  }
}

// ── Token CRUD ────────────────────────────────────────────────────────────────

export async function addToken(
  mint: string,
  name = 'Unknown',
  symbol = '?',
  source: 'manual' | 'wallet' = 'manual',
  walletSource: string | null = null
): Promise<boolean> {
  const existing = (await client.execute({
    sql: 'SELECT mint, active FROM tokens WHERE mint = ?',
    args: [mint],
  })).rows[0] as any

  if (existing) {
    if (Number(existing.active) === 1) return false
    await client.execute({
      sql: 'UPDATE tokens SET active = 1, source = ?, wallet_source = ? WHERE mint = ?',
      args: [source, walletSource, mint],
    })
    return true
  }

  await client.execute({
    sql: `INSERT INTO tokens (mint, name, symbol, added_at, active, source, wallet_source)
          VALUES (?, ?, ?, ?, 1, ?, ?)`,
    args: [mint, name, symbol, Date.now(), source, walletSource],
  })
  return true
}

export async function removeToken(mint: string): Promise<boolean> {
  const result = await client.execute({
    sql: 'UPDATE tokens SET active = 0 WHERE mint = ? AND active = 1',
    args: [mint],
  })
  return result.rowsAffected > 0
}

export async function getToken(mint: string): Promise<Token | undefined> {
  const row = (await client.execute({
    sql: 'SELECT * FROM tokens WHERE mint = ?',
    args: [mint],
  })).rows[0] as any
  if (!row) return undefined
  return rowToToken(row)
}

export async function getActiveTokens(): Promise<Token[]> {
  const rows = (await client.execute('SELECT * FROM tokens WHERE active = 1')).rows as any[]
  return rows.map(rowToToken)
}

export async function getAllTokens(): Promise<Token[]> {
  const rows = (await client.execute(
    'SELECT * FROM tokens ORDER BY active DESC, added_at DESC'
  )).rows as any[]
  return rows.map(rowToToken)
}

export async function updateTokenMetadata(
  mint: string,
  data: { name?: string; symbol?: string; priceUsd?: string; marketCap?: number; twitterHandle?: string }
): Promise<void> {
  const token = await getToken(mint)
  if (!token) return

  const name = data.name || token.name
  const symbol = data.symbol || token.symbol
  const priceUsd = data.priceUsd ?? token.priceUsd
  const marketCap = data.marketCap ?? token.marketCap
  const twitterHandle = data.twitterHandle ?? token.twitterHandle ?? null

  // Set initial_market_cap once — only when it's still null and we have a value
  const initialMarketCap =
    token.initialMarketCap == null && data.marketCap != null
      ? data.marketCap
      : token.initialMarketCap ?? null

  await client.execute({
    sql: `UPDATE tokens SET name = ?, symbol = ?, price_usd = ?, market_cap = ?,
          twitter_handle = ?, initial_market_cap = ? WHERE mint = ?`,
    args: [name, symbol, priceUsd ?? null, marketCap ?? null, twitterHandle, initialMarketCap, mint],
  })
}

export async function updateTwitterFollowers(mint: string, followers: number): Promise<void> {
  await client.execute({
    sql: `UPDATE tokens
          SET twitter_followers_prev = twitter_followers,
              twitter_followers = ?
          WHERE mint = ?`,
    args: [followers, mint],
  })
}

export async function getTokensWithTwitter(): Promise<Token[]> {
  const rows = (await client.execute(
    `SELECT * FROM tokens WHERE active = 1 AND twitter_handle IS NOT NULL`
  )).rows as any[]
  return rows.map(rowToToken)
}

// ── Alert CRUD ────────────────────────────────────────────────────────────────

export async function recordAlert(mint: string, alertType: string): Promise<void> {
  await client.execute({
    sql: 'INSERT INTO alerts (mint, alert_type, sent_at) VALUES (?, ?, ?)',
    args: [mint, alertType, Date.now()],
  })
}

export async function getLastAlertTime(mint: string): Promise<number | null> {
  const row = (await client.execute({
    sql: 'SELECT sent_at FROM alerts WHERE mint = ? ORDER BY sent_at DESC LIMIT 1',
    args: [mint],
  })).rows[0] as any
  return row ? Number(row.sent_at) : null
}

export async function getAlertCount(mint: string): Promise<number> {
  const row = (await client.execute({
    sql: 'SELECT COUNT(*) as cnt FROM alerts WHERE mint = ?',
    args: [mint],
  })).rows[0] as any
  return Number(row?.cnt ?? 0)
}

export async function getRecentAlerts(limit = 50): Promise<RecentAlert[]> {
  const rows = (await client.execute({
    sql: `SELECT a.id, a.mint, a.alert_type, a.sent_at,
                 COALESCE(t.symbol, '?') as symbol,
                 COALESCE(t.name, 'Unknown') as name
          FROM alerts a
          LEFT JOIN tokens t ON t.mint = a.mint
          ORDER BY a.sent_at DESC
          LIMIT ?`,
    args: [limit],
  })).rows as any[]
  return rows.map(r => ({
    id: Number(r.id),
    mint: r.mint as string,
    symbol: r.symbol as string,
    name: r.name as string,
    alertType: r.alert_type as string,
    sentAt: Number(r.sent_at),
  }))
}

// ── Wallet CRUD ───────────────────────────────────────────────────────────────

export async function addWallet(address: string, label: string, ownerChatId: string): Promise<boolean> {
  const existing = (await client.execute({
    sql: 'SELECT address FROM wallets WHERE address = ?',
    args: [address],
  })).rows[0]
  if (existing) return false

  await client.execute({
    sql: 'INSERT INTO wallets (address, label, owner_chat_id, added_at) VALUES (?, ?, ?, ?)',
    args: [address, label, ownerChatId, Date.now()],
  })
  return true
}

export async function removeWallet(address: string): Promise<boolean> {
  const result = await client.execute({
    sql: 'DELETE FROM wallets WHERE address = ?',
    args: [address],
  })
  return result.rowsAffected > 0
}

export async function getWallets(): Promise<Wallet[]> {
  const rows = (await client.execute(
    'SELECT * FROM wallets ORDER BY added_at DESC'
  )).rows as any[]
  return rows.map(rowToWallet)
}

export async function getWallet(address: string): Promise<Wallet | undefined> {
  const row = (await client.execute({
    sql: 'SELECT * FROM wallets WHERE address = ?',
    args: [address],
  })).rows[0] as any
  if (!row) return undefined
  return rowToWallet(row)
}

// ── Wallet Holdings ───────────────────────────────────────────────────────────

export async function setWalletHoldings(
  walletAddress: string,
  holdings: Array<{ mint: string; amount: number }>
): Promise<void> {
  const now = Date.now()
  const upsertSql = `INSERT INTO wallet_holdings (wallet_address, mint, amount, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(wallet_address, mint) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`

  const statements: Array<{ sql: string; args: any[] }> = holdings.map(h => ({
    sql: upsertSql,
    args: [walletAddress, h.mint, h.amount, now],
  }))

  if (holdings.length > 0) {
    const placeholders = holdings.map(() => '?').join(',')
    statements.push({
      sql: `DELETE FROM wallet_holdings WHERE wallet_address = ? AND mint NOT IN (${placeholders})`,
      args: [walletAddress, ...holdings.map(h => h.mint)],
    })
  } else {
    statements.push({
      sql: 'DELETE FROM wallet_holdings WHERE wallet_address = ?',
      args: [walletAddress],
    })
  }

  await client.batch(statements, 'write')
}

export async function getWalletHoldings(walletAddress: string): Promise<WalletHolding[]> {
  const rows = (await client.execute({
    sql: `SELECT wh.*, COALESCE(t.symbol, '?') as symbol, COALESCE(t.name, 'Unknown') as name,
                 t.price_usd, t.market_cap
          FROM wallet_holdings wh
          LEFT JOIN tokens t ON t.mint = wh.mint
          WHERE wh.wallet_address = ?
            AND (
              t.price_usd IS NULL
              OR CAST(t.price_usd AS REAL) * wh.amount >= 5.0
            )
          ORDER BY wh.updated_at DESC`,
    args: [walletAddress],
  })).rows as any[]
  return rows.map(r => ({
    walletAddress: r.wallet_address as string,
    mint: r.mint as string,
    amount: Number(r.amount),
    updatedAt: Number(r.updated_at),
    symbol: r.symbol as string,
    name: r.name as string,
    priceUsd: r.price_usd as string | null,
    marketCap: r.market_cap != null ? Number(r.market_cap) : null,
  }))
}

export async function adjustHolding(walletAddress: string, mint: string, delta: number): Promise<void> {
  const existing = (await client.execute({
    sql: 'SELECT amount FROM wallet_holdings WHERE wallet_address = ? AND mint = ?',
    args: [walletAddress, mint],
  })).rows[0] as any

  const newAmount = (existing ? Number(existing.amount) : 0) + delta

  if (newAmount <= 0) {
    await client.execute({
      sql: 'DELETE FROM wallet_holdings WHERE wallet_address = ? AND mint = ?',
      args: [walletAddress, mint],
    })
  } else {
    await client.execute({
      sql: `INSERT INTO wallet_holdings (wallet_address, mint, amount, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(wallet_address, mint) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
      args: [walletAddress, mint, newAmount, Date.now()],
    })
  }
}

export async function getWalletsHoldingToken(mint: string): Promise<Wallet[]> {
  const rows = (await client.execute({
    sql: `SELECT w.* FROM wallets w
          INNER JOIN wallet_holdings wh ON wh.wallet_address = w.address
          WHERE wh.mint = ? AND wh.amount > 0`,
    args: [mint],
  })).rows as any[]
  return rows.map(rowToWallet)
}

// ── Key-Value Store ────────────────────────────────────────────────────────────

export async function getKV(key: string): Promise<string | null> {
  const row = (await client.execute({
    sql: 'SELECT value FROM kv_store WHERE key = ?',
    args: [key],
  })).rows[0] as any
  return row ? String(row.value) : null
}

export async function setKV(key: string, value: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO kv_store (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  })
}

export async function deleteKV(key: string): Promise<void> {
  await client.execute({
    sql: 'DELETE FROM kv_store WHERE key = ?',
    args: [key],
  })
}

// ── OG Radar ──────────────────────────────────────────────────────────────────

export async function addOgRadarHit(hit: {
  migratedMint: string
  migratedName: string
  migratedSymbol: string
  migratedMc: number
  ogMint: string
  ogName: string
  ogSymbol: string
  ogMc: number
  ogAgeHours: number
  ogBuyCount: number
  ogBuyVolumeUsd: number
}): Promise<boolean> {
  try {
    await client.execute({
      sql: `INSERT INTO og_radar
              (migrated_mint, migrated_name, migrated_symbol, migrated_mc,
               og_mint, og_name, og_symbol, og_mc, og_age_hours,
               og_buy_count, og_buy_volume_usd, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        hit.migratedMint, hit.migratedName, hit.migratedSymbol, hit.migratedMc,
        hit.ogMint, hit.ogName, hit.ogSymbol, hit.ogMc, hit.ogAgeHours,
        hit.ogBuyCount, hit.ogBuyVolumeUsd, Date.now(),
      ],
    })
    return true
  } catch {
    // UNIQUE constraint on migrated_mint — already stored
    return false
  }
}

export async function getOgRadarHits(limit = 50): Promise<OgRadarHit[]> {
  const rows = (await client.execute({
    sql: 'SELECT * FROM og_radar ORDER BY detected_at DESC LIMIT ?',
    args: [limit],
  })).rows as any[]
  return rows.map(r => ({
    id: Number(r.id),
    migratedMint: r.migrated_mint as string,
    migratedName: r.migrated_name as string,
    migratedSymbol: r.migrated_symbol as string,
    migratedMc: Number(r.migrated_mc),
    ogMint: r.og_mint as string,
    ogName: r.og_name as string,
    ogSymbol: r.og_symbol as string,
    ogMc: Number(r.og_mc),
    ogAgeHours: Number(r.og_age_hours),
    ogBuyCount: Number(r.og_buy_count ?? 0),
    ogBuyVolumeUsd: Number(r.og_buy_volume_usd ?? 0),
    detectedAt: Number(r.detected_at),
  }))
}

export function closeDatabase(): void {
  client?.close()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToToken(row: any): Token {
  return {
    mint: row.mint as string,
    name: row.name as string,
    symbol: row.symbol as string,
    priceUsd: row.price_usd != null ? String(row.price_usd) : null,
    marketCap: row.market_cap != null ? Number(row.market_cap) : null,
    initialMarketCap: row.initial_market_cap != null ? Number(row.initial_market_cap) : null,
    addedAt: Number(row.added_at),
    active: Number(row.active) === 1,
    source: row.source === 'wallet' ? 'wallet' : 'manual',
    walletSource: row.wallet_source != null ? String(row.wallet_source) : null,
    twitterHandle: row.twitter_handle != null ? String(row.twitter_handle) : null,
    twitterFollowers: row.twitter_followers != null ? Number(row.twitter_followers) : null,
    twitterFollowersPrev: row.twitter_followers_prev != null ? Number(row.twitter_followers_prev) : null,
  }
}

function rowToWallet(row: any): Wallet {
  return {
    address: row.address as string,
    label: row.label as string,
    ownerChatId: row.owner_chat_id as string,
    addedAt: Number(row.added_at),
  }
}
