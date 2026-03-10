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
import { config } from './config'
import * as db from './database'
import { SolanaMonitor } from './monitor'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

// When Helius webhooks are active: 60-min safety-net poll (webhooks handle real-time)
// When no Helius key: 5-min polling interval
const FALLBACK_INTERVAL_MS = 60 * 60_000
const POLLING_INTERVAL_MS  =  5 * 60_000

// Max new tokens to add to watchlist per wallet scan (avoids flooding with old dust)
const MAX_NEW_TOKENS_PER_SCAN = 20

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
      console.log('[WalletPoller] Helius webhooks active — initial scan + 60-min safety net (free public RPC)')
    } else {
      console.log('[WalletPoller] No Helius key — polling every 5 minutes')
    }

    // Initial seed after system settles
    setTimeout(() => this.pollAll(), 8_000)

    const interval = usingWebhooks ? FALLBACK_INTERVAL_MS : POLLING_INTERVAL_MS
    this.timer = setInterval(() => this.pollAll(), interval)
  }

  /** Public method to refresh a single wallet on demand */
  async refreshWallet(address: string, label: string): Promise<void> {
    await this.pollWallet(address, label)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async pollAll(): Promise<void> {
    const wallets = db.getWallets()
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
    console.log(`[WalletPoller] Fetching holdings for ${label} (${address.slice(0, 8)}...) via public RPC`)

    const { value: accounts } = await this.connection.getParsedTokenAccountsByOwner(
      new PublicKey(address),
      { programId: TOKEN_PROGRAM_ID }
    )

    console.log(`[WalletPoller] RPC returned ${accounts.length} token accounts for ${label}`)

    const holdings: Array<{ mint: string; amount: number }> = []

    for (const acct of accounts) {
      const parsed = acct.account.data.parsed?.info
      if (!parsed) continue
      const mint = parsed.mint as string
      // Use raw amount string — uiAmount can be null for some token decimal configs
      // even when the user genuinely holds the token
      const rawAmount = parsed.tokenAmount?.amount as string | undefined
      const uiAmount = parsed.tokenAmount?.uiAmount as number | null
      if (rawAmount && rawAmount !== '0') {
        holdings.push({ mint, amount: uiAmount ?? 1 })
      }
    }

    // Don't wipe existing holdings if RPC returned nothing — likely a silent failure
    if (holdings.length === 0 && accounts.length === 0) {
      const existing = db.getWalletHoldings(address)
      if (existing.length > 0) {
        console.warn(`[WalletPoller] RPC returned 0 accounts for ${label} but DB has ${existing.length} holdings — skipping update (likely RPC failure)`)
        return
      }
    }

    db.setWalletHoldings(address, holdings)

    let newCount = 0
    for (const holding of holdings) {
      if (newCount >= MAX_NEW_TOKENS_PER_SCAN) {
        console.log(`[WalletPoller] ${label}: hit new-token cap (${MAX_NEW_TOKENS_PER_SCAN}), skipping rest`)
        break
      }
      const added = db.addToken(holding.mint, 'Unknown', '?', 'wallet', address)
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
  }
}
