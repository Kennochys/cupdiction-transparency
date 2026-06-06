-- Market resolution and settlement.
-- Requires: markets, positions, ledger_entries, execute-order.sql.
--
-- Payout model: hybrid LMSR / parimutuel
--   Normal (balanced market): winner gets shares × $1.00 (LMSR guarantee)
--   One-sided market: winner gets proportional share of total collected pot
--   → platform never pays out more than it collected. Zero platform loss.
--
-- Flow:
--   1. FOR UPDATE lock on market row prevents concurrent double-settlement
--   2. Compute total collected + total winner shares → payout rate
--   3. Mark market resolved FIRST (retryable on crash)
--   4. For each open position: clear locked balance + credit payout to winners
--   5. Entire function is one transaction — atomic, all-or-nothing

create or replace function public.settle_market(
  p_market_id text,
  p_result    text   -- 'YES' or 'NO'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market              record;
  v_pos                 record;
  v_auth_user_id        text;
  v_locked_amt          numeric;
  v_winner_count        int     := 0;
  v_loser_count         int     := 0;
  v_total_payout        numeric := 0;
  v_total_collected     numeric := 0;
  v_total_winner_shares numeric := 0;
  v_payout_rate         numeric := 1.0;
  v_winner_payout       numeric;
begin
  if p_result not in ('YES', 'NO') then
    raise exception 'invalid result: must be YES or NO';
  end if;

  -- Lock market row to prevent concurrent settlement
  select id, status
  into v_market
  from public.markets
  where id = p_market_id
  for update;

  if not found then
    raise exception 'market not found';
  end if;
  if v_market.status = 'resolved' then
    raise exception 'market already resolved';
  end if;

  -- Total USDC collected across all sides (locked order_credit entries)
  select coalesce(sum(amount), 0)
  into   v_total_collected
  from   public.ledger_entries
  where  balance_type = 'locked'
    and  entry_type   = 'order_credit'
    and  status       = 'confirmed'
    and  metadata->>'market_id' = p_market_id;

  -- Total shares on the winning side
  select coalesce(sum(shares), 0)
  into   v_total_winner_shares
  from   public.positions
  where  market_id = p_market_id
    and  side      = p_result
    and  shares    > 0;

  -- Payout rate: $1/share when balanced, prorated when one-sided
  -- LEAST(1.0, ...) ensures platform never pays more than collected
  if v_total_winner_shares > 0 then
    v_payout_rate := least(1.0, v_total_collected / v_total_winner_shares);
  end if;

  -- Mark resolved FIRST so crash+rollback = retryable
  update public.markets
  set status = 'resolved',
      res    = p_result
  where id = p_market_id;

  -- Settle every open position for this market
  for v_pos in
    select wallet, side, shares, currency
    from public.positions
    where market_id = p_market_id
      and shares    > 0
  loop
    select auth_user_id
    into   v_auth_user_id
    from   public.ledger_entries
    where  wallet     = v_pos.wallet
      and  entry_type = 'order_credit'
      and  status     = 'confirmed'
      and  metadata->>'market_id' = p_market_id
    limit 1;

    if v_auth_user_id is null then
      continue;
    end if;

    -- Sum locked balance for this wallet + market + side
    select coalesce(sum(amount), 0)
    into   v_locked_amt
    from   public.ledger_entries
    where  wallet       = v_pos.wallet
      and  balance_type = 'locked'
      and  entry_type   = 'order_credit'
      and  status       = 'confirmed'
      and  metadata->>'market_id' = p_market_id
      and  metadata->>'side'      = v_pos.side;

    -- Debit locked balance (clear regardless of outcome)
    if v_locked_amt > 0 then
      insert into public.ledger_entries (
        auth_user_id, wallet, asset, amount,
        balance_type, entry_type, status,
        reference_type, reference_id, metadata
      ) values (
        v_auth_user_id,
        v_pos.wallet,
        v_pos.currency,
        -v_locked_amt,
        'locked', 'settlement', 'confirmed',
        'market', p_market_id,
        jsonb_build_object(
          'market_id', p_market_id,
          'result',    p_result,
          'side',      v_pos.side,
          'type',      'unlock'
        )
      );
    end if;

    if v_pos.side = p_result then
      v_winner_payout := round(v_pos.shares * v_payout_rate, 6);
      insert into public.ledger_entries (
        auth_user_id, wallet, asset, amount,
        balance_type, entry_type, status,
        reference_type, reference_id, metadata
      ) values (
        v_auth_user_id,
        v_pos.wallet,
        v_pos.currency,
        v_winner_payout,
        'available', 'settlement', 'confirmed',
        'market', p_market_id,
        jsonb_build_object(
          'market_id',    p_market_id,
          'result',       p_result,
          'side',         v_pos.side,
          'shares',       v_pos.shares,
          'payout_rate',  v_payout_rate,
          'type',         'payout'
        )
      );
      v_winner_count := v_winner_count + 1;
      v_total_payout := v_total_payout + v_winner_payout;
    else
      v_loser_count := v_loser_count + 1;
    end if;
  end loop;

  return json_build_object(
    'market_id',         p_market_id,
    'result',            p_result,
    'winners',           v_winner_count,
    'losers',            v_loser_count,
    'total_collected',   v_total_collected,
    'total_winner_shares', v_total_winner_shares,
    'payout_rate',       v_payout_rate,
    'total_payout',      v_total_payout
  );
end;
$$;

grant execute on function public.settle_market(text, text) to service_role;
