/**
 * Telegram bot
 *
 * Commands:
 *   /start              — Welcome + show chat ID
 *   /add <CA>           — Add a token CA to the shared watchlist
 *   /remove <CA>        — Stop tracking a token
 *   /list               — Show all tracked tokens
 *   /wallets            — List tracked wallets
 *   /addwallet <owner> <address>   — Add a wallet (owner = nik or josh)
 *   /removewallet <address>        — Remove a wallet
 *   /status             — Show monitor health
 *   /thresholds         — Show alert thresholds
 *   /set <key> <val>    — Change a threshold at runtime
 *   /help               — Command reference
 */

import TelegramBot from 'node-telegram-bot-api'
import { PublicKey } from '@solana/web3.js'
import { config } from './config'
import * as db from './database'
import { SolanaMonitor } from './monitor'
import { MonitorStatus } from './types'
import { syncWebhook } from './heliusWebhook'
import { fetchPumpCoin, findOgToken, searchAllByName, fmtAge } from './ogFinder'

export function setupBot(
  bot: TelegramBot,
  monitor: SolanaMonitor,
  getStatus: () => Promise<MonitorStatus>
): void {

  /** Any configured user (Nik or Josh) is authorized */
  function isAuthorized(chatId: string | number): boolean {
    if (config.telegram.users.length === 0) return true // no restriction set
    return config.telegram.users.some(u => String(u.chatId) === String(chatId))
  }

  async function reply(msg: TelegramBot.Message, text: string): Promise<void> {
    await bot.sendMessage(msg.chat.id, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  }

  // ── /start ────────────────────────────────────────────────────────────────
  bot.onText(/\/start/, async msg => {
    const chatId = String(msg.chat.id)
    const text = [
      `👋 <b>PumpAlert is online!</b>`,
      ``,
      `Your chat ID: <code>${chatId}</code>`,
      ``,
      isAuthorized(chatId)
        ? `✅ You are authorized.`
        : `⚠️ Your chat ID is not in the authorized list. Ask Nik to add it.`,
      ``,
      `<b>Commands:</b>`,
      `/add &lt;CA&gt; — Track a token`,
      `/remove &lt;CA&gt; — Stop tracking`,
      `/list — Show tracked tokens`,
      `/og &lt;name&gt; — Find OG token by name`,
      `/wallets — List tracked wallets`,
      `/addwallet &lt;nik|josh&gt; &lt;address&gt; — Add wallet`,
      `/status — Monitor health`,
      `/thresholds — Alert settings`,
      `/help — Full command list`,
    ].join('\n')
    await reply(msg, text)
  })

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.onText(/\/help/, async msg => {
    if (!isAuthorized(msg.chat.id)) return
    await reply(
      msg,
      [
        `<b>PumpAlert Commands</b>`,
        ``,
        `<code>/add &lt;CA&gt;</code>`,
        `  Add a token to the shared watchlist`,
        ``,
        `<code>/remove &lt;CA&gt;</code>`,
        `  Remove a token from the watchlist`,
        ``,
        `<code>/list</code>`,
        `  Show all tracked tokens with stats`,
        ``,
        `<code>/wallets</code>`,
        `  List all tracked wallets`,
        ``,
        `<code>/addwallet &lt;nik|josh&gt; &lt;address&gt;</code>`,
        `  Track a Solana wallet and auto-watch its holdings`,
        ``,
        `<code>/removewallet &lt;address&gt;</code>`,
        `  Stop tracking a wallet`,
        ``,
        `<code>/status</code>`,
        `  WebSocket subs, uptime, last poll`,
        ``,
        `<code>/thresholds</code>`,
        `  Show current alert thresholds`,
        ``,
        `<code>/set pricechange &lt;%&gt;</code>`,
        `  Set price-change alert threshold`,
        ``,
        `<code>/set buycount &lt;n&gt;</code>`,
        `  Set buy-count alert threshold`,
        ``,
        `<code>/set cooldown &lt;min&gt;</code>`,
        `  Set cooldown between alerts per token`,
        ``,
        `<code>/og &lt;name or symbol&gt;</code>`,
        `  Search for OG token by name/symbol — sorted oldest first`,
      ].join('\n')
    )
  })

  // ── /add <CA> ─────────────────────────────────────────────────────────────
  bot.onText(/\/add (.+)/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return

    const mint = match?.[1]?.trim()
    if (!mint) {
      await reply(msg, `❌ Usage: <code>/add &lt;TOKEN_CA&gt;</code>`)
      return
    }

    if (!isValidSolanaAddress(mint)) {
      await reply(msg, `❌ Invalid Solana address. Check the CA and try again.`)
      return
    }

    const added = await db.addToken(mint)
    if (!added) {
      await reply(msg, `ℹ️ Already tracking <code>${mint}</code>`)
      return
    }

    // Subscribe on-chain
    monitor.subscribeToToken(mint).catch(err => {
      console.error(`[Bot] subscribe error for ${mint}:`, err)
    })

    await reply(
      msg,
      [
        `✅ <b>Now tracking:</b>`,
        `<code>${mint}</code>`,
        ``,
        `👁 Watching on-chain bonding curve + DexScreener polls.`,
        `You'll get an alert when it pumps!`,
      ].join('\n')
    )

    // Async OG check — sends follow-up if an older same-name token exists
    checkForOg(bot, String(msg.chat.id), mint).catch(err =>
      console.error('[OG] check error:', err)
    )
  })

  // ── /remove <CA> ─────────────────────────────────────────────────────────
  bot.onText(/\/remove (.+)/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return

    const mint = match?.[1]?.trim()
    if (!mint) {
      await reply(msg, `❌ Usage: <code>/remove &lt;TOKEN_CA&gt;</code>`)
      return
    }

    const removed = await db.removeToken(mint)
    if (!removed) {
      await reply(msg, `ℹ️ Token not found in your list: <code>${mint}</code>`)
      return
    }

    await monitor.unsubscribeFromToken(mint)

    await reply(msg, `🗑 Stopped tracking <code>${mint}</code>`)
  })

  // ── /list ─────────────────────────────────────────────────────────────────
  bot.onText(/\/list/, async msg => {
    if (!isAuthorized(msg.chat.id)) return

    const tokens = await db.getAllTokens()
    if (tokens.length === 0) {
      await reply(msg, `📭 No tokens tracked yet.\nUse <code>/add &lt;CA&gt;</code> to start.`)
      return
    }

    const active = tokens.filter(t => t.active)
    const inactive = tokens.filter(t => !t.active)

    const lines: string[] = [`<b>Tracked Tokens (${active.length} active)</b>`, ``]

    for (const t of active) {
      const price = t.priceUsd ? `$${t.priceUsd}` : 'no price yet'
      const mc = t.marketCap ? `MC $${fmtNum(t.marketCap)}` : ''
      const alertCount = await db.getAlertCount(t.mint)
      const srcTag = t.source === 'wallet' ? ` 💼` : ''
      lines.push(
        `🟢 <b>${escHtml(t.symbol)}</b> — ${escHtml(t.name)}${srcTag}`,
        `   <code>${t.mint}</code>`,
        `   ${price}  ${mc}  🔔 ${alertCount} alerts`,
        ``
      )
    }

    if (inactive.length > 0) {
      lines.push(`<b>Removed (${inactive.length}):</b>`)
      for (const t of inactive) {
        lines.push(`⚫ <code>${t.mint.slice(0, 12)}...</code> — ${escHtml(t.symbol)}`)
      }
    }

    await reply(msg, lines.join('\n'))
  })

  // ── /wallets ──────────────────────────────────────────────────────────────
  bot.onText(/\/wallets$/, async msg => {
    if (!isAuthorized(msg.chat.id)) return

    const wallets = await db.getWallets()
    if (wallets.length === 0) {
      await reply(
        msg,
        `📭 No wallets tracked yet.\nUse <code>/addwallet nik|josh &lt;address&gt;</code> to add one.`
      )
      return
    }

    const lines: string[] = [`<b>Tracked Wallets (${wallets.length})</b>`, ``]
    for (const w of wallets) {
      const holdings = await db.getWalletHoldings(w.address)
      lines.push(
        `👤 <b>${escHtml(w.label)}</b>  (${holdings.length} holdings)`,
        `   <code>${w.address}</code>`,
        ``
      )
    }

    await reply(msg, lines.join('\n'))
  })

  // ── /addwallet <owner> <address> ──────────────────────────────────────────
  bot.onText(/\/addwallet (\S+) (\S+)/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return

    const ownerLabel = match?.[1]?.toLowerCase().trim()
    const address = match?.[2]?.trim()

    if (!ownerLabel || !address) {
      await reply(msg, `❌ Usage: <code>/addwallet &lt;nik|josh&gt; &lt;wallet_address&gt;</code>`)
      return
    }

    if (!isValidSolanaAddress(address)) {
      await reply(msg, `❌ Invalid Solana wallet address.`)
      return
    }

    // Look up the owner's chat ID from config
    const owner = config.telegram.users.find(u => u.name.toLowerCase() === ownerLabel)
    if (!owner) {
      const knownNames = config.telegram.users.map(u => u.name).join(', ') || 'none configured'
      await reply(
        msg,
        `❌ Unknown owner <b>${escHtml(ownerLabel)}</b>.\nKnown users: ${knownNames}\n\nMake sure NIK_CHAT_ID / JOSH_CHAT_ID are set on Render.`
      )
      return
    }

    const added = await db.addWallet(address, ownerLabel, owner.chatId)
    if (!added) {
      await reply(msg, `ℹ️ Wallet already tracked: <code>${address}</code>`)
      return
    }

    // Sync Helius webhook to include the new address
    syncWebhook().catch(err => console.error('[Bot] Webhook sync error:', err))

    await reply(
      msg,
      [
        `✅ <b>Wallet added for ${escHtml(ownerLabel)}:</b>`,
        `<code>${address}</code>`,
        ``,
        `Holdings will be detected in real-time via Helius webhook.`,
      ].join('\n')
    )
  })

  // ── /removewallet <address> ───────────────────────────────────────────────
  bot.onText(/\/removewallet (\S+)/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return

    const address = match?.[1]?.trim()
    if (!address) {
      await reply(msg, `❌ Usage: <code>/removewallet &lt;wallet_address&gt;</code>`)
      return
    }

    const removed = await db.removeWallet(address)
    if (!removed) {
      await reply(msg, `ℹ️ Wallet not found: <code>${address}</code>`)
      return
    }

    // Sync Helius webhook to remove the address
    syncWebhook().catch(err => console.error('[Bot] Webhook sync error:', err))

    await reply(msg, `🗑 Stopped tracking wallet <code>${address}</code>`)
  })

  // ── /status ───────────────────────────────────────────────────────────────
  bot.onText(/\/status/, async msg => {
    if (!isAuthorized(msg.chat.id)) return

    const s = await getStatus()
    const uptime = formatDuration(s.uptime)
    const lastPoll = s.lastPollAt
      ? `${Math.round((Date.now() - s.lastPollAt) / 1000)}s ago`
      : 'never'

    const walletCount = (await db.getWallets()).length

    await reply(
      msg,
      [
        `<b>Monitor Status</b>`,
        ``,
        `⏱ Uptime: <b>${uptime}</b>`,
        `👁 On-chain subs: <b>${s.onchainSubscriptions}</b>`,
        `📡 Last DexScr poll: <b>${lastPoll}</b>`,
        `🪙 Tracked tokens: <b>${s.trackedTokens}</b>`,
        `👛 Tracked wallets: <b>${walletCount}</b>`,
        ``,
        `RPC: <code>${config.solana.rpcUrl.slice(0, 40)}...</code>`,
      ].join('\n')
    )
  })

  // ── /thresholds ───────────────────────────────────────────────────────────
  bot.onText(/\/thresholds/, async msg => {
    if (!isAuthorized(msg.chat.id)) return
    await reply(
      msg,
      [
        `<b>Alert Thresholds</b>`,
        ``,
        `📈 Price change: <b>${config.alerts.priceChangePercent}%</b> in 5 min`,
        `🛒 Buy count: <b>${config.alerts.buyCountThreshold}</b> in ${config.alerts.buyCountWindowMinutes} min`,
        `⏳ Cooldown: <b>${config.alerts.cooldownMinutes} min</b> per token`,
        `🔄 Poll interval: <b>${config.alerts.pollIntervalSeconds}s</b>`,
        ``,
        `Change with: <code>/set pricechange &lt;%&gt;</code>`,
        `or <code>/set buycount &lt;n&gt;</code>`,
        `or <code>/set cooldown &lt;min&gt;</code>`,
      ].join('\n')
    )
  })

  // ── /set <key> <value> ────────────────────────────────────────────────────
  bot.onText(/\/set (\w+) (\S+)/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return

    const key = match?.[1]?.toLowerCase()
    const val = Number(match?.[2])

    if (isNaN(val) || val <= 0) {
      await reply(msg, `❌ Invalid value. Must be a positive number.`)
      return
    }

    switch (key) {
      case 'pricechange':
        config.alerts.priceChangePercent = val
        await reply(msg, `✅ Price change threshold set to <b>${val}%</b>`)
        break
      case 'buycount':
        config.alerts.buyCountThreshold = Math.round(val)
        await reply(msg, `✅ Buy count threshold set to <b>${Math.round(val)}</b>`)
        break
      case 'cooldown':
        config.alerts.cooldownMinutes = val
        await reply(msg, `✅ Alert cooldown set to <b>${val} min</b>`)
        break
      default:
        await reply(
          msg,
          `❌ Unknown setting. Use: <code>pricechange</code>, <code>buycount</code>, or <code>cooldown</code>`
        )
    }
  })

  // ── /og <name or symbol> ──────────────────────────────────────────────────
  bot.onText(/\/og (.+)/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return

    const term = match?.[1]?.trim()
    if (!term) {
      await reply(msg, `❌ Usage: <code>/og &lt;token name or symbol&gt;</code>`)
      return
    }

    await reply(msg, `🔍 Searching pump.fun for "<b>${escHtml(term)}</b>"…`)

    const results = await searchAllByName(term)
    if (results.length === 0) {
      await reply(msg, `ℹ️ No tokens found matching "<b>${escHtml(term)}</b>"`)
      return
    }

    const lines: string[] = [
      `<b>OG Token Search: "${escHtml(term)}"</b>`,
      `Sorted oldest → newest (${results.length} found)`,
      ``,
    ]

    for (const [i, t] of results.slice(0, 8).entries()) {
      const mc = t.marketCapUsd > 0 ? `$${fmtNum(t.marketCapUsd)}` : 'no MC'
      const badge = i === 0 ? `👑 OG  ` : `${i + 1}.   `
      lines.push(
        `${badge}<b>${escHtml(t.name)}</b>  $${escHtml(t.symbol)}`,
        `   ⏳ Age: <b>${fmtAge(t.ageHours)}</b>  💎 MC: <b>${mc}</b>`,
        `   <code>${t.mint}</code>`,
        `   <a href="https://axiom.trade/t/${t.mint}">Axiom</a>  |  <a href="https://dexscreener.com/solana/${t.mint}">DexScr</a>  |  <a href="https://pump.fun/${t.mint}">pump.fun</a>`,
        ``
      )
    }

    await reply(msg, lines.join('\n'))
  })

  console.log('[Bot] Telegram bot commands registered.')
}

