import { NextResponse } from 'next/server'
import { getProofOfReserves } from '../../../../lib/reserves'
import { sendAdminAlert } from '../../../../lib/alert'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// Solvency alarm. Every run, compare on-chain reserves vs total user liabilities
// (same computation as Proof of Reserves) and ALERT the operator the moment
// backing dips toward/under 100% — so insolvency is caught automatically, not
// whenever someone happens to open the admin panel.
// ─────────────────────────────────────────────────────────────────────────────

const CRON_SECRET = process.env.CRON_SECRET
// Alert when an asset's backing falls below this %. 100 = reserves < liabilities.
// Set a small buffer (e.g. 102) to get an early warning before going underwater.
const MIN_BACKING_PCT = Number(process.env.SOLVENCY_MIN_BACKING_PCT || 100)

function isAuthorized(request) {
  if (!CRON_SECRET) return false
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') === CRON_SECRET
}

export async function GET(request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const por = await getProofOfReserves()

    // Only assets with real activity (reserves or liabilities present).
    const active = (por.assets || []).filter((a) => a.reserves > 0 || a.liabilities > 0)
    const breached = active.filter((a) => a.liabilities > 0 && a.ratioPct < MIN_BACKING_PCT)

    if (breached.length > 0) {
      const insolvent = breached.some((a) => !a.solvent)
      await sendAdminAlert({
        title: insolvent ? '🚨 INSOLVENT — reserves below liabilities' : '⚠ Solvency warning — backing low',
        body: `Backing dipped below ${MIN_BACKING_PCT}% on: ${breached.map((a) => `${a.asset} ${a.ratioPct}%`).join(', ')}. Escrow ${por.escrowWallet}.`,
        severity: insolvent ? 'error' : 'warn',
        fields: breached.map((a) => ({
          name: a.asset,
          value: `reserves ${a.reserves} · owed ${a.liabilities} · surplus ${a.surplus} · ${a.ratioPct}%`,
        })),
      })
      return NextResponse.json({ ok: true, alarm: true, insolvent, breached, checked_at: por.updatedAt })
    }

    return NextResponse.json({ ok: true, alarm: false, solvent: por.solvent, assets: active, checked_at: por.updatedAt })
  } catch (err) {
    console.error('[solvency-check]', err)
    // A failure here means we couldn't verify solvency — surface it.
    try {
      await sendAdminAlert({ title: '⚠ Solvency check failed', body: err?.message || 'unknown error', severity: 'warn' })
    } catch {}
    return NextResponse.json({ error: err?.message || 'failed' }, { status: 500 })
  }
}
export const POST = GET
