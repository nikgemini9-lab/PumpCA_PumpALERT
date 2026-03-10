/**
 * Wallet Holdings Poller
 *
 * Primary mode (when HELIUS_API_KEY is set):
 *   - Helius webhooks handle real-time updates (zero polling credits).
 *   - This poller only runs once on startup (to seed initial holdings)
 *     and every 60 minutes as a safety net (in case a webhook was missed).
 *   - Uses Helius RPC — public endpoints silently fail from server IPs.
 *     Cost: 1 credit per call = ~1,440 credits/month at 60-min intervals (negligible).
 *
 * Fallback mode (no HELIUS_API_KEY):
 *   - Polls the public Solana RPC every 5 minutes.
 *   - No credits consumed — free public endpoint.
 *
 * refreshWallet(address) is called directly by the webhook handler for
 * immediate updates when Helius fires.
 */

import { Connection, PublicKey } from '@solana/web3.js'
import axios from 'axios'
import { config } from './config'
import * as db from './database'
import { SolanaMonitor } from './monitor'

const TOKEN_PROGRAM_ID      = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

// When Helius webhooks are active: 60-min safety-net poll (webhooks handle real-time)
// When no Helius key: 5-min polling interval
const FALLBACK_INTERVAL_MS = 60 * 60_000
const POLLING_INTERVAL_MS  =  5 * 60_000

// Max new tokens to add to watchlist per wallet scan (avoids flooding with old dust)
const MAX_NEW_TOKENS_PER_SCAN = 20

// Minimum USD value for a holding to be tracked / added to watchlist
const MIN_HOLDING_USD = 5

// Tokens that are always ignored regardless of balance (native wrappers, etc.)
export const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // Wrapped SOL
])

export class WalletPoller {
  private connection: Connection
  private monitor: SolanaMonitor
  private timer: NodeJS.Timeout | null = null

  constructor(monitor: SolanaMonitor) {
    this.monitor = monitor
    // Must use Helius RPC here — public endpoints (mainnet-beta, Ankr) silently
    // return partial/empty results for getParsedTokenAccountsByOwner from server
    // IPs (Render, Fly, etc). Credit cost is 1 credit per call regardless of
    // account count — negligible at 60-min intervals.
    this.connection = new Connection(config.solana.rpcUrl, { commitment: 'confirmed' })
  }

  start(): void {
    const usingWebhooks = !!config.solana.heliusApiKey

    if (usingWebhooks) {
      console.log('[WalletPoller] Helius webhooks active — initial scan + 60-min safety net')
    } else {
      console.log('[WalletPoller] No Helius key — polling every 5 minutes')
    }

    // Initial seed after system settles; also resolve any stale Unknown metadata
    setTimeout(() => this.pollAll(), 8_000)
    setTimeout(() => this.resolveUnknownMetadata(), 12_000)

    const interval = usingWebhooks ? FALLBACK_INTERVAL_MS : POLLING_INTERVAL_MS
    this.timer = setInterval(() => this.pollAll(), interval)
  }

  /** Public: refresh a single wallet on demand */
  async refreshWallet(address: string, label: string): Promise<void> {
    await this.pollWallet(address, label)
  }

