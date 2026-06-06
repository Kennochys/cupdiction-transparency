import { NextResponse } from 'next/server'
import { supabaseAdmin } from '../../../../lib/supabase'
import { sendAdminAlert } from '../../../../lib/alert'
import { recordBurnContribution } from '../../../../lib/burn'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// Cron (every 5 min): resolve pump.fun volume races past their deadline.
//
// Volume is the sum of the 5-min (m5) DexScreener snapshots captured during the
// race window. Three guards keep money settlement fair under real cron jitter
// and flaky upstream data:
//   1. PAIRED buckets only — a 5-min bucket counts for BOTH tokens or neither,
//      so a snapshot that lands for one token but not the other can't bias it.
//   2. Coverage guard — too few paired buckets vs the window → manual review.
//   3. Decisiveness guard — both-zero or a sub-margin near-tie → manual review.
//   YES  — token A volume > token B volume
//   NO   — token B volume > token A volume
//   needs_review — tie/thin margin, sparse coverage, or no usable snapshots
// ─────────────────────────────────────────────────────────────────────────────

const CRON_SECRET = process.env.CRON_SECRET

function isAuthorized(request) {
  if (!CRON_SECRET) return false
  const header = request.headers.get('authorization') || ''
  return header.replace(/^Bearer\s+/i, '') === CRON_SECRET
}

async function resolveRace(db, race, now) {
  // Skip if core market already resolved (avoid duplicate settlement)
  if (race.markets?.status === 'resolved') {
    return {
      action: 'skip',
      update: {
        oracle_status: 'resolved',
        resolved_at: now,
        resolution_reason: `Core market already resolved as ${race.markets.res || 'unknown'}.`,
        outcome_token_mint: race.markets.res === 'YES' ? race.token_a_mint
          : race.markets.res === 'NO' ? race.token_b_mint : null,
      },
    }
  }

  // Pull the m5 snapshots captured during the race window. captured_bucket is the
  // 5-min-aligned key and is unique per (token, bucket) via the snapshot upsert,
  // so there is no double-counting even if the cron fired twice in one bucket.
  const windowStart = race.market_window_started_at || race.created_at
  const { data: snaps, error: snapErr } = await db
    .from('pumpfun_volume_snapshots')
    .select('token_mint, volume_usd, captured_bucket')
    .in('token_mint', [race.token_a_mint, race.token_b_mint])
    .gt('captured_at', windowStart)
    .lte('captured_at', race.deadline_at)
  if (snapErr) throw snapErr

  // No snapshots captured in window yet → retry (cron may not have run during a very fresh race)
  if (!snaps || snaps.length === 0) {
    return {
      action: 'pending_recheck',
      update: {
        oracle_status: 'pending_recheck',
        resolution_reason: 'No volume snapshots captured during window yet; retry next cron.',
      },
    }
  }

  // Sum only PAIRED buckets — a 5-min bucket must have a snapshot for both tokens
  // to count. An asymmetric bucket (one token's fetch failed) would otherwise tilt
  // the total toward the better-covered token and hand it an unfair win.
  const byBucket = new Map()
  for (const s of snaps) {
    const slot = byBucket.get(s.captured_bucket) || {}
    slot[s.token_mint] = Number(s.volume_usd) || 0
    byBucket.set(s.captured_bucket, slot)
  }
  let volA = 0, volB = 0, pairedBuckets = 0
  for (const slot of byBucket.values()) {
    const a = slot[race.token_a_mint]
    const b = slot[race.token_b_mint]
    if (a == null || b == null) continue   // asymmetric coverage → skip for both
    volA += a; volB += b; pairedBuckets++
  }

  const baseUpdate = { end_volume_a_usd: volA, end_volume_b_usd: volB }

  // Coverage guard: require paired samples over at least ~half the window
  // (≈duration/5min buckets) so money never settles off one or two lucky reads.
  const expectedBuckets = Math.max(1, Math.round((race.duration_seconds || 1800) / 300))
  const minPaired = Math.max(1, Math.ceil(expectedBuckets / 2))
  if (pairedBuckets < minPaired) {
    return {
      action: 'needs_review',
      update: { ...baseUpdate, oracle_status: 'needs_review', resolution_reason: `Insufficient paired volume coverage (${pairedBuckets}/${expectedBuckets} buckets); manual review.` },
    }
  }

  // Decisiveness guard: both-zero or a margin too thin to call off noisy 5-min
  // samples → manual review instead of a coin-flip settlement.
  const hi = Math.max(volA, volB)
  const lo = Math.min(volA, volB)
  const MIN_DECISIVE_RATIO = 0.005   // winner must lead by > 0.5% of the larger total
  if (hi === 0 || (hi - lo) <= hi * MIN_DECISIVE_RATIO) {
    return {
      action: 'needs_review',
      update: { ...baseUpdate, oracle_status: 'needs_review', resolution_reason: hi === 0 ? 'No measurable volume on either token; manual review.' : 'Volumes within the decisiveness margin; manual review.' },
    }
  }

  const outcome = volA > volB ? 'YES' : 'NO'
  const winnerMint = volA > volB ? race.token_a_mint : race.token_b_mint
  return {
    action: 'settle',
    outcome,
    update: {
      ...baseUpdate,
      oracle_status: 'resolved',
      outcome_token_mint: winnerMint,
      resolution_reason: `Volume winner: ${outcome === 'YES' ? 'token A' : 'token B'} ($${Math.round(hi).toLocaleString()} vs $${Math.round(lo).toLocaleString()}) over ${pairedBuckets} paired 5-min buckets.`,
      resolved_at: now,
    },
  }
}

