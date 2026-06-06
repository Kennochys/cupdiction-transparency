import { supabaseAdmin } from './supabase'

// Fraction of a market's collected fees routed to its token's burn pool.
// V1: no creator/referrer is paid yet, so unclaimed distribution rolls into the
// burn — we route half of every market's fees to the pool. (V2: a clean
// 0.5%-of-volume slot once the full fee engine lands.)
export const BURN_RATE = 0.5

// UTC week start (Monday 00:00) as YYYY-MM-DD — the weekly burn window key.
export function weekStart(d = new Date()) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const mondayOffset = (dt.getUTCDay() + 6) % 7 // Sun=6 … Mon=0
  dt.setUTCDate(dt.getUTCDate() - mondayOffset)
  return dt.toISOString().slice(0, 10)
}

// Record one settled market's contribution to its token's burn pool. Best-effort
// and deduped by market_id (a market settles once) so cron re-runs never double
// count. Safe to call inside a settlement loop — never throws.
export async function recordBurnContribution(db, { market_id, product, token_mint, token_symbol }) {
  try {
    if (!market_id || !token_mint) return { ok: false }
    const { data: rows, error } = await db
      .from('orders')
      .select('fee')
      .eq('market_id', market_id)
      .eq('status', 'filled')
      .eq('currency', 'USDC')
    if (error) throw error
    const fees = (rows || []).reduce((s, r) => s + Number(r.fee || 0), 0)
    const burnUsdc = +(fees * BURN_RATE).toFixed(6)
    const { error: insErr } = await db.from('burn_ledger').insert({
      market_id,
      product,
      token_mint,
      token_symbol: token_symbol || null,
      burn_usdc: burnUsdc,
      week_start: weekStart(),
    })
    // 23505 = already recorded for this market — expected on re-run, ignore.
    if (insErr && insErr.code !== '23505') throw insErr
    return { ok: true, burnUsdc }
  } catch (e) {
    console.warn('[burn] contribution failed', market_id, e?.message)
    return { ok: false }
  }
}

// Weekly leaderboard: tokens ranked by accrued Burn Bounty pool (USDC), desc.
export async function getBountyLeaderboard(week = weekStart()) {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('burn_ledger')
    .select('token_mint, token_symbol, burn_usdc, product')
    .eq('week_start', week)
  if (error) throw error

  const byToken = new Map()
  for (const r of data || []) {
    const cur = byToken.get(r.token_mint) || {
      token_mint: r.token_mint, token_symbol: r.token_symbol, pool_usdc: 0, battles: 0, rounds: 0,
    }
    cur.pool_usdc += Number(r.burn_usdc || 0)
    if (r.product === 'battle') cur.battles += 1
    else cur.rounds += 1
    if (!cur.token_symbol && r.token_symbol) cur.token_symbol = r.token_symbol
    byToken.set(r.token_mint, cur)
  }
  return Array.from(byToken.values())
    .map((t) => ({ ...t, pool_usdc: +t.pool_usdc.toFixed(6) }))
    .sort((a, b) => b.pool_usdc - a.pool_usdc)
}

// All-time pool + recent executed burns (the public proof).
export async function getBurnSummary() {
  const db = supabaseAdmin()
  const [{ data: led }, { data: evs }] = await Promise.all([
    db.from('burn_ledger').select('burn_usdc'),
    db.from('burn_events')
      .select('week_start, token_symbol, token_mint, usdc_spent, token_burned, burn_tx, status, executed_at')
      .eq('status', 'burned')
      .order('executed_at', { ascending: false })
      .limit(20),
  ])
  const allTimePool = (led || []).reduce((s, r) => s + Number(r.burn_usdc || 0), 0)
  const totalBurnedUsdc = (evs || []).reduce((s, r) => s + Number(r.usdc_spent || 0), 0)
  return {
    allTimePoolUsdc: +allTimePool.toFixed(2),
    totalBurnedUsdc: +totalBurnedUsdc.toFixed(2),
    burns: evs || [],
  }
}

// Next weekly burn boundary (next Monday 00:00 UTC) — for the countdown.
export function nextBurnAt() {
  const now = new Date()
  const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const daysUntilMonday = ((8 - dt.getUTCDay()) % 7) || 7
  dt.setUTCDate(dt.getUTCDate() + daysUntilMonday)
  return dt.toISOString()
}
