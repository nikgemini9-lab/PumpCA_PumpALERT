import Database from 'better-sqlite3'
import path from 'path'
import { Token, Wallet, WalletHolding, RecentAlert } from './types'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'pump_alert.db')

let db: Database.Database

export function initDatabase(): void {
  const fs = require('fs')
  const dir = path.dirname(DB_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      mint        TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT 'Unknown',
      symbol      TEXT NOT NULL DEFAULT '?',
      price_usd   TEXT,
      market_cap  REAL,
      added_at    INTEGER NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      source      TEXT NOT NULL DEFAULT 'manual',
      wallet_source TEXT
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mint        TEXT NOT NULL,
      alert_type  TEXT NOT NULL,
      sent_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallets (
      address       TEXT PRIMARY KEY,
      label         TEXT NOT NULL,
      owner_chat_id TEXT NOT NULL,
      added_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_holdings (
      wallet_address TEXT NOT NULL,
      mint           TEXT NOT NULL,
      amount         REAL DEFAULT 0,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (wallet_address, mint)
    );

    CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_mint_sent ON alerts(mint, sent_at);
    CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(active);
    CREATE INDEX IF NOT EXISTS idx_holdings_wallet ON wallet_holdings(wallet_address);
  `)

  // Migrate existing tokens table (adds columns if missing from older deployments)
  migrateColumn('tokens', 'source', "TEXT NOT NULL DEFAULT 'manual'")
  migrateColumn('tokens', 'wallet_source', 'TEXT')

  console.log(`[DB] Initialized at ${DB_PATH}`)
}

function migrateColumn(table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  } catch {
    // column already exists — fine
  }
}

// ── Token CRUD ────────────────────────────────────────────────────────────────

export function addToken(
  mint: string,
  name = 'Unknown',
  symbol = '?',
  source: 'manual' | 'wallet' = 'manual',
  walletSource: string | null = null
): boolean {
  const existing = db.prepare('SELECT mint, active FROM tokens WHERE mint = ?').get(mint) as { mint: string; active: number } | undefined
  if (existing) {
    if (existing.active) return false // already tracked
    db.prepare('UPDATE tokens SET active = 1, source = ?, wallet_source = ? WHERE mint = ?').run(source, walletSource, mint)
    return true
  }
  db.prepare(`
    INSERT INTO tokens (mint, name, symbol, added_at, active, source, wallet_source)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(mint, name, symbol, Date.now(), source, walletSource)
  return true
}

export function removeToken(mint: string): boolean {
  const info = db.prepare('UPDATE tokens SET active = 0 WHERE mint = ? AND active = 1').run(mint)
  return info.changes > 0
}

export function getToken(mint: string): Token | undefined {
  const row = db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint) as any
  if (!row) return undefined
  return rowToToken(row)
}

export function getActiveTokens(): Token[] {
  const rows = db.prepare('SELECT * FROM tokens WHERE active = 1').all() as any[]
  return rows.map(rowToToken)
}

export function getAllTokens(): Token[] {
  const rows = db.prepare('SELECT * FROM tokens ORDER BY active DESC, added_at DESC').all() as any[]
  return rows.map(rowToToken)
}

export function updateTokenMetadata(
  mint: string,
  data: { name?: string; symbol?: string; priceUsd?: string; marketCap?: number }
): void {
  const token = getToken(mint)
  if (!token) return

  const name = data.name || token.name
  const symbol = data.symbol || token.symbol
  const priceUsd = data.priceUsd ?? token.priceUsd
  const marketCap = data.marketCap ?? token.marketCap

  db.prepare(`
    UPDATE tokens SET name = ?, symbol = ?, price_usd = ?, market_cap = ? WHERE mint = ?
  `).run(name, symbol, priceUsd, marketCap, mint)
}

// ── Alert CRUD ────────────────────────────────────────────────────────────────

export function recordAlert(mint: string, alertType: string): void {
  db.prepare('INSERT INTO alerts (mint, alert_type, sent_at) VALUES (?, ?, ?)').run(
    mint,
    alertType,
    Date.now()
  )
}

export function getLastAlertTime(mint: string): number | null {
  const row = db.prepare(
    'SELECT sent_at FROM alerts WHERE mint = ? ORDER BY sent_at DESC LIMIT 1'
  ).get(mint) as { sent_at: number } | undefined
  return row ? row.sent_at : null
}

export function getAlertCount(mint: string): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM alerts WHERE mint = ?').get(mint) as { cnt: number }
  return row.cnt
}

