import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { createBurnCheckedInstruction, getAssociatedTokenAddress, getAccount, getMint } from '@solana/spl-token'
import { supabaseAdmin } from './supabase'
import { SOLANA_RPC_URL, SPL_TOKEN_MINTS } from './solana-rpc'
import { fetchDexScreenerTokenMetrics } from './bags-api'
import { getBountyLeaderboard, weekStart } from './burn'

// ── Burn Bounty executor ─────────────────────────────────────────────────────
// Picks the week's #1 eligible token, buys it with the accrued pool (Jupiter),
// then permanently burns what it bought (SPL burnChecked). Funds come from a
// DEDICATED burn wallet (BURN_WALLET / BURN_PRIVATE_KEY) — never the user-funds
// escrow, so Proof of Reserves stays clean. Designed for "one-click": the weekly
// cron only alerts; this runs when an admin clicks (or later, full-auto).
//
// Every guardrail is env-tunable so it can go live conservatively:
const MIN_POOL_USDC       = Number(process.env.BURN_MIN_POOL_USDC || 25)        // don't burn dust
const MIN_LIQUIDITY_USDC  = Number(process.env.BURN_MIN_LIQUIDITY_USDC || 10000) // token must be liquid
const MAX_LIQ_FRACTION    = Number(process.env.BURN_MAX_LIQ_FRACTION || 0.02)    // spend ≤2% of liquidity
const SLIPPAGE_BPS        = Number(process.env.BURN_SLIPPAGE_BPS || 300)         // 3%
const JUP_BASE            = process.env.JUPITER_API_BASE || 'https://quote-api.jup.ag/v6'

const USDC_MINT     = SPL_TOKEN_MINTS.USDC.mint
const USDC_DECIMALS = SPL_TOKEN_MINTS.USDC.decimals

// Last completed week (Monday) — what the cron/burn settles.
export function lastWeekStart() {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 7)
  return weekStart(d)
}

function getBurnKeypair() {
  const raw = (process.env.BURN_PRIVATE_KEY || '').trim()
  if (!raw) return null
  try {
    if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
    return Keypair.fromSecretKey(Buffer.from(raw, 'base64')) // base64-encoded 64-byte secret
  } catch (e) {
    console.error('[burn-execute] bad BURN_PRIVATE_KEY:', e?.message)
    return null
  }
}

// Pick the #1 token that clears the liquidity floor. Returns { winner, metrics, spendUsdc, reason }.
export async function pickBurnTarget(week = lastWeekStart()) {
  const board = await getBountyLeaderboard(week)
  if (!board.length) return { reason: 'no_contenders', week }

  for (const t of board) {
    if (t.pool_usdc < MIN_POOL_USDC) {
      // Top pool is below the floor → nothing this week is worth burning.
      return { reason: 'below_min_pool', week, top: t, minPool: MIN_POOL_USDC }
    }
    const m = await fetchDexScreenerTokenMetrics(t.token_mint)
    const liq = Number(m?.liquidityUsd || 0)
    if (liq < MIN_LIQUIDITY_USDC) continue // skip illiquid → next eligible
    // Cap spend so we don't self-slip / look like manipulation.
    const spendUsdc = Math.min(t.pool_usdc, liq * MAX_LIQ_FRACTION)
    return { winner: t, metrics: m, spendUsdc: +spendUsdc.toFixed(6), liquidityUsd: liq, week }
  }
  return { reason: 'no_eligible_token', week }
}

async function jupiterSwap(connection, keypair, outputMint, amountInBaseUnits) {
  const quoteUrl = `${JUP_BASE}/quote?inputMint=${USDC_MINT}&outputMint=${outputMint}`
    + `&amount=${amountInBaseUnits}&slippageBps=${SLIPPAGE_BPS}&swapMode=ExactIn`
  const quote = await (await fetch(quoteUrl, { cache: 'no-store' })).json()
  if (!quote || quote.error || !quote.outAmount) throw new Error(`Jupiter quote failed: ${quote?.error || 'no route'}`)

  const swapRes = await fetch(`${JUP_BASE}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  })
  const swapData = await swapRes.json()
  if (!swapData?.swapTransaction) throw new Error(`Jupiter swap build failed: ${swapData?.error || 'unknown'}`)

  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'))
  tx.sign([keypair])
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  await connection.confirmTransaction(sig, 'confirmed')
  return { sig, outAmount: quote.outAmount }
}

async function burnAll(connection, keypair, mint) {
  const mintPk = new PublicKey(mint)
  const ata = await getAssociatedTokenAddress(mintPk, keypair.publicKey)
  const acct = await getAccount(connection, ata)
  const amount = acct.amount // bigint, raw base units
  if (amount <= 0n) throw new Error('No tokens to burn after swap')
  const mintInfo = await getMint(connection, mintPk)
  const ix = createBurnCheckedInstruction(ata, mintPk, keypair.publicKey, amount, mintInfo.decimals)
  const tx = new Transaction().add(ix)
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = keypair.publicKey
  tx.sign(keypair)
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  await connection.confirmTransaction(sig, 'confirmed')
  return { sig, burned: Number(amount) / 10 ** mintInfo.decimals }
}

// Execute the weekly Burn Bounty. dryRun=true returns the plan without moving funds.
export async function executeBurnBounty({ week = lastWeekStart(), dryRun = false } = {}) {
  const db = supabaseAdmin()
  const target = await pickBurnTarget(week)
  if (!target.winner) {
    return { ok: false, skipped: true, ...target }
  }

  const plan = {
    week,
    token_mint: target.winner.token_mint,
    token_symbol: target.metrics?.symbol || target.winner.token_symbol,
    pool_usdc: target.winner.pool_usdc,
    spend_usdc: target.spendUsdc,
    liquidity_usd: target.liquidityUsd,
  }
  if (dryRun) return { ok: true, dryRun: true, plan }

  const keypair = getBurnKeypair()
  if (!keypair) return { ok: false, error: 'BURN_PRIVATE_KEY not set', plan }

  // Idempotency: don't burn the same week twice.
  const { data: existing } = await db.from('burn_events')
    .select('id').eq('week_start', week).eq('status', 'burned').limit(1)
  if (existing?.length) return { ok: false, error: 'already_burned', plan }

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed')
  const amountIn = Math.round(target.spendUsdc * 10 ** USDC_DECIMALS)

  // Record intent first so a mid-flight failure is visible for reconciliation.
  const { data: evRows } = await db.from('burn_events').insert({
    week_start: week, token_mint: plan.token_mint, token_symbol: plan.token_symbol,
    usdc_spent: target.spendUsdc, status: 'pending',
  }).select('id')
  const eventId = evRows?.[0]?.id

  try {
    const swap = await jupiterSwap(connection, keypair, plan.token_mint, amountIn)
    if (eventId) await db.from('burn_events').update({ status: 'bought', swap_tx: swap.sig, token_bought: Number(swap.outAmount) }).eq('id', eventId)

    const burn = await burnAll(connection, keypair, plan.token_mint)
    if (eventId) await db.from('burn_events').update({ status: 'burned', burn_tx: burn.sig, token_burned: burn.burned, executed_at: new Date().toISOString() }).eq('id', eventId)

    return { ok: true, plan, swap_tx: swap.sig, burn_tx: burn.sig, token_burned: burn.burned }
  } catch (e) {
    if (eventId) await db.from('burn_events').update({ status: 'pending', announced: false }).eq('id', eventId)
    console.error('[burn-execute] failed:', e?.message)
    return { ok: false, error: e?.message || 'burn failed', plan, eventId }
  }
}
