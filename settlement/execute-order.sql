-- Atomic LMSR order execution.
-- Requires: markets, market_prices, ledger_entries, orders, positions.

create unique index if not exists positions_wallet_market_side_key
on public.positions (wallet, market_id, side);

create or replace function public.lmsr_logsumexp(a numeric, b numeric)
returns numeric
language sql
immutable
as $$
  select greatest(a, b) + ln(exp(a - greatest(a, b)) + exp(b - greatest(a, b)));
$$;

create or replace function public.lmsr_cost(
  p_q_yes numeric,
  p_q_no numeric,
  p_liquidity_b numeric,
  p_side text,
  p_shares numeric
)
returns numeric
language sql
immutable
as $$
  select p_liquidity_b * (
    public.lmsr_logsumexp(
      case when p_side = 'YES' then (p_q_yes + p_shares) / p_liquidity_b else p_q_yes / p_liquidity_b end,
      case when p_side = 'NO' then (p_q_no + p_shares) / p_liquidity_b else p_q_no / p_liquidity_b end
    )
    -
    public.lmsr_logsumexp(p_q_yes / p_liquidity_b, p_q_no / p_liquidity_b)
  );
$$;

create or replace function public.lmsr_yes_price_cents(
  p_q_yes numeric,
  p_q_no numeric,
  p_liquidity_b numeric
)
returns numeric
language plpgsql
immutable
set search_path = public
as $$
declare
  v_x numeric;
  v_yes numeric;
begin
  v_x := (p_q_yes - p_q_no) / p_liquidity_b;

  if v_x >= 0 then
    v_yes := 1 / (1 + exp(-v_x));
  else
    v_yes := exp(v_x) / (1 + exp(v_x));
  end if;

  return greatest(0.0001, least(99.9999, v_yes * 100));
end;
$$;

