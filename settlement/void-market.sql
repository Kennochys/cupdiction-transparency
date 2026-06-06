-- Void a market and refund every stake (no winner). Used when a market can't produce
-- a fair outcome — e.g. price exactly flat (dead/static token) or stuck unresolved.
-- Refund = release each bettor's locked stake back to available. Zero platform impact.
-- Idempotent via the markets.status guard (won't double-refund a resolved market).
-- Run in Supabase SQL editor.

create or replace function public.void_market(p_market_id text)
returns json
language plpgsql
security definer
as $void$
declare
  v_status   text;
  v_row      record;
  v_count    int := 0;
  v_refunded numeric := 0;
begin
  -- Lock the market row and bail if it's already resolved (prevents double refund).
  select status into v_status from public.markets where id = p_market_id for update;
  if v_status is null then raise exception 'market not found'; end if;
  if v_status = 'resolved' then
    return json_build_object('already_resolved', true);
  end if;

  -- One refund per (wallet, asset, side) from the actual locked stakes.
  for v_row in
    select wallet,
           asset,
           metadata->>'side' as side,
           max(auth_user_id)  as auth_user_id,
           coalesce(sum(amount), 0) as locked
    from public.ledger_entries
    where entry_type   = 'order_credit'
      and balance_type = 'locked'
      and status       = 'confirmed'
      and metadata->>'market_id' = p_market_id
    group by wallet, asset, metadata->>'side'
  loop
    if v_row.locked <= 0 or v_row.auth_user_id is null then continue; end if;

    -- Clear the lock.
    insert into public.ledger_entries (
      auth_user_id, wallet, asset, amount, balance_type, entry_type, status, reference_type, reference_id, metadata
    ) values (
      v_row.auth_user_id, v_row.wallet, v_row.asset, -v_row.locked,
      'locked', 'settlement', 'confirmed', 'market', p_market_id,
      jsonb_build_object('market_id', p_market_id, 'result', 'VOID', 'side', v_row.side, 'type', 'void_unlock')
    );
    -- Refund the stake to available.
    insert into public.ledger_entries (
      auth_user_id, wallet, asset, amount, balance_type, entry_type, status, reference_type, reference_id, metadata
    ) values (
      v_row.auth_user_id, v_row.wallet, v_row.asset, v_row.locked,
      'available', 'settlement', 'confirmed', 'market', p_market_id,
      jsonb_build_object('market_id', p_market_id, 'result', 'VOID', 'side', v_row.side, 'type', 'refund')
    );

    v_count := v_count + 1;
    v_refunded := v_refunded + v_row.locked;
  end loop;

  update public.markets set status = 'resolved', res = null where id = p_market_id;

  return json_build_object('voided', true, 'positions', v_count, 'refunded', v_refunded);
end;
$void$;

notify pgrst, 'reload schema';
