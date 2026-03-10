/**
 * Express HTTP server
 *
 * Exposes:
 *   GET /health  — health check (used by Fly.io / UptimeRobot to keep the process alive)
 *   GET /         — simple status dashboard (JSON)
 */

import express, { Request, Response } from 'express'
import { config } from './config'
import * as db from './database'
import { MonitorStatus } from './types'

export function startServer(getStatus: () => MonitorStatus): void {
  const app = express()

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', ts: new Date().toISOString() })
  })

  app.get('/', (_req: Request, res: Response) => {
    const status = getStatus()
    const tokens = db.getActiveTokens()

    res.json({
      status: 'online',
      uptime_ms: status.uptime,
      started_at: new Date(status.startedAt).toISOString(),
      tracked_tokens: tokens.length,
      onchain_subscriptions: status.onchainSubscriptions,
      last_poll_at: status.lastPollAt ? new Date(status.lastPollAt).toISOString() : null,
      tokens: tokens.map(t => ({
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        price_usd: t.priceUsd,
        market_cap_usd: t.marketCap,
        alerts_sent: db.getAlertCount(t.mint),
      })),
    })
  })

  app.listen(config.port, () => {
    console.log(`[Server] HTTP server listening on port ${config.port}`)
  })
}
