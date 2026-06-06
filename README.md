# Cupdiction — Transparency Repo

This repository contains the money-critical code behind [Cupdiction](https://cupdiction.com),
published so you can verify it yourself instead of taking our word for it.

Cupdiction is a prediction-market app for Solana memecoins (Up/Down rounds and
token-vs-token Battles), settled in real USDC. It is custodial today — your
deposits sit in an escrow wallet we control — so the fair question is: *can you
trust how the money is handled?*

We don't think you should have to. So here is the actual code that:

- decides who wins a market,
- splits the pool and pays out,
- calculates fees,
- proves our reserves cover what we owe,
- and processes withdrawals.

If there were a hidden house edge or rug logic, it would be in these files. There
isn't. Read them.

> Don't trust. Verify.

---

## What's in here

These are read-only copies of the exact functions running in production. They are
organized by what they do, not by where they live in the app.

> Note: these files are here to be **read and verified, not run**. They reference
> internal modules (the auth layer, database client, and RPC helpers) that aren't
> included — only the money-critical logic is. So the imports won't resolve, and
> that's expected. Every secret (keys, endpoints) is read from environment
> variables and is never in this code.

### `/settlement` — how pools are split and paid
- `settle-market.sql` — the settlement function. Computes the winning side, the
  payout rate, and credits winners. This is the core "who gets paid what" logic.
- `execute-order.sql` — how a bet is placed: share pricing, the fee, and the debit.
- `execute-sell.sql` — selling a position back before settlement.
- `void-market.sql` — voids + full refunds when a market has no fair outcome.
- `ledger.sql` — the double-entry ledger model that tracks every balance.

### `/resolution` — how outcomes are decided (the oracle)
- `updown-resolve.route.js` — Up/Down: reads the end price from public DexScreener
  data; higher than the start → UP wins, lower → DOWN wins, flat/missing → void +
  refund. No subjective calls.
- `pumpfun-resolve.route.js` — Battles: sums each token's DexScreener volume over
  the window, with guards (paired data only, coverage + decisiveness checks) that
  send any unclear result to manual review instead of a coin-flip.

### `/reserves` — proof we're solvent
- `reserves.js` — computes Reserves (on-chain escrow balance) vs Liabilities (sum
  of all user balances), and the backing %.
- `proof-of-reserves.route.js` — the public endpoint behind
  [cupdiction.com/proof-of-reserves](https://cupdiction.com/proof-of-reserves).

### `/withdrawals` — getting your money out
- `withdraw.route.js` — the self-serve withdrawal flow, signed server-side.
- `execute-withdrawal.sql` — the matching ledger movement.

### `/burn-bounties` — the weekly burn mechanic
- `burn.js` — how each token's weekly Burn Bounty pool accrues from fees.
- `burn-execute.js` — picks the weekly winner and buys + burns it on-chain, with
  liquidity / spend / slippage guardrails. Funded by platform fees, never by user
  deposits.

---

## How to verify

1. Reserves — open the [Proof of Reserves page](https://cupdiction.com/proof-of-reserves).
   The escrow wallet address is public; count its USDC on Solscan yourself, and
   compare to what `reserves.js` reports.
2. Settlement & fees — read `settlement/settle-market.sql` and
   `settlement/execute-order.sql`. The payout math and the fee are right there.
3. Outcomes — read `resolution/`. Outcomes come from public DexScreener data, not
   from us.
4. Withdrawals — read `withdrawals/withdraw.route.js`. Funds go to your wallet;
   there is no approval gate.

Every secret (keys, RPC endpoints) is read from environment variables — none are
in this code.

---

## What's NOT here, and why

This is not the whole application. The UI, growth features, analytics, and
business logic are not included — they don't touch how your money is settled or
custodied, and open-sourcing them would just hand competitors the product.

What is here is everything that decides where the money goes. That's the part you
deserve to audit.

---

## Honest status

Cupdiction is custodial today. Proof of Reserves shows we hold enough to cover
everyone, and withdrawals are instant and self-serve — but custodial still means
we hold the keys. We're moving the escrow under a multisig + timelock so no single
party (us included) can drain it, and the long-term goal is a fully non-custodial,
audited escrow.

The full direction is in the [official announcement / litepaper](https://cupdiction.com).

This repo mirrors production. If you spot something that looks wrong or unfair,
open an issue — that's exactly what it's here for.
