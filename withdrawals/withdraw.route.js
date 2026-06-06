import { NextResponse } from 'next/server'
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token'
import { checkRateLimit } from '../../../../lib/rate-limit'
import { supabaseAdmin } from '../../../../lib/supabase'
import { verifyPrivyToken, getPrivyUser } from '../../../../lib/privy-server'
import { getPrivySolanaWallet } from '../../../../lib/privy-identity'
import { SOLANA_RPC_URL, SPL_TOKEN_MINTS } from '../../../../lib/solana-rpc'
import { FEATURES, featureDisabledResponse } from '../../../../lib/feature-flags'

export const dynamic = 'force-dynamic'

const MIN_AMOUNTS = { USDC: 1, USDT: 1, SOL: 0.001 }
const WITHDRAWAL_FEE_RATE = 0.01 // 1%

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function decodeBase58(str) {
  let n = 0n
  for (const c of str) {
    const d = BASE58.indexOf(c)
    if (d < 0) throw new Error('invalid base58')
    n = n * 58n + BigInt(d)
  }
  const bytes = []
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n }
  for (const c of str) { if (c === '1') bytes.unshift(0); else break }
  return Uint8Array.from(bytes)
}

function getEscrowKeypair() {
  const raw = (process.env.ESCROW_PRIVATE_KEY || '').trim()
  if (!raw) return null
  try {
    // JSON array: [1,2,3,...,64]
    if (raw.startsWith('[')) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
    }
    // Base58 (Phantom export): 87-88 chars, all base58 alphabet
    if (/^[1-9A-HJ-NP-Za-km-z]{85,90}$/.test(raw)) {
      return Keypair.fromSecretKey(decodeBase58(raw))
    }
    // Base64 fallback
    return Keypair.fromSecretKey(Buffer.from(raw, 'base64'))
  } catch {
    return null
  }
}

function toUnits(amount, decimals) {
  // Use string arithmetic to avoid float precision errors
  const [whole, frac = ''] = String(amount).split('.')
  const padded = frac.padEnd(decimals, '0').slice(0, decimals)
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(padded || '0')
}

