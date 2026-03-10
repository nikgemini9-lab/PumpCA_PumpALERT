/**
 * Telegram bot
 *
 * Commands:
 *   /start           — Welcome + show chat ID
 *   /add <CA>        — Add a token CA to track
 *   /remove <CA>     — Stop tracking a token
 *   /list            — Show all tracked tokens
 *   /status          — Show monitor health
 *   /thresholds      — Show alert thresholds
 *   /set <key> <val> — Change a threshold at runtime
 *   /help            — Command reference
 */

import TelegramBot from 'node-telegram-bot-api'
import { PublicKey } from '@solana/web3.js'
import { config } from './config'
import * as db from './database'
import { SolanaMonitor } from './monitor'
import { MonitorStatus } from './types'

export function setupBot(
  bot: TelegramBot,
  monitor: SolanaMonitor,
  getStatus: () => MonitorStatus
): void {
  const allowedChatId = config.telegram.chatId

  function isAuthorized(chatId: string | number): boolean {
    if (!allowedChatId) return true // no restriction set
    return String(chatId) === String(allowedChatId)
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
        : `⚠️ Set <code>TELEGRAM_CHAT_ID=${chatId}</code> in your environment to enable alerts.`,
      ``,
      `<b>Commands:</b>`,
      `/add &lt;CA&gt; — Track a token`,
      `/remove &lt;CA&gt; — Stop tracking`,
      `/list — Show tracked tokens`,
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
        `  Add a pump.fun token CA to your watchlist`,
        ``,
        `<code>/remove &lt;CA&gt;</code>`,
        `  Remove a token from your watchlist`,
        ``,
        `<code>/list</code>`,
        `  Show all tracked tokens with stats`,
        ``,
        `<code>/status</code>`,
        `  WebSocket subs, uptime, last poll`,
        ``,
        `<code>/thresholds</code>`,
        `  Show current alert thresholds`,
        ``,
        `<code>/set pricechange &lt;%&gt;</code>`,
        `  Set price-change alert threshold (e.g. /set pricechange 20)`,
        ``,
        `<code>/set buycount &lt;n&gt;</code>`,
        `  Set buy-count alert threshold (e.g. /set buycount 8)`,
        ``,
        `<code>/set cooldown &lt;min&gt;</code>`,
        `  Set cooldown between alerts per token`,
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

    const added = db.addToken(mint)
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
  })

  // ── /remove <CA> ─────────────────────────────────────────────────────────
  bot.onText(/\/remove (.+)/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return

    const mint = match?.[1]?.trim()
    if (!mint) {
      await reply(msg, `❌ Usage: <code>/remove &lt;TOKEN_CA&gt;</code>`)
      return
    }

    const removed = db.removeToken(mint)
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

    const tokens = db.getAllTokens()
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
      const alertCount = db.getAlertCount(t.mint)
      lines.push(
        `🟢 <b>${escHtml(t.symbol)}</b> — ${escHtml(t.name)}`,
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

  // ── /status ───────────────────────────────────────────────────────────────
  bot.onText(/\/status/, async msg => {
    if (!isAuthorized(msg.chat.id)) return

    const s = getStatus()
    const uptime = formatDuration(s.uptime)
    const lastPoll = s.lastPollAt
      ? `${Math.round((Date.now() - s.lastPollAt) / 1000)}s ago`
      : 'never'

    await reply(
      msg,
      [
        `<b>Monitor Status</b>`,
        ``,
        `⏱ Uptime: <b>${uptime}</b>`,
        `👁 On-chain subs: <b>${s.onchainSubscriptions}</b>`,
        `📡 Last DexScr poll: <b>${lastPoll}</b>`,
        `🪙 Tracked tokens: <b>${s.trackedTokens}</b>`,
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

  console.log('[Bot] Telegram bot commands registered.')
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
