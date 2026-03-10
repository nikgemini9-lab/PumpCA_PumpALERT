/**
 * pump.fun bonding curve utilities
 *
 * Bonding curve account layout (Anchor, little-endian):
 *   [0..7]   discriminator
 *   [8..15]  virtualTokenReserves  (u64, raw token units with 6 decimals)
 *   [16..23] virtualSolReserves    (u64, lamports)
 *   [24..31] realTokenReserves     (u64)
 *   [32..39] realSolReserves       (u64, lamports)
 *   [40..47] tokenTotalSupply      (u64)
 *   [48]     complete              (bool)
 */

import { PublicKey } from '@solana/web3.js'
import { BondingCurveState } from './types'

export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')

export const PUMP_FUN_TOKEN_DECIMALS = 6
export const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000 // 1 billion tokens

export function getBondingCurveAddress(mint: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PUMP_FUN_PROGRAM_ID
  )
  return pda
}

export function decodeBondingCurve(data: Buffer): BondingCurveState | null {
  if (data.length < 49) return null
  try {
    return {
      virtualTokenReserves: data.readBigUInt64LE(8),
      virtualSolReserves: data.readBigUInt64LE(16),
      realTokenReserves: data.readBigUInt64LE(24),
      realSolReserves: data.readBigUInt64LE(32),
      tokenTotalSupply: data.readBigUInt64LE(40),
      complete: data[48] === 1,
    }
  } catch {
    return null
  }
}

/**
 * Price ratio: higher = more expensive token.
 * Use this to detect % change — absolute value is less meaningful.
 * ratio = virtualSolReserves / virtualTokenReserves (lamports per raw token unit)
 */
export function priceRatio(state: BondingCurveState): number {
  const vtr = Number(state.virtualTokenReserves)
  if (vtr === 0) return 0
  return Number(state.virtualSolReserves) / vtr
}

/**
 * Price in SOL per 1 token (human-readable token, accounting for 6 decimals)
 */
export function priceInSOL(state: BondingCurveState): number {
  return priceRatio(state) * 1_000 // multiply by 10^(9-6) = 1000 to convert lamports→SOL and adjust decimals
}

/**
 * Market cap in SOL (fully diluted)
 */
export function marketCapSOL(state: BondingCurveState): number {
  return priceInSOL(state) * PUMP_FUN_TOTAL_SUPPLY
}

/**
 * Detect if this is a buy (virtualSolReserves went up).
 * Returns null if can't determine.
 */
export function detectTradeDirection(
  prev: BondingCurveState,
  next: BondingCurveState
): 'buy' | 'sell' | null {
  if (next.virtualSolReserves > prev.virtualSolReserves) return 'buy'
  if (next.virtualSolReserves < prev.virtualSolReserves) return 'sell'
  return null
}

/**
 * SOL amount of the trade (absolute lamports difference → SOL)
 */
export function tradeAmountSOL(prev: BondingCurveState, next: BondingCurveState): number {
  const diff =
    next.virtualSolReserves > prev.virtualSolReserves
      ? next.virtualSolReserves - prev.virtualSolReserves
      : prev.virtualSolReserves - next.virtualSolReserves
  return Number(diff) / 1e9
}

/**
 * % price change between two states
 */
export function priceChangePct(prev: BondingCurveState, next: BondingCurveState): number {
  const prevRatio = priceRatio(prev)
  if (prevRatio === 0) return 0
  return ((priceRatio(next) - prevRatio) / prevRatio) * 100
}
