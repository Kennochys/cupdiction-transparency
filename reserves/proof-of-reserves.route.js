import { NextResponse } from 'next/server'
import { getProofOfReserves, recordReserveSnapshot, getReservesHistory } from '../../../lib/reserves'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Small in-memory cache so a busy public page doesn't hammer the Solana RPC.
// 60s is fresh enough for a solvency display and keeps us well under rate limits.
const TTL_MS = 60 * 1000
let cache = null // { at: number, data: object }

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < TTL_MS) {
      return NextResponse.json({ ok: true, cached: true, ...cache.data })
    }
    const por = await getProofOfReserves()
    // Seed the current hour's snapshot from real traffic (deduped), then read
    // back the history so the chart has data even before the cron first fires.
    await recordReserveSnapshot(por, 'web')
    const history = await getReservesHistory(30)
    const data = { ...por, history }
    cache = { at: Date.now(), data }
    return NextResponse.json({ ok: true, cached: false, ...data })
  } catch (err) {
    console.error('[proof-of-reserves]', err)
    // Serve stale data on transient RPC failure rather than a hard error.
    if (cache) return NextResponse.json({ ok: true, cached: true, stale: true, ...cache.data })
    return NextResponse.json({ ok: false, error: err?.message || 'Failed' }, { status: 500 })
  }
}