/** Fetch pump.fun metadata for a mint, then check for an older OG token.
 *  Sends a follow-up Telegram message if one is found. */
async function checkForOg(bot: TelegramBot, chatId: string, mint: string): Promise<void> {
  const coin = await fetchPumpCoin(mint)
  if (!coin?.name || coin.name === 'Unknown') return

  const og = await findOgToken(mint, coin.name, coin.symbol, coin.created_timestamp)
  if (!og) return

  const mcStr = og.marketCapUsd > 0 ? `$${fmtNum(og.marketCapUsd)}` : 'unknown MC'

  const text = [
    `⚠️ <b>OG TOKEN DETECTED!</b>`,
    ``,
    `The token you added (<b>${escHtml(coin.name)}</b> $${escHtml(coin.symbol)}) has an older version on pump.fun:`,
    ``,
    `<b>${escHtml(og.name)}</b>  $${escHtml(og.symbol)}`,
    `<code>${og.mint}</code>`,
    `⏳ Age: <b>${fmtAge(og.ageHours)} old</b>`,
    `💎 MC: <b>${mcStr}</b>`,
    ``,
    `⚡ Community attention may shift to this OG — consider tracking it too.`,
    ``,
    [
      `<a href="https://axiom.trade/t/${og.mint}">📊 Axiom</a>`,
      `<a href="https://dexscreener.com/solana/${og.mint}">📈 DexScr</a>`,
      `<a href="https://pump.fun/${og.mint}">🎱 pump.fun</a>`,
    ].join('  |  '),
  ].join('\n')

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
}

function isValidSolanaAddress(addr: string): boolean {
  try {
    new PublicKey(addr)
    return true
  } catch {
    return false
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(2)
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
