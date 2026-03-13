/**
 * Axiom pair-info poller
 *
 * Polls https://api6.axiom.trade/pair-info for:
 *   A) Watchlist tokens (every AXIOM_POLL_INTERVAL_SECONDS, default 30s)
 *      → persists to DB, enriches pump alert messages
 *   B) All active movers (every 60s, top 100 by MC)
 *      → in-memory only, shown as 👀 column in dashboard movers table
 *
 * Requires AXIOM_COOKIE env var.
 * Tracks consecutive 401/403 errors — exposes isCookieOk() so the dashboard
 * can show "👀 N/A" across all mover rows when the session needs rotating.
 *
 * Emits:
 *   'viewers' (mint: string, userCount: number)  — when count >= VIEWER_COUNT_ALERT
 */

import EventEmitter from 'events'
import axios, { AxiosError } from 'axios'
import { config } from './config'
import * as db from './database'
import { getBondingCurveAddress } from './pump'
import { AxiomPairInfo } from './types'
import type { MoverEntry } from './movers'

// Watchlist polling: delay between each token request
const REQUEST_DELAY_MS = 250

// Movers polling constants
const MOVER_POLL_INTERVAL_MS = 60_000  // separate 60s cycle
const MOVER_REQUEST_DELAY_MS = 300     // delay between requests
const MAX_MOVERS_TO_POLL = 10          // top 10 by MC

// Standalone viewer-alert cooldown: 5 minutes per token
const VIEWER_ALERT_COOLDOWN_MS = 5 * 60_000

// Number of consecutive 401/403 responses before marking cookie as dead
const AUTH_FAIL_THRESHOLD = 3

