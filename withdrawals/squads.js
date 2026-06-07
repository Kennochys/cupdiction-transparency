import * as multisig from '@sqds/multisig'
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'

// Squads multisig integration for withdrawals.
//
// Funds live in the Squads VAULT (2-of-2 + timelock). Routine withdrawals are
// paid out via a per-day Spending Limit that the escrow key (a multisig member)
// can use WITHOUT other members' approval — so withdrawals stay instant, but the
// key can only ever release up to the daily cap, and it cannot move the bulk
// (that needs 2-of-2 + timelock). See SQUADS-SETUP.md.
//
// Returns null unless fully configured, so the withdraw route falls back to the
// legacy direct-escrow path until you flip this on.
export function getSquadsConfig() {
  const multisigPda = process.env.SQUADS_MULTISIG_PDA
  const spendingLimit = process.env.SQUADS_SPENDING_LIMIT_PDA
  if (!multisigPda || !spendingLimit) return null
  try {
    return {
      multisigPda: new PublicKey(multisigPda),
      spendingLimit: new PublicKey(spendingLimit),
      vaultIndex: Number(process.env.SQUADS_VAULT_INDEX || 0),
    }
  } catch {
    return null
  }
}

// Instructions to pay an SPL withdrawal from the vault via the spending limit.
//   member          = the spending-limit member (the escrow keypair's pubkey)
//   ownerDestination = the user's wallet (the SDK derives their ATA from this)
//   amountBaseUnits  = raw token units (NOT UI amount) — confirmed by the v4 SDK
// We pre-create the recipient ATA idempotently (payer = member) so the transfer
// never fails on a missing token account.
export async function buildSquadsSplWithdrawal({ cfg, member, mint, decimals, amountBaseUnits, ownerDestination }) {
  const userAta = await getAssociatedTokenAddress(mint, ownerDestination)
  return [
    createAssociatedTokenAccountIdempotentInstruction(member, userAta, ownerDestination, mint),
    multisig.instructions.spendingLimitUse({
      multisigPda: cfg.multisigPda,
      member,
      spendingLimit: cfg.spendingLimit,
      vaultIndex: cfg.vaultIndex,
      mint,
      amount: amountBaseUnits,
      decimals,
      destination: ownerDestination,
      tokenProgram: TOKEN_PROGRAM_ID,
    }),
  ]
}
