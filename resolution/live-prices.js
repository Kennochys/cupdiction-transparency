import { supabaseAdmin } from './supabase'
import { fetchPumpfunTokenData } from './pumpfun-api'

// Rows older than this are treated as stale (worker likely down) → ignored / fallback.
const FRESH_MS = 60_000

// Batch-read worker-fed prices for many mints. Returns Map<mint, price_usd> (fresh only).
export async function getLivePrices(mints) {
  const out = new Map()
  const list = [...new Set((mints || []).filter(Boolean))]
  if (!list.length) return out
  try {
    const db = supabaseAdmin()
    const { data } = await db.from('live_prices').select('mint, price_usd, updated_at').in('mint', list)
    const cutoff = Date.now() - FRESH_MS
    for (const r of data || []) {
      if (new Date(r.updated_at).getTime() >= cutoff && Number(r.price_usd) > 0) {
        out.set(r.mint, Number(r.price_usd))
      }
    }
  } catch { /* fall through → caller handles empty map */ }
  return out
}

// ── Writer side (used by the price cron / standalone worker) ──────────────────
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
function pickPair(pairs) {
  const sol = (pairs || []).filter((p) => String(p?.chainId || '').toLowerCase() === 'solana')
  if (!sol.length) return null
  return sol.find((p) => ['pumpfun', 'pumpswap'].includes(String(p?.dexId || '').toLowerCase()))
    || sol.slice().sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0]
}

// Mints of every active Up/Down market — the set the price feed keeps fresh.
export async function getActiveUpdownMints() {
  const db = supabaseAdmin()
  const { data } = await db.from('updown_markets').select('token_mint').in('oracle_status', ['open', 'pending_recheck'])
  return [...new Set((data || []).map((r) => r.token_mint).filter(Boolean))]
}

// One batched DexScreener pull → upsert live_prices. Returns rows written.
export async function refreshLivePrices(mints) {
  const list = [...new Set((mints || []).filter(Boolean))]
  if (!list.length) return 0
  const db = supabaseAdmin()
  let written = 0
  for (const batch of chunk(list, 30)) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`, { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!res.ok) continue
      const data = await res.json()
      const byMint = new Map()
      for (const p of data?.pairs || []) {
        const mint = p?.baseToken?.address
        if (!mint || !batch.includes(mint)) continue
        if (!byMint.has(mint)) byMint.set(mint, [])
        byMint.get(mint).push(p)
      }
      const rows = []
      const nowIso = new Date().toISOString()
      for (const [mint, prs] of byMint) {
        const price = Number(pickPair(prs)?.priceUsd)
        if (Number.isFinite(price) && price > 0) rows.push({ mint, price_usd: price, source: 'dexscreener', updated_at: nowIso })
      }
      if (rows.length) {
        const { error } = await db.from('live_prices').upsert(rows, { onConflict: 'mint' })
        if (!error) written += rows.length
      }
    } catch { /* skip batch */ }
  }
  return written
}

// Round model: when a window's entry phase ends (now >= lock_at) and its start
// price hasn't been captured yet, snapshot the current live price as the start.
// Everyone who entered did so blind from this same line. Returns count locked.
export async function lockUpdownStartPrices() {
  const db = supabaseAdmin()
  const nowIso = new Date().toISOString()
  const { data } = await db.from('updown_markets')
    .select('id, token_mint')
    .eq('oracle_status', 'open')
    .is('start_price_usd', null)
    .not('lock_at', 'is', null)
    .lte('lock_at', nowIso)
    .limit(100)
  if (!data?.length) return 0
  const prices = await getLivePrices(data.map((r) => r.token_mint))
  let locked = 0
  for (const r of data) {
    const px = prices.get(r.token_mint)
    if (Number.isFinite(px) && px > 0) {
      const { error } = await db.from('updown_markets').update({ start_price_usd: px }).eq('id', r.id)
      if (!error) locked++
    }
  }
  return locked
}

// Append a time-series point per mint to updown_price_history, copied from the
// fresh live_prices rows (no extra DexScreener calls). Feeds the Up/Down chart so
// it loads a real intra-window curve instead of a 2-point straight line.
export async function recordPriceHistory(mints) {
  const list = [...new Set((mints || []).filter(Boolean))]
  if (!list.length) return 0
  const db = supabaseAdmin()
  const { data } = await db.from('live_prices').select('mint, price_usd, updated_at').in('mint', list)
  const cutoff = Date.now() - FRESH_MS
  const rows = (data || [])
    .filter((r) => new Date(r.updated_at).getTime() >= cutoff && Number(r.price_usd) > 0)
    .map((r) => ({ mint: r.mint, price_usd: Number(r.price_usd) }))
  if (!rows.length) return 0
  const { error } = await db.from('updown_price_history').insert(rows)
  return error ? 0 : rows.length
}

// Drop stale chart points (kept short — longest window is 30m).
export async function prunePriceHistory(olderThanMs = 6 * 60 * 60_000) {
  try {
    const db = supabaseAdmin()
    await db.from('updown_price_history').delete().lt('captured_at', new Date(Date.now() - olderThanMs).toISOString())
  } catch { /* best effort */ }
}

// Snipe-resistant settlement price: the MEDIAN of recent price points (last
// ~2 min) from updown_price_history. A single-tick manipulation at the deadline
// becomes one outlier and is discarded — to move the median a manipulator would
// have to hold the pushed price across most of the window (≈10 samples at ~12s
// each), which is far more expensive than a one-block spike.
//
// Falls back to a single fresh read only when too few points exist (price worker
// sparse/down) so settlement never blocks.
export async function getSettlementPrice(mint, { windowMs = 120_000, minPoints = 5 } = {}) {
  try {
    const db = supabaseAdmin()
    const since = new Date(Date.now() - windowMs).toISOString()
    const { data } = await db.from('updown_price_history')
      .select('price_usd')
      .eq('mint', mint)
      .gte('captured_at', since)
      .order('captured_at', { ascending: false })
      .limit(40)
    const prices = (data || []).map((r) => Number(r.price_usd)).filter((p) => Number.isFinite(p) && p > 0)
    if (prices.length >= minPoints) {
      const sorted = prices.slice().sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
      return { price: median, source: 'median', points: prices.length }
    }
  } catch { /* fall through to single read */ }
  const fb = await getLivePriceWithFallback(mint)
  return { ...fb, points: 0 }
}

// Single fresh price with a direct-DexScreener fallback. Used by the settlement resolver
// so settlement never blocks when the worker is down.
export async function getLivePriceWithFallback(mint) {
  const m = await getLivePrices([mint])
  const live = m.get(mint)
  if (Number.isFinite(live) && live > 0) return { price: live, source: 'live_prices' }
  const data = await fetchPumpfunTokenData(mint)
  const px = Number(data?.priceUsd)
  return (Number.isFinite(px) && px > 0)
    ? { price: px, source: 'dexscreener_fallback' }
    : { price: null, source: 'none' }
}