export interface MoverAxiomData {
  userCount: number
  top10Holders: number
  lpBurned: number
}

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
  private moversTimer: NodeJS.Timeout | null = null
  private viewerAlertCooldown: Map<string, number> = new Map()

  // Cookie health tracking
  private cookieOk = true
  private consecutiveAuthFails = 0

  // Movers viewer count source (set externally after construction)
  private getMoversSource: (() => MoverEntry[]) | null = null

  /** Watchlist cache — read by AlertManager to enrich pump alert messages */
  readonly cache: Map<string, AxiomTokenCache> = new Map()

  /** Movers Axiom data — in-memory only, ephemeral */
  private moversAxiomData: Map<string, MoverAxiomData> = new Map()

  // ── Public API ────────────────────────────────────────────────────────────

  /** Wire up the movers source. Call this after both pollers are created. */
  setMoversSource(fn: () => MoverEntry[]): void {
    this.getMoversSource = fn
  }

  /** Latest watchlist token cache entry (null if not yet fetched) */
  getCached(mint: string): AxiomTokenCache | null {
    return this.cache.get(mint) ?? null
  }

  /** Axiom data for a mover (userCount + top10Holders + lpBurned) from last poll cycle */
  getMoverAxiomData(mint: string): MoverAxiomData | null {
    return this.moversAxiomData.get(mint) ?? null
  }

  /** Viewer count for a mover — backwards-compat shortcut */
  getMoverViewerCount(mint: string): number | null {
    return this.moversAxiomData.get(mint)?.userCount ?? null
  }

  /** True while the cookie appears valid; false after 3+ consecutive 401/403s */
  isCookieOk(): boolean {
    return this.cookieOk
  }

  start(): void {
    if (!config.axiom.cookie) {
      console.log('[Axiom] No AXIOM_COOKIE set — viewer count polling disabled')
      return
    }

    const intervalMs = config.axiom.pollIntervalSeconds * 1_000
    console.log(`[Axiom] Watchlist poller started (every ${config.axiom.pollIntervalSeconds}s, viewer alert ≥ ${config.axiom.viewerCountAlert})`)

    // Watchlist cycle — run immediately then on interval
    this.poll().catch(err => console.error('[Axiom] Initial poll error:', err))
    this.timer = setInterval(
      () => this.poll().catch(err => console.error('[Axiom] Poll error:', err)),
      intervalMs
    )

    // Movers cycle — delay first run by 40s to let MoversPoller warm up
    setTimeout(() => this.pollMovers().catch(err => console.error('[Axiom] Initial movers poll error:', err)), 40_000)
    this.moversTimer = setInterval(
      () => this.pollMovers().catch(err => console.error('[Axiom] Movers poll error:', err)),
      MOVER_POLL_INTERVAL_MS
    )
    console.log('[Axiom] Movers viewer poller started (every 60s, cap 100 movers)')
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.moversTimer) { clearInterval(this.moversTimer); this.moversTimer = null }
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

  /**
   * Debug helper — tries multiple pair address strategies and returns all results.
   * Exposed via GET /api/debug/axiom?mint=XXX
   */
  async debugFetchPairInfo(
    mint: string,
    overridePairAddress?: string
  ): Promise<{ results: Record<string, any> }> {
    const bondingCurvePda = getBondingCurveAddress(mint).toString()

    const candidates: Record<string, string> = {
      mint_as_pair: mint,
      bonding_curve_pda: bondingCurvePda,
    }
    if (overridePairAddress) {
      candidates.dexscreener_raydium_pool = overridePairAddress
    }

    const results: Record<string, any> = {}
    for (const [label, pairAddress] of Object.entries(candidates)) {
      const url = `https://api6.axiom.trade/pair-info?pairAddress=${pairAddress}&v=${Date.now()}`
      try {
        const res = await axios.get(url, {
          headers: {
            Cookie: config.axiom.cookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            Origin: 'https://axiom.trade',
            Referer: 'https://axiom.trade/',
          },
          timeout: 8_000,
          validateStatus: () => true,
        })
        results[label] = { pairAddress, status: res.status, body: res.data }
      } catch (err: any) {
        results[label] = { pairAddress, error: err?.message }
      }
    }
    return { results }
  }

  // ── Watchlist poll cycle ──────────────────────────────────────────────────

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

        // Persist to DB so dashboard watchlist tab always shows fresh data
        await db.updateAxiomData(token.mint, {
          userCount: cached.userCount,
          top10Holders: cached.top10Holders,
          lpBurned: cached.lpBurned,
          dexPaid: cached.dexPaid,
          devFundedSol: cached.devFundedSol,
        })

        // Emit viewer alert if threshold crossed and own cooldown has passed
        if (config.axiom.viewerCountAlert > 0 && info.userCount >= config.axiom.viewerCountAlert) {
          const lastAlert = this.viewerAlertCooldown.get(token.mint) ?? 0
          if (Date.now() - lastAlert >= VIEWER_ALERT_COOLDOWN_MS) {
            this.viewerAlertCooldown.set(token.mint, Date.now())
            this.emit('viewers', token.mint, info.userCount)
          }
        }
      } catch {
        // Silently skip — token may be graduated / not on Axiom
      }

      await sleep(REQUEST_DELAY_MS)
    }
  }

  // ── Movers poll cycle ─────────────────────────────────────────────────────

  private async pollMovers(): Promise<void> {
    if (!this.getMoversSource) return
    const movers = this.getMoversSource()
    if (movers.length === 0) {
      console.log('[Axiom] Movers poll skipped — no movers yet (will retry next cycle)')
      return
    }

    // Sort by market cap descending, take top MAX_MOVERS_TO_POLL
    const sorted = [...movers]
      .sort((a, b) => b.marketCap - a.marketCap)
      .slice(0, MAX_MOVERS_TO_POLL)

    let fetched = 0
    let withViewers = 0
    for (const mover of sorted) {
      try {
        const info = await this.fetchPairInfo(mover.mint, mover.pairAddress)
        if (info) {
          this.moversAxiomData.set(mover.mint, {
            userCount: info.userCount,
            top10Holders: info.top10Holders,
            lpBurned: info.lpBurned,
          })
          fetched++
          if (info.userCount > 0) withViewers++
        }
      } catch {
        // non-fatal; counted in summary below
      }
      await sleep(MOVER_REQUEST_DELAY_MS)
    }

    console.log(`[Axiom] Movers done: ${fetched}/${sorted.length} responded, ${withViewers} have active viewers`)
  }

  // ── Core fetch ────────────────────────────────────────────────────────────

  private async fetchPairInfo(mint: string, overridePairAddress?: string): Promise<AxiomPairInfo | null> {
    // Priority: DexScreener pool > mint address > bonding curve PDA
    // (Axiom appears to index by mint or pool address, not the bonding curve PDA)
    const pairAddress = overridePairAddress || mint
    const url = `https://api6.axiom.trade/pair-info?pairAddress=${pairAddress}&v=${Date.now()}`

    try {
      const res = await axios.get<Record<string, any>>(url, {
        headers: {
          Cookie: config.axiom.cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://axiom.trade',
          Referer: 'https://axiom.trade/',
        },
        timeout: 8_000,
        validateStatus: s => s === 200,
      })

      // Successful request — reset auth failure counter
      this.consecutiveAuthFails = 0
      this.cookieOk = true

      const d = res.data
      if (!d || typeof d !== 'object') return null

      return {
        userCount: Number(d.userCount ?? 0),
        top10Holders: Number(d.top10Holders ?? 0),
        lpBurned: Number(d.lpBurned ?? 0),
        dexPaid: Boolean(d.dexPaid),
        devWalletFunding: d.devWalletFunding
          ? {
              amountSol: Number(d.devWalletFunding.amountSol ?? 0),
              fundingWalletAddress: String(d.devWalletFunding.fundingWalletAddress ?? ''),
            }
          : null,
        tokenName: String(d.tokenName ?? ''),
        tokenTicker: String(d.tokenTicker ?? ''),
        tokenAddress: String(d.tokenAddress ?? mint),
        pairAddress,
      }
    } catch (err) {
      const axErr = err as AxiosError
      const status = axErr?.response?.status
      const body = axErr?.response?.data as Record<string, any> | undefined
      const isAuthError =
        status === 401 ||
        status === 403 ||
        (status === 502 && typeof body?.error === 'string' && body.error.toLowerCase().includes('token'))
      if (isAuthError) {
        this.consecutiveAuthFails++
        if (this.consecutiveAuthFails >= AUTH_FAIL_THRESHOLD) {
          if (this.cookieOk) {
            console.warn(`[Axiom] Cookie appears expired (${this.consecutiveAuthFails} auth failures, last status=${status}) — update AXIOM_COOKIE`)
          }
          this.cookieOk = false
        }
      } else {
        // Non-auth error (404, timeout, etc.) — don't penalise cookie health
        this.consecutiveAuthFails = 0
      }
      return null
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
