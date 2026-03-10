/**
 * Wallet Holdings Poller
 *
 * Primary mode (when HELIUS_API_KEY is set):
 *   - Helius webhooks handle real-time updates (zero polling credits).
 *   - This poller only runs once on startup (to seed initial holdings)
 *     and every 10 minutes as a safety net (in case a webhook was missed).
 *   - Holdings reads use the standard public RPC, NOT Helius — no credits burned.
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

// When Helius webhooks are active: 10-min safety-net poll
// When no Helius key: 5-min polling interval
const FALLBACK_INTERVAL_MS = 10 * 60_000
const POLLING_INTERVAL_MS  =  5 * 60_000

export class WalletPoller {
  private connection: Connection
  private monitor: SolanaMonitor
  private timer: NodeJS.Timeout | null = null

  constructor(monitor: SolanaMonitor) {
    this.monitor = monitor
    // Use Helius RPC — public endpoints (mainnet-beta, Ankr) silently fail for
    // getParsedTokenAccountsByOwner from server IPs like Render.
    // Standard RPC calls cost 1 credit each on Helius — negligible (~8,640/month
    // for 2 wallets at 10-min intervals vs 1,000,000 free credits/month).
    this.connection = new Connection(config.solana.rpcUrl, { commitment: 'confirmed' })
  }

  start(): void {
    const usingWebhooks = !!config.solana.heliusApiKey

    if (usingWebhooks) {
      console.log('[WalletPoller] Helius webhooks active — initial scan + 10-min safety net')
    } else {
      console.log('[WalletPoller] No Helius key — polling every 5 minutes')
    }

    // Initial seed after system settles
    setTimeout(() => this.pollAll(), 8_000)

    const interval = usingWebhooks ? FALLBACK_INTERVAL_MS : POLLING_INTERVAL_MS
    this.timer = setInterval(() => this.pollAll(), interval)
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
    const { value: accounts } = await this.connection.getParsedTokenAccountsByOwner(
      new PublicKey(address),
      { programId: TOKEN_PROGRAM_ID }
    )

    const holdings: Array<{ mint: string; amount: number }> = []

    for (const acct of accounts) {
      const parsed = acct.account.data.parsed?.info
      if (!parsed) continue
      const mint = parsed.mint as string
      const amount = parsed.tokenAmount?.uiAmount as number | null
      if (amount && amount > 0) {
        holdings.push({ mint, amount })
      }
    }

    db.setWalletHoldings(address, holdings)

    let newCount = 0
    for (const holding of holdings) {
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
    console.log(`[WalletPoller] ${label}: ${holdings.length} holdings${tag}`)
  }
}