  /** Public: resolve names for all Unknown tokens (called by Rescan) */
  async resolveMetadata(): Promise<void> {
    await this.resolveUnknownMetadata()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async pollAll(): Promise<void> {
    const wallets = await db.getWallets()
    if (wallets.length === 0) return
    for (const wallet of wallets) {
      try {
        await this.pollWallet(wallet.address, wallet.label)
      } catch (err) {
        console.error(`[WalletPoller] Error polling ${wallet.label} (${wallet.address.slice(0, 8)}...):`, err)
      }
    }
  }

  private async pollWallet(address: string, label: string): Promise<void> {
    const owner = new PublicKey(address)
    console.log(`[WalletPoller] Fetching holdings for ${label} (${address.slice(0, 8)}...) via Helius RPC`)

    // Fetch both classic SPL and Token-2022 accounts in parallel
    const [splResult, t22Result] = await Promise.all([
      this.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      this.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    ])

    const accounts = [...splResult.value, ...t22Result.value]
    console.log(`[WalletPoller] RPC returned ${splResult.value.length} SPL + ${t22Result.value.length} Token-2022 accounts for ${label}`)

    const holdings: Array<{ mint: string; amount: number }> = []

    for (const acct of accounts) {
      const parsed = acct.account.data.parsed?.info
      if (!parsed) continue
      const mint = parsed.mint as string
      if (SKIP_MINTS.has(mint)) continue
      const rawAmount = parsed.tokenAmount?.amount as string | undefined
      const uiAmount = parsed.tokenAmount?.uiAmount as number | null
      if (rawAmount && rawAmount !== '0') {
        holdings.push({ mint, amount: uiAmount ?? 1 })
      }
    }

    // Don't wipe existing holdings if RPC returned nothing — likely a silent failure
    if (holdings.length === 0 && accounts.length === 0) {
      const existing = await db.getWalletHoldings(address)
      if (existing.length > 0) {
        console.warn(`[WalletPoller] RPC returned 0 accounts for ${label} but DB has ${existing.length} holdings — skipping update (likely RPC failure)`)
        return
      }
    }

    await db.setWalletHoldings(address, holdings)

    let newCount = 0
    for (const holding of holdings) {
      if (newCount >= MAX_NEW_TOKENS_PER_SCAN) {
        console.log(`[WalletPoller] ${label}: hit new-token cap (${MAX_NEW_TOKENS_PER_SCAN}), skipping rest`)
        break
      }

      // Skip watchlist addition if holding has a known price and value < $5
      const existingToken = await db.getToken(holding.mint)
      if (existingToken?.priceUsd) {
        const priceUsd = parseFloat(existingToken.priceUsd)
        const valueUsd = holding.amount * priceUsd
        if (valueUsd < MIN_HOLDING_USD) {
          console.log(`[WalletPoller] Skipping ${holding.mint.slice(0, 8)}... (value $${valueUsd.toFixed(2)} < $${MIN_HOLDING_USD})`)
          continue
        }
      }

      const added = await db.addToken(holding.mint, 'Unknown', '?', 'wallet', address)
      if (added) {
        newCount++
        console.log(`[WalletPoller] New holding from ${label}: ${holding.mint.slice(0, 8)}...`)
        this.monitor.subscribeToToken(holding.mint).catch(err => {
          console.error(`[WalletPoller] Subscribe error for ${holding.mint.slice(0, 8)}...:`, err)
        })
      }
    }

    const tag = newCount > 0 ? `, ${newCount} new added to watchlist` : ''
    console.log(`[WalletPoller] ${label}: ${holdings.length} token accounts with balance${tag}`)

    // Resolve names/symbols for any tokens still showing as Unknown
    await this.resolveUnknownMetadata()
  }

  /**
   * Fetches on-chain Metaplex metadata via Helius DAS for tokens that are
   * still stored as Unknown / ? — covers tokens with no DexScreener listing.
   */
  async resolveUnknownMetadata(): Promise<void> {
    if (!config.solana.heliusApiKey) return

    const unknown = (await db.getAllTokens()).filter(t => t.name === 'Unknown' || t.symbol === '?')
    if (unknown.length === 0) return

    const mints = unknown.map(t => t.mint)
    // DAS getAssetBatch supports up to 1000 IDs per call
    const BATCH = 1000
    for (let i = 0; i < mints.length; i += BATCH) {
      const batch = mints.slice(i, i + BATCH)
      try {
        const res = await axios.post<{ result: any[] }>(
          config.solana.rpcUrl,
          { jsonrpc: '2.0', id: 'meta', method: 'getAssetBatch', params: { ids: batch } },
          { timeout: 15_000 }
        )
        const assets: any[] = res.data?.result ?? []
        for (const asset of assets) {
          const mint = asset?.id as string | undefined
          if (!mint) continue
          const meta = asset?.content?.metadata
          const name: string | undefined = meta?.name?.trim()
          const symbol: string | undefined = meta?.symbol?.trim()
          if ((name && name !== 'Unknown') || (symbol && symbol !== '?')) {
            await db.updateTokenMetadata(mint, {
              name: name || undefined,
              symbol: symbol || undefined,
            })
          }
        }
        console.log(`[WalletPoller] Resolved metadata for ${assets.length} tokens via Helius DAS`)
      } catch (err: any) {
        console.warn(`[WalletPoller] DAS metadata fetch failed: ${err?.message ?? err}`)
      }
    }
  }
}
