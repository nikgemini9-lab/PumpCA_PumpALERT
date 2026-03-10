/**
 * Solana on-chain monitor
 *
 * For each tracked pump.fun token, subscribes to the bonding curve PDA via
 * accountSubscribe (WebSocket). Every time a buy or sell happens, the
 * bonding curve account changes and we get notified in real-time.
 *
 * Falls back gracefully if the bonding curve doesn't exist (token graduated).
 */

import { Connection, AccountInfo, PublicKey } from '@solana/web3.js'
import { EventEmitter } from 'events'
import { config } from './config'
import {
  PUMP_FUN_PROGRAM_ID,
  getBondingCurveAddress,
  decodeBondingCurve,
  detectTradeDirection,
  tradeAmountSOL,
  priceChangePct,
} from './pump'
import { BondingCurveState, OnChainBuyEvent } from './types'

interface Subscription {
  bondingCurveAddress: string
  subscriptionId: number
  prevState: BondingCurveState | null
}

export class SolanaMonitor extends EventEmitter {
  private connection: Connection
  private subscriptions: Map<string, Subscription> = new Map() // mint → subscription
  private reconnectTimer: NodeJS.Timeout | null = null
  private started = false

  constructor() {
    super()
    this.connection = this.createConnection()
  }

  private createConnection(): Connection {
    return new Connection(config.solana.rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: config.solana.wssUrl,
      disableRetryOnRateLimit: false,
    })
  }

  async subscribeToToken(mint: string): Promise<void> {
    if (this.subscriptions.has(mint)) return

    const bondingCurveAddress = getBondingCurveAddress(mint)

    // Fetch initial state
    let prevState: BondingCurveState | null = null
    try {
      const accountInfo = await this.connection.getAccountInfo(bondingCurveAddress)
      if (accountInfo && accountInfo.data) {
        prevState = decodeBondingCurve(accountInfo.data)
        if (prevState?.complete) {
          console.log(`[Monitor] ${mint.slice(0, 8)}... bonding curve complete (graduated) — on-chain skipped`)
          return
        }
      }
    } catch (err) {
      console.warn(`[Monitor] Could not fetch initial state for ${mint.slice(0, 8)}...:`, err)
    }

    try {
      const subscriptionId = this.connection.onAccountChange(
        bondingCurveAddress,
        (accountInfo: AccountInfo<Buffer>) => {
          this.handleAccountChange(mint, accountInfo.data)
        },
        'confirmed'
      )

      this.subscriptions.set(mint, {
        bondingCurveAddress: bondingCurveAddress.toBase58(),
        subscriptionId,
        prevState,
      })

      console.log(`[Monitor] Subscribed to ${mint.slice(0, 8)}... (bc: ${bondingCurveAddress.toBase58().slice(0, 8)}...)`)
    } catch (err) {
      console.error(`[Monitor] Failed to subscribe to ${mint.slice(0, 8)}...:`, err)
    }
  }

  async unsubscribeFromToken(mint: string): Promise<void> {
    const sub = this.subscriptions.get(mint)
    if (!sub) return
    try {
      await this.connection.removeAccountChangeListener(sub.subscriptionId)
    } catch {
      // ignore cleanup errors
    }
    this.subscriptions.delete(mint)
    console.log(`[Monitor] Unsubscribed from ${mint.slice(0, 8)}...`)
  }

  async subscribeAll(mints: string[]): Promise<void> {
    for (const mint of mints) {
      await this.subscribeToToken(mint)
    }
    this.started = true
    this.scheduleWatchdog()
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size
  }

  private handleAccountChange(mint: string, data: Buffer): void {
    const sub = this.subscriptions.get(mint)
    if (!sub) return

    const newState = decodeBondingCurve(data)
    if (!newState) return

    const prevState = sub.prevState

    if (prevState) {
      const direction = detectTradeDirection(prevState, newState)

      if (direction === 'buy') {
        const solAmount = tradeAmountSOL(prevState, newState)
        const pctChange = priceChangePct(prevState, newState)

        const event: OnChainBuyEvent = {
          mint,
          solAmount,
          priceChangePct: pctChange,
          bondingCurve: sub.bondingCurveAddress,
        }

        this.emit('buy', event)
      }
    }

    sub.prevState = newState

    // If bonding curve completed (graduated to Raydium), clean up subscription
    if (newState.complete) {
      console.log(`[Monitor] ${mint.slice(0, 8)}... graduated! Removing bonding curve sub.`)
      this.unsubscribeFromToken(mint)
    }
  }

  // Watchdog: periodically verify subscriptions are alive, reconnect if needed
  private scheduleWatchdog(): void {
    this.reconnectTimer = setInterval(async () => {
      try {
        // Simple check: if connection is alive, this returns a slot number
        await this.connection.getSlot()
      } catch (err) {
        console.warn('[Monitor] WebSocket seems dead, reconnecting...')
        await this.reconnect()
      }
    }, 60_000) // check every 60s
  }

  private async reconnect(): Promise<void> {
    const mintList = Array.from(this.subscriptions.keys())

    // Clear old subscriptions
    for (const mint of mintList) {
      try {
        const sub = this.subscriptions.get(mint)
        if (sub) await this.connection.removeAccountChangeListener(sub.subscriptionId)
      } catch { /* ignore */ }
    }
    this.subscriptions.clear()

    // New connection
    this.connection = this.createConnection()

    // Re-subscribe
    for (const mint of mintList) {
      await this.subscribeToToken(mint)
    }

    console.log(`[Monitor] Reconnected. Re-subscribed to ${mintList.length} tokens.`)
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearInterval(this.reconnectTimer)
    for (const mint of Array.from(this.subscriptions.keys())) {
      await this.unsubscribeFromToken(mint)
    }
  }
}
