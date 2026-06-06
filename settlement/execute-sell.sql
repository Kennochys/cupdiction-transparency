-- Cash-out: sell shares back to the LMSR market mid-race for the current value.
-- Mirror of execute_order. Refund = current LMSR mark-to-market value of the
-- shares being sold, minus a cash-out fee. Releases the proportional locked
-- stake and credits the net refund to available.
--
-- Risk note: this makes the platform the counterparty for early exits (AMM
-- model). Loss is bounded by the LMSR liquidity parameter b (≈ b·ln2 per market).
-- Requires: market_prices, positions, ledger_entries, lmsr_cost, lmsr_yes_price_cents.

create or replace function public.execute_sell(
  p_auth_user_id text,
  p_wallet       text,
  p_market_id    text,
  p_side         text,
  p_shares       numeric   -- shares to sell (>0). Sell-all when = position shares.
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market    record;
  v_price     record;
  v_pos       record;
  v_refund    numeric;
  v_fee_rate  numeric := 0.015;   -- 1.5% cash-out fee
  v_fee       numeric;
  v_net       numeric;
  v_locked    numeric;
  v_release   numeric;
  v_new_q_yes numeric;
  v_new_q_no  numeric;
  v_new_yes   numeric;
  v_new_no    numeric;
  v_cur_price numeric;
begin
  if p_side not in ('YES', 'NO') then raise exception 'invalid side'; end if;
  if p_shares is null or p_shares <= 0 then raise exception 'invalid shares'; end if;

  select id, status, closes_at into v_market from public.markets where id = p_market_id;
  if not found then raise exception 'market not found'; end if;
  if v_market.status = 'resolved' then raise exception 'market already resolved'; end if;
  if v_market.closes_at is not null and v_market.closes_at <= now() then raise exception 'market closed'; end if;

  select * into v_price from public.market_prices where market_id = p_market_id for update;
  if not found then raise exception 'market price state not seeded'; end if;

  perform pg_advisory_xact_lock(hashtext(p_auth_user_id));

  -- Position must exist and hold enough shares
  select shares into v_pos
  from public.positions
  where wallet = p_wallet and market_id = p_market_id and side = p_side
  for update;
  -- Tolerate rounding: the API sends shares rounded to 4dp which can exceed the
  -- stored value by a hair. Reject only real overdraws; clamp to held shares.
  if not found or p_shares > v_pos.shares + 0.0001 then
    raise exception 'insufficient shares to sell';
  end if;
  if p_shares > v_pos.shares then p_shares := v_pos.shares; end if;

  -- LMSR refund = C(q) - C(q with side reduced by p_shares) = -cost(adding -p_shares)
  v_refund := - public.lmsr_cost(v_price.q_yes, v_price.q_no, v_price.liquidity_b, p_side, -p_shares);
  if v_refund <= 0 then raise exception 'refund too small'; end if;
  v_fee := round(v_refund * v_fee_rate, 6);
  v_net := round(v_refund - v_fee, 6);

  -- New pool state after removing the shares
  v_new_q_yes := v_price.q_yes - case when p_side = 'YES' then p_shares else 0 end;
  v_new_q_no  := v_price.q_no  - case when p_side = 'NO'  then p_shares else 0 end;
  v_new_yes := public.lmsr_yes_price_cents(v_new_q_yes, v_new_q_no, v_price.liquidity_b);
  v_new_no  := 100 - v_new_yes;

  -- Locked stake to release: proportional to the fraction of the position sold
  select coalesce(sum(amount), 0) into v_locked
  from public.ledger_entries
  where wallet = p_wallet and balance_type = 'locked' and entry_type = 'order_credit'
    and status = 'confirmed' and metadata->>'market_id' = p_market_id and metadata->>'side' = p_side;
  v_release := round(v_locked * (p_shares / v_pos.shares), 6);

  -- Ledger: release locked stake + credit net refund to available
  insert into public.ledger_entries (auth_user_id, wallet, asset, amount, balance_type, entry_type, status, reference_type, reference_id, metadata)
  values
    (p_auth_user_id, p_wallet, 'USDC', -v_release, 'locked', 'cashout', 'confirmed', 'market', p_market_id,
     jsonb_build_object('market_id', p_market_id, 'side', p_side, 'shares', p_shares, 'type', 'release')),
    (p_auth_user_id, p_wallet, 'USDC', v_net, 'available', 'cashout', 'confirmed', 'market', p_market_id,
     jsonb_build_object('market_id', p_market_id, 'side', p_side, 'shares', p_shares, 'refund', v_refund, 'fee', v_fee, 'type', 'refund'));

  -- Update / remove position
  if v_pos.shares - p_shares <= 0.000001 then
    delete from public.positions where wallet = p_wallet and market_id = p_market_id and side = p_side;
  else
    update public.positions set shares = shares - p_shares, updated_at = now()
    where wallet = p_wallet and market_id = p_market_id and side = p_side;
  end if;

  -- Update market price state
  update public.market_prices
  set q_yes = v_new_q_yes, q_no = v_new_q_no, last_yes_price = v_new_yes, last_no_price = v_new_no, updated_at = now()
  where market_id = p_market_id;

  perform public.record_market_price_history(p_market_id, v_new_yes, v_new_no, 0, 0);
  update public.markets set yes = round(v_new_yes), no = round(v_new_no) where id = p_market_id;

  v_cur_price := case when p_side = 'YES' then v_new_yes else v_new_no end;
  return json_build_object(
    'shares_sold', p_shares,
    'refund', v_refund,
    'fee', v_fee,
    'net', v_net,
    'released_stake', v_release,
    'new_yes_price_cents', v_new_yes,
    'new_no_price_cents', v_new_no
  );
end;
$$;

grant execute on function public.execute_sell(text, text, text, text, numeric) to service_role;
