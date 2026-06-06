-- Atomic withdrawal: balance check + debit in one DB transaction.
-- Prevents race condition where two concurrent requests both pass the JS-side balance check.

create or replace function public.execute_withdrawal(
  p_auth_user_id  text,
  p_wallet        text,
  p_asset         text,
  p_amount        numeric,   -- total debit (amount + fee)
  p_fee           numeric,
  p_metadata      jsonb default '{}'
)
returns json
language plpgsql
security definer
as $withdrawal$
declare
  v_available numeric;
  v_entry_id  uuid;
  v_lock_key  bigint;
begin
  -- Advisory lock: blocks concurrent withdrawals per user+asset,
  -- even when ledger_entries is empty (FOR UPDATE won't lock anything on 0 rows).
  v_lock_key := hashtext(p_auth_user_id || ':' || p_asset)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- Available = confirmed balance MINUS any in-flight (pending) withdrawals.
  -- Without counting pending withdrawals, two requests could each pass the check
  -- against the full confirmed balance and over-withdraw (drain the treasury).
  select coalesce(sum(amount), 0)
  into v_available
  from public.ledger_entries
  where auth_user_id = p_auth_user_id
    and asset        = p_asset
    and balance_type = 'available'
    and (status = 'confirmed'
         or (status = 'pending' and entry_type = 'withdrawal'));

  if v_available < p_amount then
    raise exception 'insufficient balance: available % %, required % %',
      v_available, p_asset, p_amount, p_asset;
  end if;

  insert into public.ledger_entries (
    auth_user_id,
    wallet,
    asset,
    amount,
    balance_type,
    entry_type,
    status,
    reference_type,
    metadata
  ) values (
    p_auth_user_id,
    p_wallet,
    p_asset,
    -p_amount,
    'available',
    'withdrawal',
    'pending',
    'withdrawal',
    p_metadata
  )
  returning id into v_entry_id;

  return json_build_object('entry_id', v_entry_id);
end;
$withdrawal$;
