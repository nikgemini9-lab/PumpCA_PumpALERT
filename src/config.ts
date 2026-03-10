import dotenv from 'dotenv'
dotenv.config()

function required(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback
}

function optionalNumber(key: string, fallback: number): number {
  const v = process.env[key]
  return v ? Number(v) : fallback
}

const heliusKey = optional('HELIUS_API_KEY', '')
const customRpc = optional('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com')

function buildRpcUrl(): string {
  if (heliusKey) return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
  return customRpc
}

function buildWssUrl(): string {
  if (heliusKey) return `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`
  const http = buildRpcUrl()
  return http.replace(/^https?:\/\//, 'wss://')
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    chatId: optional('TELEGRAM_CHAT_ID', ''),
  },
  solana: {
    rpcUrl: buildRpcUrl(),
    wssUrl: buildWssUrl(),
    heliusApiKey: heliusKey,
  },
  alerts: {
    priceChangePercent: optionalNumber('PRICE_CHANGE_ALERT_PERCENT', 15),
    buyCountThreshold: optionalNumber('BUY_COUNT_ALERT', 5),
    buyCountWindowMinutes: optionalNumber('BUY_COUNT_WINDOW_MINUTES', 5),
    cooldownMinutes: optionalNumber('ALERT_COOLDOWN_MINUTES', 10),
    pollIntervalSeconds: optionalNumber('POLL_INTERVAL_SECONDS', 30),
  },
  port: optionalNumber('PORT', 3000),
}
