// Anti-manipulation: minimum on-chain liquidity for a token to host a market.
// Thin/illiquid tokens are cheap to push at settlement, so we don't let them
// become Up/Down or Battle markets in the first place. Tune via env.
export const MARKET_MIN_LIQUIDITY_USD = Number(process.env.MARKET_MIN_LIQUIDITY_USD || 20000)

// True only when DexScreener reports liquidity AND it clears the floor.
// Note the strict form: a token with UNKNOWN/missing liquidity does NOT pass
// (an unreported pool is exactly the kind we can't trust at settlement).
export function hasMinLiquidity(tokenData, floor = MARKET_MIN_LIQUIDITY_USD) {
  const liq = Number(tokenData?.liquidityUsd)
  return Number.isFinite(liq) && liq >= floor
}
