import Database from 'better-sqlite3'
import path from 'path'
import { Token } from './types'

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
      active      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mint        TEXT NOT NULL,
      alert_type  TEXT NOT NULL,
      sent_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_mint_sent ON alerts(mint, sent_at);
    CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(active);
  `)

  console.log(`[DB] Initialized at ${DB_PATH}`)
}

export function addToken(mint: string, name = 'Unknown', symbol = '?'): boolean {
  const existing = db.prepare('SELECT mint, active FROM tokens WHERE mint = ?').get(mint) as { mint: string; active: number } | undefined
  if (existing) {
    if (existing.active) return false // already tracked
    db.prepare('UPDATE tokens SET active = 1 WHERE mint = ?').run(mint)
    return true
  }
  db.prepare(`
    INSERT INTO tokens (mint, name, symbol, added_at, active)
    VALUES (?, ?, ?, ?, 1)
  `).run(mint, name, symbol, Date.now())
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

function rowToToken(row: any): Token {
  return {
    mint: row.mint,
    name: row.name,
    symbol: row.symbol,
    priceUsd: row.price_usd,
    marketCap: row.market_cap,
    addedAt: row.added_at,
    active: row.active === 1,
  }
}

export function closeDatabase(): void {
  if (db) db.close()
}