export function getRecentAlerts(limit = 50): RecentAlert[] {
  const rows = db.prepare(`
    SELECT a.id, a.mint, a.alert_type, a.sent_at,
           COALESCE(t.symbol, '?') as symbol,
           COALESCE(t.name, 'Unknown') as name
    FROM alerts a
    LEFT JOIN tokens t ON t.mint = a.mint
    ORDER BY a.sent_at DESC
    LIMIT ?
  `).all(limit) as any[]
  return rows.map(r => ({
    id: r.id,
    mint: r.mint,
    symbol: r.symbol,
    name: r.name,
    alertType: r.alert_type,
    sentAt: r.sent_at,
  }))
}

// ── Wallet CRUD ───────────────────────────────────────────────────────────────

export function addWallet(address: string, label: string, ownerChatId: string): boolean {
  const existing = db.prepare('SELECT address FROM wallets WHERE address = ?').get(address)
  if (existing) return false
  db.prepare(`
    INSERT INTO wallets (address, label, owner_chat_id, added_at) VALUES (?, ?, ?, ?)
  `).run(address, label, ownerChatId, Date.now())
  return true
}

export function removeWallet(address: string): boolean {
  const info = db.prepare('DELETE FROM wallets WHERE address = ?').run(address)
  return info.changes > 0
}

export function getWallets(): Wallet[] {
  const rows = db.prepare('SELECT * FROM wallets ORDER BY added_at DESC').all() as any[]
  return rows.map(rowToWallet)
}

export function getWallet(address: string): Wallet | undefined {
  const row = db.prepare('SELECT * FROM wallets WHERE address = ?').get(address) as any
  if (!row) return undefined
  return rowToWallet(row)
}

// ── Wallet Holdings ───────────────────────────────────────────────────────────

export function setWalletHoldings(
  walletAddress: string,
  holdings: Array<{ mint: string; amount: number }>
): void {
  const upsert = db.prepare(`
    INSERT INTO wallet_holdings (wallet_address, mint, amount, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(wallet_address, mint) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
  `)
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const h of holdings) {
      upsert.run(walletAddress, h.mint, h.amount, now)
    }
    // Clear holdings that are no longer held (amount went to 0 or sold)
    const currentMints = holdings.map(h => h.mint)
    if (currentMints.length > 0) {
      const placeholders = currentMints.map(() => '?').join(',')
      db.prepare(
        `DELETE FROM wallet_holdings WHERE wallet_address = ? AND mint NOT IN (${placeholders})`
      ).run(walletAddress, ...currentMints)
    } else {
      db.prepare('DELETE FROM wallet_holdings WHERE wallet_address = ?').run(walletAddress)
    }
  })
  tx()
}

export function getWalletHoldings(walletAddress: string): WalletHolding[] {
  const rows = db.prepare(`
    SELECT wh.*, COALESCE(t.symbol, '?') as symbol, COALESCE(t.name, 'Unknown') as name,
           t.price_usd, t.market_cap
    FROM wallet_holdings wh
    LEFT JOIN tokens t ON t.mint = wh.mint
    WHERE wh.wallet_address = ?
    ORDER BY wh.updated_at DESC
  `).all(walletAddress) as any[]
  return rows.map(r => ({
    walletAddress: r.wallet_address,
    mint: r.mint,
    amount: r.amount,
    updatedAt: r.updated_at,
    symbol: r.symbol,
    name: r.name,
    priceUsd: r.price_usd,
    marketCap: r.market_cap,
  }))
}

/** Find all wallets that hold a given mint — used for personalized alerts */
export function getWalletsHoldingToken(mint: string): Wallet[] {
  const rows = db.prepare(`
    SELECT w.* FROM wallets w
    INNER JOIN wallet_holdings wh ON wh.wallet_address = w.address
    WHERE wh.mint = ? AND wh.amount > 0
  `).all(mint) as any[]
  return rows.map(rowToWallet)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToToken(row: any): Token {
  return {
    mint: row.mint,
    name: row.name,
    symbol: row.symbol,
    priceUsd: row.price_usd,
    marketCap: row.market_cap,
    addedAt: row.added_at,
    active: row.active === 1,
    source: row.source ?? 'manual',
    walletSource: row.wallet_source ?? null,
  }
}

function rowToWallet(row: any): Wallet {
  return {
    address: row.address,
    label: row.label,
    ownerChatId: row.owner_chat_id,
    addedAt: row.added_at,
  }
}

// ── Key-Value Store (for internal config like webhook IDs) ────────────────────

export function getKV(key: string): string | null {
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setKV(key: string, value: string): void {
  db.prepare(`
    INSERT INTO kv_store (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

export function deleteKV(key: string): void {
  db.prepare('DELETE FROM kv_store WHERE key = ?').run(key)
}

export function closeDatabase(): void {
  if (db) db.close()
}
