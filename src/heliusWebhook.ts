/**
 * Helius Webhook Manager
 *
 * Registers a single enhanced webhook with Helius that monitors all tracked
 * wallet addresses. When any tracked wallet does a transaction, Helius POSTs
 * the parsed transaction to /api/webhook/helius.
 *
 * This eliminates 60s polling — zero credits burned for holdings tracking.
 * A 10-minute fallback poll remains as a safety net in walletPoller.ts.
 *
 * Webhook lifecycle:
 *   - On startup: create (or update) the webhook with all current wallet addresses
 *   - On /addwallet: update webhook to include the new address
 *   - On /removewallet: update webhook to remove the address
 *   - Webhook ID stored in kv_store DB table across restarts
 */

import axios from 'axios'
import { config } from './config'
import * as db from './database'

const HELIUS_API = 'https://api.helius.xyz/v0'
const WEBHOOK_ID_KEY = 'helius_webhook_id'

export async function syncWebhook(): Promise<void> {
  const apiKey = config.solana.heliusApiKey
  if (!apiKey) {
    console.log('[Webhook] No HELIUS_API_KEY set — using fallback polling instead')
    return
  }

  const appUrl = config.appUrl
  if (!appUrl) {
    console.warn('[Webhook] APP_URL not set — cannot register Helius webhook. Set APP_URL=https://pumpca-pumpalert.onrender.com in Render env vars.')
    return
  }

  const wallets = db.getWallets()
  const addresses = wallets.map(w => w.address)
  const webhookUrl = `${appUrl}/api/webhook/helius`
  const existingId = db.getKV(WEBHOOK_ID_KEY)

  try {
    if (existingId) {
      await updateWebhook(apiKey, existingId, webhookUrl, addresses)
      console.log(`[Webhook] Updated webhook (${existingId.slice(0, 8)}...) — ${addresses.length} wallet(s) monitored`)
    } else {
      const id = await createWebhook(apiKey, webhookUrl, addresses)
      db.setKV(WEBHOOK_ID_KEY, id)
      console.log(`[Webhook] Created webhook (${id.slice(0, 8)}...) — ${addresses.length} wallet(s) monitored`)
    }
  } catch (err: any) {
    const status = err?.response?.status
    const msg = err?.response?.data?.message ?? err?.message

    if (status === 404 && existingId) {
      // Stale webhook ID — create a fresh one
      console.warn('[Webhook] Stored webhook not found on Helius, recreating...')
      db.deleteKV(WEBHOOK_ID_KEY)
      try {
        const id = await createWebhook(apiKey, webhookUrl, addresses)
        db.setKV(WEBHOOK_ID_KEY, id)
        console.log(`[Webhook] Re-created webhook (${id.slice(0, 8)}...)`)
      } catch (err2: any) {
        console.error('[Webhook] Failed to recreate:', err2?.response?.data ?? err2?.message)
      }
    } else {
      console.error(`[Webhook] Sync failed (${status ?? 'unknown'}): ${msg}`)
    }
  }
}

async function createWebhook(
  apiKey: string,
  webhookUrl: string,
  addresses: string[]
): Promise<string> {
  const body: Record<string, unknown> = {
    webhookURL: webhookUrl,
    transactionTypes: ['ANY'],
    webhookType: 'enhanced',
    accountAddresses: addresses,
  }

  // If DASHBOARD_SECRET is set, use it as the auth header so the webhook
  // endpoint can verify that calls actually come from Helius.
  if (config.dashboard.secret) {
    body.authHeader = config.dashboard.secret
  }

  const res = await axios.post(`${HELIUS_API}/webhooks?api-key=${apiKey}`, body)
  return res.data.webhookID as string
}

async function updateWebhook(
  apiKey: string,
  id: string,
  webhookUrl: string,
  addresses: string[]
): Promise<void> {
  const body: Record<string, unknown> = {
    webhookURL: webhookUrl,
    transactionTypes: ['ANY'],
    webhookType: 'enhanced',
    accountAddresses: addresses,
  }

  if (config.dashboard.secret) {
    body.authHeader = config.dashboard.secret
  }

  await axios.put(`${HELIUS_API}/webhooks/${id}?api-key=${apiKey}`, body)
}

/**
 * Parse an array of Helius enhanced transactions.
 * Returns the set of tracked wallet addresses that were involved in any
 * token transfer — these wallets need a holdings refresh.
 */
export function getAffectedWallets(transactions: unknown[]): Set<string> {
  const trackedWallets = new Set(db.getWallets().map(w => w.address))
  const affected = new Set<string>()

  for (const tx of transactions as any[]) {
    for (const transfer of (tx.tokenTransfers ?? []) as any[]) {
      if (trackedWallets.has(transfer.toUserAccount)) affected.add(transfer.toUserAccount)
      if (trackedWallets.has(transfer.fromUserAccount)) affected.add(transfer.fromUserAccount)
    }
    // Also check nativeTransfers (SOL moves can mean a swap happened)
    for (const transfer of (tx.nativeTransfers ?? []) as any[]) {
      if (trackedWallets.has(transfer.toUserAccount)) affected.add(transfer.toUserAccount)
      if (trackedWallets.has(transfer.fromUserAccount)) affected.add(transfer.fromUserAccount)
    }
  }

  return affected
}