async function runResolve() {
  const db = supabaseAdmin()
  const now = new Date().toISOString()

  const { data: races, error } = await db
    .from('pumpfun_volume_races')
    .select(`
      id, market_id, token_a_mint, token_a_symbol, token_b_mint, token_b_symbol,
      duration_seconds, deadline_at, oracle_status, market_window_started_at, created_at,
      markets!market_id ( status, res )
    `)
    .in('oracle_status', ['open', 'pending_recheck'])
    .lte('deadline_at', now)

  if (error) throw error
  const summary = { candidates: races?.length || 0, settled: 0, pending_recheck: 0, needs_review: 0, skipped: 0, errors: 0 }
  if (!races?.length) return { ...summary, finished_at: now }

  for (const race of races) {
    let decision
    try {
      decision = await resolveRace(db, race, now)
    } catch (err) {
      console.error('[pumpfun-resolve] resolveRace threw:', race.market_id, err?.message)
      await db.from('pumpfun_volume_races').update({
        oracle_status: 'pending_recheck',
        resolution_reason: 'Resolver exception; retry next cron.',
      }).eq('id', race.id)
      summary.pending_recheck++
      continue
    }

    if (decision.action === 'settle') {
      try {
        const { error: settleErr } = await db.rpc('settle_market', { p_market_id: race.market_id, p_result: decision.outcome })
        if (settleErr) throw settleErr
        await db.from('pumpfun_volume_races').update(decision.update).eq('id', race.id)
        summary.settled++
        console.log(`[pumpfun-resolve] SETTLED market=${race.market_id} outcome=${decision.outcome}`)
        // Community burn: credit the winning token's weekly pool (best-effort).
        await recordBurnContribution(db, {
          market_id: race.market_id,
          product: 'battle',
          token_mint: decision.update.outcome_token_mint,
          token_symbol: decision.outcome === 'YES' ? race.token_a_symbol : race.token_b_symbol,
        })
      } catch (err) {
        console.error('[pumpfun-resolve] settle failed:', race.market_id, err?.message)
        await db.from('pumpfun_volume_races').update({
          ...decision.update,
          oracle_status: 'pending_recheck',
          resolved_at: null,
          resolution_reason: `Settlement failed: ${err?.message || 'unknown'}`,
        }).eq('id', race.id)
        summary.errors++
      }
    } else if (decision.action === 'pending_recheck') {
      await db.from('pumpfun_volume_races').update(decision.update).eq('id', race.id)
      summary.pending_recheck++
    } else if (decision.action === 'needs_review') {
      await db.from('pumpfun_volume_races').update(decision.update).eq('id', race.id)
      summary.needs_review++
      await sendAdminAlert({
        title: 'Pump.fun volume race needs review',
        body: `Market **${race.market_id}** cannot be auto-settled.`,
        severity: 'error',
        fields: [
          { name: 'Market ID', value: race.market_id },
          { name: 'Token A', value: race.token_a_symbol || race.token_a_mint },
          { name: 'Token B', value: race.token_b_symbol || race.token_b_mint },
          { name: 'Reason', value: decision.update?.resolution_reason || 'needs_review' },
        ],
      })
    } else if (decision.action === 'skip') {
      await db.from('pumpfun_volume_races').update(decision.update).eq('id', race.id)
      summary.skipped++
    }
  }

  return { ...summary, finished_at: now }
}

export async function GET(request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await runResolve())
  } catch (err) {
    console.error('[pumpfun-resolve]', err)
    return NextResponse.json({ error: err?.message || 'pumpfun-resolve failed' }, { status: 500 })
  }
}

export const POST = GET
