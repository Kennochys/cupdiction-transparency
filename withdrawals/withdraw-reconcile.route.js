import { NextResponse } from 'next/server'
import { Connection } from '@solana/web3.js'
import { supabaseAdmin } from '../../../../lib/supabase'
import { SOLANA_RPC_URL } from '../../../../lib/solana-rpc'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// Reconcile stuck withdrawals.
//
// The withdraw flow leaves an entry as 'pending' whenever the on-chain outcome is
// indeterminate (RPC timeout, uncertain confirmation). Those debits stay pending
// so the balance can't be re-spent — but something must eventually resolve them,
// or a user's balance is locked forever. This cron does that, safely.
//
// SAFETY RULE (same as the withdraw route): never restore a balance for a tx that
// might still confirm. We only:
//   • confirm   → tx landed (err == null)            → debit stands
//   • fail      → tx errored, OR was never submitted, OR is old AND has provably
//                 never landed (blockhash long expired) → debit reversed (refund)
//   • leave     → still indeterminate & recent        → retry next run
//
// 'failed' entries are excluded from the available-balance sum, so marking failed
// is exactly what restores the user's funds.
// ─────────────────────────────────────────────────────────────────────────────

const CRON_SECRET = process.env.CRON_SECRET
// Only touch entries older than this — don't race the live withdraw flow.
const MIN_AGE_MS = 5 * 60 * 1000
// A submitted tx that still can't be found after this long has provably never
// landed (its blockhash expired ~60-90s after signing), so it's safe to reverse.
const DROP_GRACE_MS = 20 * 60 * 1000
const BATCH = 50

function isAuthorized(request) {
  if (!CRON_SECRET) return false
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') === CRON_SECRET
}

export async function GET(request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const db = supabaseAdmin()
    const cutoff = new Date(Date.now() - MIN_AGE_MS).toISOString()

    const { data: rows, error } = await db
      .from('ledger_entries')
      .select('id, tx_signature, created_at')
      .eq('entry_type', 'withdrawal')
      .eq('status', 'pending')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(BATCH)
    if (error) throw error

    const summary = { checked: rows?.length || 0, confirmed: 0, failed: 0, left_pending: 0 }
    if (!rows?.length) return NextResponse.json({ ok: true, ...summary, finished_at: new Date().toISOString() })

    const connection = new Connection(SOLANA_RPC_URL, 'confirmed')
    const ageMs = (iso) => Date.now() - new Date(iso).getTime()

    for (const row of rows) {
      try {
        // Never submitted (no signature) → nothing moved on-chain → safe to reverse.
        if (!row.tx_signature) {
          await db.from('ledger_entries').update({ status: 'failed' }).eq('id', row.id)
          summary.failed++
          continue
        }

        const st = await connection.getSignatureStatus(row.tx_signature, { searchTransactionHistory: true })
        const v = st?.value
        if (v?.err) {
          await db.from('ledger_entries').update({ status: 'failed' }).eq('id', row.id)
          summary.failed++
          continue
        }
        if (v?.confirmationStatus === 'confirmed' || v?.confirmationStatus === 'finalized') {
          await db.from('ledger_entries').update({ status: 'confirmed' }).eq('id', row.id)
          summary.confirmed++
          continue
        }

        // Status unknown → double-check the full ledger before any reversal.
        const tx = await connection.getTransaction(row.tx_signature, { maxSupportedTransactionVersion: 0 })
        if (tx) {
          const failed = !!tx.meta?.err
          await db.from('ledger_entries').update({ status: failed ? 'failed' : 'confirmed' }).eq('id', row.id)
          if (failed) summary.failed++; else summary.confirmed++
          continue
        }

        // Not found anywhere. Only reverse once enough time has passed that the tx
        // can no longer land; otherwise leave it pending and retry.
        if (ageMs(row.created_at) > DROP_GRACE_MS) {
          await db.from('ledger_entries').update({ status: 'failed' }).eq('id', row.id)
          summary.failed++
        } else {
          summary.left_pending++
        }
      } catch (e) {
        console.warn('[withdraw-reconcile] row failed', row.id, e?.message)
        summary.left_pending++
      }
    }

    return NextResponse.json({ ok: true, ...summary, finished_at: new Date().toISOString() })
  } catch (err) {
    console.error('[withdraw-reconcile]', err)
    return NextResponse.json({ error: err?.message || 'failed' }, { status: 500 })
  }
}
export const POST = GET
