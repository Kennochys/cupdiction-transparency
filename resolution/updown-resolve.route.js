import { NextResponse } from 'next/server'
import { supabaseAdmin } from '../../../../lib/supabase'
import { getLivePriceWithFallback } from '../../../../lib/live-prices'
import { openUpDownWindow, hasOpenWindow } from '../../../../lib/updown'
import { recordBurnContribution } from '../../../../lib/burn'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

// Every-5-min cron: resolve Up/Down markets past deadline.
// YES = end price > start price, NO = end price < start. Equal → needs_review.

const CRON_SECRET = process.env.CRON_SECRET

function isAuthorized(request) {
  if (!CRON_SECRET) return false
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') === CRON_SECRET
}

async function resolveOne(db, m, now) {
  if (m.markets?.status === 'resolved') {
    return { action: 'skip', update: { oracle_status: 'resolved', resolved_at: now, resolution_reason: 'Core market already resolved.' } }
  }

  // Round model: if the lock price was never captured (token died during entry,
  // or a cron gap) there's no fair start line → void + refund, don't guess.
  const start = Number(m.start_price_usd)
  if (!Number.isFinite(start) || start <= 0) {
    return { action: 'void', update: { oracle_status: 'voided', resolved_at: now, auto_roll: false, resolution_reason: 'Lock price never captured — stakes refunded.' } }
  }

  const { price: endPrice } = await getLivePriceWithFallback(m.token_mint)
  if (!Number.isFinite(endPrice) || endPrice <= 0) {
    return { action: 'pending_recheck', update: { oracle_status: 'pending_recheck', resolution_reason: 'Price unavailable; retry next cron.' } }
  }

  const base = { end_price_usd: endPrice }

  if (endPrice === start) {
    // Flat = dead/static token, no real outcome → void & refund (and stop rolling it).
    return { action: 'void', update: { ...base, oracle_status: 'voided', resolved_at: now, auto_roll: false, resolution_reason: 'Flat (no price change) — stakes refunded.' } }
  }

  const outcome = endPrice > start ? 'YES' : 'NO'   // YES = UP
  const dir = endPrice > start ? 'UP' : 'DOWN'
  const pct = start > 0 ? (((endPrice - start) / start) * 100).toFixed(2) : '0'
  return {
    action: 'settle', outcome,
    update: {
      ...base, outcome: dir, oracle_status: 'resolved', resolved_at: now,
      resolution_reason: `${dir}: $${start} → $${endPrice} (${pct}%).`,
    },
  }
}

async function run() {
  const db = supabaseAdmin()
  const now = new Date().toISOString()
  const { data: rows, error } = await db
    .from('updown_markets')
    .select('id, market_id, token_mint, token_symbol, start_price_usd, deadline_at, oracle_status, auto_roll, duration_preset, markets!market_id ( status, res )')
    .in('oracle_status', ['open', 'pending_recheck'])
    .lte('deadline_at', now)
  if (error) throw error

  const summary = { candidates: rows?.length || 0, settled: 0, rolled: 0, voided: 0, swept: 0, pending_recheck: 0, skipped: 0, errors: 0 }

  // Sweep stuck markets → void + refund: clears the needs_review pile-up and any
  // pending_recheck stuck well past its deadline. Also stops dead tokens from rolling.
  const voidGrace = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  const [{ data: nr }, { data: pr }] = await Promise.all([
    db.from('updown_markets').select('id, market_id').eq('oracle_status', 'needs_review').limit(150),
    db.from('updown_markets').select('id, market_id').eq('oracle_status', 'pending_recheck').lt('deadline_at', voidGrace).limit(150),
  ])
  for (const s of [...(nr || []), ...(pr || [])]) {
    try {
      const { error: vErr } = await db.rpc('void_market', { p_market_id: s.market_id })
      if (vErr) throw vErr
      await db.from('updown_markets').update({ oracle_status: 'voided', auto_roll: false, resolved_at: now, resolution_reason: 'Voided — stuck/flat; stakes refunded.' }).eq('id', s.id)
      summary.swept++
    } catch (e) { console.warn('[updown-resolve] void sweep', s.market_id, e?.message) }
  }

  if (!rows?.length) return { ...summary, finished_at: now }

  for (const m of rows) {
    let decision
    try { decision = await resolveOne(db, m, now) }
    catch (err) {
      console.error('[updown-resolve] threw', m.market_id, err?.message)
      await db.from('updown_markets').update({ oracle_status: 'pending_recheck', resolution_reason: 'Resolver exception; retry.' }).eq('id', m.id)
      summary.pending_recheck++; continue
    }

    if (decision.action === 'settle') {
      try {
        const { error: settleErr } = await db.rpc('settle_market', { p_market_id: m.market_id, p_result: decision.outcome })
        if (settleErr) throw settleErr
        await db.from('updown_markets').update(decision.update).eq('id', m.id)
        summary.settled++
        // Community burn: credit this token's weekly pool (best-effort).
        await recordBurnContribution(db, {
          market_id: m.market_id,
          product: 'updown',
          token_mint: m.token_mint,
          token_symbol: m.token_symbol,
        })

        // Perpetual rolling (Polymarket-style): open the next window for the same
        // token + duration. Best-effort — if it fails (e.g. price blip), the fallback
        // auto-create cron backfills, so we never break the settle path.
        if (m.auto_roll) {
          try {
            if (!(await hasOpenWindow(db, m.token_mint, m.duration_preset))) {
              const r = await openUpDownWindow(db, { mint: m.token_mint, presetKey: m.duration_preset, autoRoll: true })
              if (r.error) console.warn('[updown-resolve] roll failed', m.token_mint, r.error)
              else summary.rolled++
            }
          } catch (rollErr) { console.warn('[updown-resolve] roll threw', m.token_mint, rollErr?.message) }
        }
      } catch (err) {
        await db.from('updown_markets').update({ ...decision.update, oracle_status: 'pending_recheck', resolved_at: null, resolution_reason: `Settle failed: ${err?.message}` }).eq('id', m.id)
        summary.errors++
      }
    } else if (decision.action === 'pending_recheck') {
      await db.from('updown_markets').update(decision.update).eq('id', m.id); summary.pending_recheck++
    } else if (decision.action === 'void') {
      try {
        const { error: vErr } = await db.rpc('void_market', { p_market_id: m.market_id })
        if (vErr) throw vErr
        await db.from('updown_markets').update(decision.update).eq('id', m.id)
        summary.voided++
      } catch (err) {
        await db.from('updown_markets').update({ oracle_status: 'pending_recheck', resolution_reason: `Void failed: ${err?.message}` }).eq('id', m.id)
        summary.errors++
      }
    } else {
      await db.from('updown_markets').update(decision.update).eq('id', m.id); summary.skipped++
    }
  }
  return { ...summary, finished_at: now }
}

export async function GET(request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { return NextResponse.json(await run()) }
  catch (err) { console.error('[updown-resolve]', err); return NextResponse.json({ error: err?.message || 'failed' }, { status: 500 }) }
}
export const POST = GET