export async function POST(request) {
  if (!FEATURES.wallet) {
    return NextResponse.json(featureDisabledResponse('Wallet'), { status: 403 })
  }

  try {
    const rate = await checkRateLimit(request, 'wallet-withdraw', 3)
    if (!rate.ok) {
      return NextResponse.json(
        { error: 'Too many withdrawal requests. Try again soon.' },
        { status: 429, headers: { 'retry-after': String(rate.retryAfter) } },
      )
    }

    const escrowKeypair = getEscrowKeypair()
    if (!escrowKeypair) {
      return NextResponse.json({ error: 'Withdrawals are not configured.' }, { status: 503 })
    }

    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

    const claims = await verifyPrivyToken(token)
    const privyUser = await getPrivyUser(claims.user_id)
    const wallet = getPrivySolanaWallet(privyUser)
    if (!wallet) {
      return NextResponse.json({ error: 'A linked Solana wallet is required.' }, { status: 400 })
    }

    let body
    try { body = await request.json() } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const asset = String(body.asset || '').trim().toUpperCase()
    const amount = Number(body.amount)

    if (!['USDC', 'USDT', 'SOL'].includes(asset)) {
      return NextResponse.json({ error: 'Unsupported asset.' }, { status: 400 })
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Invalid amount.' }, { status: 400 })
    }
    if (amount < MIN_AMOUNTS[asset]) {
      return NextResponse.json({ error: `Minimum withdrawal is ${MIN_AMOUNTS[asset]} ${asset}.` }, { status: 400 })
    }

    const db = supabaseAdmin()

    // Block concurrent withdrawals for same user+asset — prevent race condition
    const { data: pending } = await db
      .from('ledger_entries')
      .select('id')
      .eq('auth_user_id', claims.user_id)
      .eq('asset', asset)
      .eq('entry_type', 'withdrawal')
      .eq('status', 'pending')
      .limit(1)

    if (pending?.length > 0) {
      return NextResponse.json({ error: 'A withdrawal is already in progress. Please wait.' }, { status: 409 })
    }

    // Atomic balance check + debit via RPC
    const fee = +(amount * WITHDRAWAL_FEE_RATE).toFixed(6)
    const totalDebit = +(amount + fee).toFixed(6)
    const netAmount = amount

    const { data: rpcResult, error: rpcErr } = await db.rpc('execute_withdrawal', {
      p_auth_user_id: claims.user_id,
      p_wallet: wallet,
      p_asset: asset,
      p_amount: totalDebit,
      p_fee: fee,
      p_metadata: { amount, fee, asset, destination: wallet },
    })

    if (rpcErr) {
      const msg = String(rpcErr.message || '')
      const status = msg.includes('insufficient') ? 402 : 500
      if (status !== 402) console.error('execute_withdrawal rpc error', rpcErr)
      return NextResponse.json({
        error: status === 402
          ? `Insufficient balance. Required: ${totalDebit.toFixed(4)} ${asset} (incl. ${fee.toFixed(4)} fee).`
          : 'Failed to create withdrawal record.',
      }, { status })
    }

    const entryId = rpcResult?.entry_id
    if (!entryId) throw new Error('Failed to create withdrawal record.')

    // Build + send on-chain: escrow → the user's own linked wallet.
    // SAFETY RULE: a transaction that has been SUBMITTED (we hold a signature) is NEVER
    // auto-reverted — it may still confirm on-chain, and reverting would let the user keep
    // funds AND get their balance back (double-spend). We only revert when nothing was
    // submitted, or when the network reports a definitive failure (err).
    let signature = null
    try {
      const connection = new Connection(SOLANA_RPC_URL, 'confirmed')
      const userPubkey   = new PublicKey(wallet)
      const escrowPubkey = escrowKeypair.publicKey
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')

      const tx = new Transaction({ feePayer: escrowPubkey, recentBlockhash: blockhash })

      if (asset === 'SOL') {
        tx.add(SystemProgram.transfer({ fromPubkey: escrowPubkey, toPubkey: userPubkey, lamports: toUnits(netAmount, 9) }))
      } else {
        const tokenMeta = SPL_TOKEN_MINTS[asset]
        const mint      = new PublicKey(tokenMeta.mint)
        const units     = toUnits(netAmount, tokenMeta.decimals)
        const escrowAta = await getAssociatedTokenAddress(mint, escrowPubkey)
        const userAta   = await getAssociatedTokenAddress(mint, userPubkey)
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(escrowPubkey, userAta, userPubkey, mint),
          createTransferCheckedInstruction(escrowAta, mint, userAta, escrowPubkey, units, tokenMeta.decimals),
        )
      }

      tx.sign(escrowKeypair)
      // After this line a signature exists → the tx is submitted; never auto-revert.
      signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })

      // 'confirmed' | 'failed' | 'pending' (indeterminate). Default to pending on uncertainty.
      let outcome = 'pending'
      try {
        const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
        outcome = value?.err ? 'failed' : 'confirmed'
      } catch {
        try {
          const st = await connection.getSignatureStatus(signature, { searchTransactionHistory: true })
          if (st?.value?.err) outcome = 'failed'
          else if (st?.value?.confirmationStatus === 'confirmed' || st?.value?.confirmationStatus === 'finalized') outcome = 'confirmed'
          else outcome = 'pending'
        } catch { outcome = 'pending' }
      }

      if (outcome === 'confirmed') {
        await db.from('ledger_entries').update({ status: 'confirmed', tx_signature: signature }).eq('id', entryId)
        return NextResponse.json({ ok: true, signature, amount, fee, totalDebit, asset, entryId })
      }
      if (outcome === 'failed') {
        // Network reported the tx failed → escrow did not pay out → safe to restore balance.
        await db.from('ledger_entries').update({ status: 'failed', tx_signature: signature }).eq('id', entryId)
        return NextResponse.json({ error: 'On-chain transaction failed. Your balance has been restored.' }, { status: 500 })
      }
      // Indeterminate: keep the debit (status stays 'pending') so balance cannot be re-spent.
      // Store the signature for reconciliation; the funds are likely on the way.
      await db.from('ledger_entries').update({ tx_signature: signature }).eq('id', entryId)
      return NextResponse.json({ ok: true, processing: true, signature, amount, fee, asset, entryId,
        message: 'Withdrawal submitted — confirming on-chain.' })
    } catch (txErr) {
      console.error('withdraw on-chain error', txErr)
      if (!signature) {
        // Nothing was submitted → safe to restore balance.
        await db.from('ledger_entries').update({ status: 'failed' }).eq('id', entryId)
        return NextResponse.json({ error: 'Could not submit withdrawal. Your balance has been restored.' }, { status: 500 })
      }
      // A signature exists → tx may land. Hold the debit (pending) for reconciliation; never revert.
      await db.from('ledger_entries').update({ tx_signature: signature }).eq('id', entryId)
      return NextResponse.json({ ok: true, processing: true, signature, amount, fee, asset, entryId,
        message: 'Withdrawal submitted — confirming on-chain.' })
    }
  } catch (error) {
    console.error('withdraw error', error)
    return NextResponse.json({ error: error?.message || 'Withdrawal failed.' }, { status: 500 })
  }
}
