export interface Token {
  mint: string
  name: string
  symbol: string
  priceUsd: string | null
  marketCap: number | null
  addedAt: number
  active: boolean
  source?: 'manual' | 'wallet'
  walletSource?: string | null
}

export interface User {
  name: string
  chatId: string
}

export interface Wallet {
  address: string
  label: string
  ownerChatId: string
  addedAt: number
}

export interface WalletHolding {
  walletAddress: string
  mint: string
  amount: number
  updatedAt: number
}

export interface BondingCurveState {
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  realSolReserves: bigint
  tokenTotalSupply: bigint
  complete: boolean
}

export interface OnChainBuyEvent {
  mint: string
  solAmount: number      // SOL spent in this buy
  priceChangePct: number // % change in price ratio for this trade
  bondingCurve: string   // bonding curve address
}

export interface DexScreenerPair {
  chainId: string
  dexId: string
  pairAddress: string
  baseToken: {
    address: string
    name: string
    symbol: string
  }
  priceUsd: string
  priceChange: {
    m5?: number
    h1?: number
    h6?: number
    h24?: number
  }
  txns: {
    m5?: { buys: number; sells: number }
    h1?: { buys: number; sells: number }
    h24?: { buys: number; sells: number }
  }
  volume: {
    m5?: number
    h1?: number
    h24?: number
  }
  liquidity?: {
    usd?: number
  }
  fdv?: number
  marketCap?: number
}

export interface AlertData {
  mint: string
  name: string
  symbol: string
  buyCount?: number
  priceChangePct?: number
  solAmount?: number
  volumeUsd?: number
  marketCapUsd?: number
  priceUsd?: string
  source: 'onchain' | 'dexscreener'
}

export interface MonitorStatus {
  trackedTokens: number
  onchainSubscriptions: number
  lastPollAt: number | null
  uptime: number
  startedAt: number
}

export interface RecentAlert {
  id: number
  mint: string
  symbol: string
  name: string
  alertType: string
  sentAt: number
}
