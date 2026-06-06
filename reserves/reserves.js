import { supabaseAdmin } from './supabase'
import { getWalletBalances } from './solana-rpc'

// Proof-of-Reserves: public, verifiable solvency snapshot.
//
//   Assets      = live on-chain balance of the escrow wallet (USDC + USDT).
//   Liabilities = sum of every user's ledger balance (available + locked).
//   Solvent     = Assets >= Liabilities for each asset.
//
// This mirrors the proven logic in app/api/admin/solvency, but returns only
// aggregate, public-safe numbers (no per-user data, no fee/revenue figures).
// Anyone can independently verify the Assets side via the Solscan link, since
// the escrow wallet address is public.

const ASSETS = ['USDC', 'USDT']

export async function getProofOfReserves() {
  const escrowWallet = process.env.ESCROW_WALLET_ADDRESS || process.env.NEXT_PUBLIC_ESCROW_WALLET_ADDRESS
  if (!escrowWallet) throw new Error('ESCROW_WALLET_ADDRESS not set')

  const db = supabaseAdmin()

  // Assets — read live from chain.
  const onChain = await getWalletBalances(escrowWallet)
  const assetByAsset = {}
  for (const asset of ASSETS) {
    assetByAsset[asset] = Number(onChain.find((b) => b.symbol === asset)?.amount || 0)
  }

  // Liabilities — what we owe users, straight from the ledger.
  const { data: ledgerRows, error: ledgerErr } = await db
    .from('ledger_entries')
    .select('asset, amount, balance_type')
    .eq('status', 'confirmed')
    .in('balance_type', ['available', 'locked'])
  if (ledgerErr) throw ledgerErr

  const liabilityByAsset = {}
  for (const asset of ASSETS) liabilityByAsset[asset] = 0
  for (const row of ledgerRows || []) {
    if (liabilityByAsset[row.asset] === undefined) continue
    liabilityByAsset[row.asset] += Number(row.amount)
  }

  const assetsList = ASSETS.map((asset) => {
    const onChainAmount = +assetByAsset[asset].toFixed(6)
    const liabilities = +liabilityByAsset[asset].toFixed(6)
    const surplus = +(onChainAmount - liabilities).toFixed(6)
    // Backing ratio: how much we hold per unit owed. 100%+ = fully backed.
    // If nothing is owed yet, treat as fully backed (1) to avoid div-by-zero.
    const ratio = liabilities > 0 ? onChainAmount / liabilities : 1
    return {
      asset,
      reserves: onChainAmount,
      liabilities,
      surplus,
      ratioPct: +(ratio * 100).toFixed(2),
      solvent: surplus >= 0,
    }
  })

  const solvent = assetsList.every((a) => a.solvent)

  return {
    solvent,
    escrowWallet,
    assets: assetsList,
    updatedAt: new Date().toISOString(),
  }
}

// Persist one hourly platform-wide snapshot. Best-effort: deduped to one row
// per UTC hour by a unique index, so concurrent cron + web hits don't conflict.
// Pass the result of getProofOfReserves().
export async function recordReserveSnapshot(por, source = 'web') {
  try {
    const db = supabaseAdmin()
    const byAsset = Object.fromEntries((por?.assets || []).map((a) => [a.asset, a]))
    const { error } = await db.from('por_snapshots').insert({
      reserves_usdc: byAsset.USDC?.reserves || 0,
      reserves_usdt: byAsset.USDT?.reserves || 0,
      liabilities_usdc: byAsset.USDC?.liabilities || 0,
      liabilities_usdt: byAsset.USDT?.liabilities || 0,
      solvent: !!por?.solvent,
      source,
    })
    // 23505 = unique violation (this hour already recorded) — expected, ignore.
    if (error && error.code !== '23505') throw error
    return { recorded: !error }
  } catch (err) {
    console.warn('[reserves] snapshot insert failed:', err?.message)
    return { recorded: false }
  }
}

// Combined backing-% history (stablecoins summed in USD ≈ 1:1) over the last
// `days`, oldest → newest. Returns [{ t, pct, solvent }] for the chart.
export async function getReservesHistory(days = 30) {
  try {
    const db = supabaseAdmin()
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await db
      .from('por_snapshots')
      .select('captured_at, reserves_usdc, reserves_usdt, liabilities_usdc, liabilities_usdt, solvent')
      .gte('captured_at', since)
      .order('captured_at', { ascending: true })
      .limit(1000)
    if (error) throw error
    return (data || []).map((r) => {
      const reserves = Number(r.reserves_usdc) + Number(r.reserves_usdt)
      const liabilities = Number(r.liabilities_usdc) + Number(r.liabilities_usdt)
      const pct = liabilities > 0 ? +((reserves / liabilities) * 100).toFixed(2) : 100
      return { t: r.captured_at, pct, solvent: !!r.solvent }
    })
  } catch (err) {
    console.warn('[reserves] history read failed:', err?.message)
    return []
  }
}
