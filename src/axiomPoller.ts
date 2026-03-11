/**
 * Axiom pair-info poller
 *
 * Polls https://api6.axiom.trade/pair-info for each tracked token to fetch:
 *   - userCount       — live viewer count (people watching this token on Axiom)
 *   - top10Holders    — % supply held by top 10 wallets
 *   - lpBurned        — % LP burned
 *   - dexPaid         — whether the team paid for DexScreener listing
 *   - devFundedSol    — how much SOL the deployer wallet was funded with
 *
 * Requires AXIOM_COOKIE env var (copy from browser DevTools → Network → any
 * api6.axiom.trade request → Request Headers → Cookie).
 *
 * The pairAddress for pump.fun tokens = bonding curve PDA (derived from mint).
 * For graduated tokens the request may 404 — silently skipped.
 *
 * Emits:
 *   'viewers' (mint: string, userCount: number)  — when count >= VIEWER_COUNT_ALERT
 *                                                   and own cooldown has passed
 */

import EventEmitter from 'events'
import axios from 'axios'
import { config } from './config'
import * as db from './database'
import { getBondingCurveAddress } from './pump'
import { AxiomPairInfo } from './types'

// Standalone viewer-alert cooldown: 5 minutes per token
const VIEWER_ALERT_COOLDOWN_MS = 5 * 60_000

// Delay between individual token requests (ms) to avoid hammering the API
const REQUEST_DELAY_MS = 250

export interface AxiomTokenCache {
  userCount: number
  top10Holders: number
  lpBurned: number
  dexPaid: boolean
  devFundedSol: number | null
  fetchedAt: number
}

export class AxiomPoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private viewerAlertCooldown: Map<string, number> = new Map()

  /** In-memory cache — read by AlertManager to enrich pump alert messages */
  readonly cache: Map<string, AxiomTokenCache> = new Map()

  start(): void {
    if (!config.axiom.cookie) {
      console.log('[Axiom] No AXIOM_COOKIE set — viewer count polling disabled')
      return
    }
    const intervalMs = config.axiom.pollIntervalSeconds * 1_000
    console.log(`[Axiom] Poller started (every ${config.axiom.pollIntervalSeconds}s, viewer alert ≥ ${config.axiom.viewerCountAlert})`)
    // Run immediately, then on interval
    this.poll().catch(err => console.error('[Axiom] Initial poll error:', err))
    this.timer = setInterval(() => this.poll().catch(err => console.error('[Axiom] Poll error:', err)), intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Latest cached data for a mint (null if not yet fetched or not a tracked token) */
  getCached(mint: string): AxiomTokenCache | null {
    return this.cache.get(mint) ?? null
  }

  /**
   * One-off viewer count fetch — used for dormant coin alerts.
   * Returns null if the request fails or AXIOM_COOKIE not set.
   */
  async fetchViewerCount(mint: string): Promise<number | null> {
    if (!config.axiom.cookie) return null
    try {
      const info = await this.fetchPairInfo(mint)
      return info?.userCount ?? null
    } catch {
      return null
    }
  }

  private async poll(): Promise<void> {
    const tokens = await db.getActiveTokens()
    if (tokens.length === 0) return

    for (const token of tokens) {
      try {
        const info = await this.fetchPairInfo(token.mint)
        if (!info) continue

        const cached: AxiomTokenCache = {
          userCount: info.userCount,
          top10Holders: info.top10Holders,
          lpBurned: info.lpBurned,
          dexPaid: info.dexPaid,
          devFundedSol: info.devWalletFunding?.amountSol ?? null,
          fetchedAt: Date.now(),
        }
        this.cache.set(token.mint, cached)

        // Persist to DB so dashboard always has fresh data
        await db.updateAxiomData(token.mint, {
          userCount: cached.userCount,
          top10Holders: cached.top10Holders,
          lpBurned: cached.lpBurned,
          dexPaid: cached.dexPaid,
          devFundedSol: cached.devFundedSol,
        })

        // Emit viewer alert if threshold crossed and cooldown passed
        if (info.userCount >= config.axiom.viewerCountAlert) {
          const lastAlert = this.viewerAlertCooldown.get(token.mint) ?? 0
          if (Date.now() - lastAlert >= VIEWER_ALERT_COOLDOWN_MS) {
            this.viewerAlertCooldown.set(token.mint, Date.now())
            this.emit('viewers', token.mint, info.userCount)
          }
        }
      } catch {
        // Silently skip — token may be graduated / not on Axiom
      }

      // Small delay between requests
      await sleep(REQUEST_DELAY_MS)
    }
  }

  private async fetchPairInfo(mint: string): Promise<AxiomPairInfo | null> {
    const pairAddress = getBondingCurveAddress(mint).toString()
    const url = `https://api6.axiom.trade/pair-info?pairAddress=${pairAddress}&v=${Date.now()}`

    const res = await axios.get<Record<string, any>>(url, {
      headers: {
        Cookie: config.axiom.cookie,
        'User-Agent': 'Mozilla/5.0 (compatible; PumpAlert/1.0)',
        Accept: 'application/json',
      },
      timeout: 8_000,
      validateStatus: s => s === 200,
    })

    const d = res.data
    if (!d || typeof d !== 'object') return null

    return {
      userCount: Number(d.userCount ?? 0),
      top10Holders: Number(d.top10Holders ?? 0),
      lpBurned: Number(d.lpBurned ?? 0),
      dexPaid: Boolean(d.dexPaid),
      devWalletFunding: d.devWalletFunding
        ? { amountSol: Number(d.devWalletFunding.amountSol ?? 0), fundingWalletAddress: String(d.devWalletFunding.fundingWalletAddress ?? '') }
        : null,
      tokenName: String(d.tokenName ?? ''),
      tokenTicker: String(d.tokenTicker ?? ''),
      tokenAddress: String(d.tokenAddress ?? mint),
      pairAddress,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
