/**
 * Wallet Holdings Poller
 *
 * Every 60 seconds, fetches all SPL token holdings for each tracked wallet
 * using the Solana RPC. New holdings are automatically added to the watchlist
 * (source='wallet') so the existing alert system picks them up.
 *
 * When a wallet-sourced token pumps, the alert goes only to that wallet's
 * owner (handled in alerts.ts via the walletSource field).
 */

import { Connection, PublicKey } from '@solana/web3.js'
import { config } from './config'
import * as db from './database'
import { SolanaMonitor } from './monitor'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const POLL_INTERVAL_MS = 60_000

export class WalletPoller {
  private connection: Connection
  private monitor: SolanaMonitor
  private timer: NodeJS.Timeout | null = null

  constructor(monitor: SolanaMonitor) {
    this.monitor = monitor
    this.connection = new Connection(config.solana.rpcUrl, { commitment: 'confirmed' })
  }

  start(): void {
    console.log('[WalletPoller] Starting wallet holdings poller (60s interval)')
    // First poll after a short delay to let the system settle
    setTimeout(() => this.poll(), 5_000)
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async pollNow(): Promise<void> {
    await this.poll()
  }

  private async poll(): Promise<void> {
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

    // Persist holdings snapshot
    db.setWalletHoldings(address, holdings)

    // Auto-add new holdings to the watchlist so they get monitored
    let newCount = 0
    for (const holding of holdings) {
      const added = db.addToken(holding.mint, 'Unknown', '?', 'wallet', address)
      if (added) {
        newCount++
        console.log(`[WalletPoller] Auto-added ${holding.mint.slice(0, 8)}... from ${label}'s wallet`)
        this.monitor.subscribeToToken(holding.mint).catch(err => {
          console.error(`[WalletPoller] Subscribe error for ${holding.mint.slice(0, 8)}...:`, err)
        })
      }
    }

    if (newCount > 0) {
      console.log(`[WalletPoller] ${label}: ${holdings.length} holdings, ${newCount} new tokens added to watchlist`)
    } else {
      console.log(`[WalletPoller] ${label}: ${holdings.length} holdings (no new)`)
    }
  }
}