create or replace function public.execute_order(
  p_auth_user_id text,
  p_wallet text,
  p_market_id text,
  p_side text,
  p_amount numeric,
  p_currency text,
  p_max_slippage_bps integer default 500
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market record;
  v_price record;
  v_available numeric;
  v_start_yes numeric;
  v_start_price numeric;
  v_fee_rate numeric;
  v_fee numeric;
  v_total_debit numeric;
  v_low numeric := 0;
  v_high numeric;
  v_mid numeric;
  v_cost numeric;
  v_shares numeric;
  v_new_q_yes numeric;
  v_new_q_no numeric;
  v_new_yes numeric;
  v_new_no numeric;
  v_avg_price numeric;
  v_slippage_bps numeric;
  v_order_id uuid;
  v_existing record;
  v_new_shares numeric;
  v_new_avg numeric;
begin
  if p_side not in ('YES', 'NO') then
    raise exception 'invalid side';
  end if;
  if p_currency not in ('USDC', 'USDT', 'SOL') then
    raise exception 'invalid currency';
  end if;
  if p_amount <= 0 or p_amount > 10000 then
    raise exception 'invalid amount';
  end if;
  if p_max_slippage_bps < 0 or p_max_slippage_bps > 5000 then
    raise exception 'invalid slippage';
  end if;

  select id, status, closes_at
  into v_market
  from public.markets
  where id = p_market_id;

  if not found then
    raise exception 'market not found';
  end if;
  if v_market.status = 'resolved' then
    raise exception 'market already resolved';
  end if;
  if v_market.closes_at is not null and v_market.closes_at <= now() then
    raise exception 'market closed';
  end if;

  select *
  into v_price
  from public.market_prices
  where market_id = p_market_id
  for update;

  if not found then
    raise exception 'market price state not seeded';
  end if;

  v_start_yes := public.lmsr_yes_price_cents(v_price.q_yes, v_price.q_no, v_price.liquidity_b);
  v_start_price := case when p_side = 'YES' then v_start_yes else 100 - v_start_yes end;

  -- Free entry: no fee to place a bet. The Burn Bounty is funded by a 1% rake on
  -- the prize pool at settlement instead (see settle_market), so betting is
  -- frictionless and the platform still never pays out more than it collected.
  v_fee_rate := 0;
  v_fee := 0;
  v_total_debit := p_amount;

  -- Serialise concurrent orders from the same user.
  -- market_prices FOR UPDATE above only serialises per-market; without this
  -- a user could place two simultaneous orders on different markets, both pass
  -- the balance check against the same pre-debit balance, and overdraft.
  -- Advisory lock is released automatically when the transaction ends.
  perform pg_advisory_xact_lock(hashtext(p_auth_user_id));

  -- Available = confirmed available entries, MINUS any in-flight (pending)
  -- withdrawals. A pending withdrawal has already committed those funds to an
  -- on-chain transfer; counting it here prevents an order from spending balance
  -- that is simultaneously being withdrawn (the withdrawal entry is negative,
  -- so summing it in reduces available).
  select coalesce(sum(amount), 0)
  into v_available
  from public.ledger_entries
  where auth_user_id = p_auth_user_id
    and asset = p_currency
    and balance_type = 'available'
    and (
      status = 'confirmed'
      or (status = 'pending' and entry_type = 'withdrawal')
    );

  if v_available < v_total_debit then
    raise exception 'insufficient available balance';
  end if;

  v_high := greatest(1, p_amount * 2);
  while public.lmsr_cost(v_price.q_yes, v_price.q_no, v_price.liquidity_b, p_side, v_high) < p_amount loop
    v_high := v_high * 2;
    if v_high > 1000000000 then
      raise exception 'order amount too large';
    end if;
  end loop;

  for i in 1..64 loop
    v_mid := (v_low + v_high) / 2;
    v_cost := public.lmsr_cost(v_price.q_yes, v_price.q_no, v_price.liquidity_b, p_side, v_mid);
    if v_cost > p_amount then
      v_high := v_mid;
    else
      v_low := v_mid;
    end if;
  end loop;

  v_shares := v_low;
  if v_shares <= 0 then
    raise exception 'order too small';
  end if;

  v_avg_price := (p_amount / v_shares) * 100;
  v_slippage_bps := greatest(0, ((v_avg_price - v_start_price) / v_start_price) * 10000);
  if v_slippage_bps > p_max_slippage_bps then
    raise exception 'slippage exceeded';
  end if;

  v_new_q_yes := v_price.q_yes + case when p_side = 'YES' then v_shares else 0 end;
  v_new_q_no := v_price.q_no + case when p_side = 'NO' then v_shares else 0 end;
  v_new_yes := public.lmsr_yes_price_cents(v_new_q_yes, v_new_q_no, v_price.liquidity_b);
  v_new_no := 100 - v_new_yes;

  insert into public.orders (wallet, market_id, side, amount, currency, price_cents, shares, fee, status)
  values (p_wallet, p_market_id, p_side, p_amount, p_currency, v_avg_price, v_shares, v_fee, 'filled')
  returning id into v_order_id;

  insert into public.ledger_entries (
    auth_user_id, wallet, asset, amount, balance_type, entry_type, status, reference_type, reference_id, metadata
  )
  values
    (
      p_auth_user_id, p_wallet, p_currency, -v_total_debit, 'available', 'order_debit', 'confirmed',
      'order', v_order_id::text,
      jsonb_build_object('market_id', p_market_id, 'side', p_side, 'trade_amount', p_amount, 'fee', v_fee)
    ),
    (
      p_auth_user_id, p_wallet, p_currency, p_amount, 'locked', 'order_credit', 'confirmed',
      'order', v_order_id::text,
      jsonb_build_object('market_id', p_market_id, 'side', p_side, 'shares', v_shares)
    );

  select shares, avg_entry_price
  into v_existing
  from public.positions
  where wallet = p_wallet and market_id = p_market_id and side = p_side
  for update;

  if found then
    v_new_shares := v_existing.shares + v_shares;
    v_new_avg := (v_existing.avg_entry_price * v_existing.shares + v_avg_price * v_shares) / v_new_shares;
  else
    v_new_shares := v_shares;
    v_new_avg := v_avg_price;
  end if;

  insert into public.positions (wallet, market_id, side, shares, avg_entry_price, currency, updated_at)
  values (p_wallet, p_market_id, p_side, v_new_shares, v_new_avg, p_currency, now())
  on conflict (wallet, market_id, side) do update set
    shares = excluded.shares,
    avg_entry_price = excluded.avg_entry_price,
    currency = excluded.currency,
    updated_at = excluded.updated_at;

  update public.market_prices
  set
    q_yes = v_new_q_yes,
    q_no = v_new_q_no,
    last_yes_price = v_new_yes,
    last_no_price = v_new_no,
    volume_traded = volume_traded + p_amount,
    updated_at = now()
  where market_id = p_market_id;

  perform public.record_market_price_history(
    p_market_id,
    v_new_yes,
    v_new_no,
    p_amount,
    1
  );

  update public.markets
  set
    yes = round(v_new_yes),
    no = round(v_new_no)
  where id = p_market_id;

  return json_build_object(
    'order_id', v_order_id,
    'shares', v_shares,
    'fee', v_fee,
    'fee_rate', v_fee_rate,
    'avg_price_cents', v_avg_price,
    'start_price_cents', v_start_price,
    'new_yes_price_cents', v_new_yes,
    'new_no_price_cents', v_new_no,
    'slippage_bps', v_slippage_bps
  );
end;
$$;

grant execute on function public.execute_order(text, text, text, text, numeric, text, integer) to service_role;
