create extension if not exists pgcrypto;

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  auth_user_id text not null,
  wallet text not null,
  asset text not null check (asset in ('USDC', 'USDT', 'SOL')),
  amount numeric not null,
  balance_type text not null default 'available' check (balance_type in ('available', 'locked')),
  entry_type text not null check (
    entry_type in (
      'deposit',
      'order_debit',
      'order_credit',
      'settlement',
      'withdrawal',
      'adjustment',
      'cashout'
    )
  ),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'failed', 'reversed')),
  reference_type text,
  reference_id text,
  tx_signature text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ledger_entries_auth_user_created_idx
on public.ledger_entries (auth_user_id, created_at desc);

create index if not exists ledger_entries_wallet_created_idx
on public.ledger_entries (wallet, created_at desc);

create index if not exists ledger_entries_balance_idx
on public.ledger_entries (auth_user_id, asset, balance_type, status);

create unique index if not exists ledger_entries_tx_type_key
on public.ledger_entries (tx_signature, entry_type)
where tx_signature is not null;

alter table public.ledger_entries enable row level security;

comment on table public.ledger_entries is
  'Append-only trading ledger. Access exclusively via service_role through Next.js API routes. Confirmed entries are summed by asset and balance_type to derive trading balances.';

create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),
  auth_user_id text not null,
  wallet text not null,
  asset text not null check (asset in ('USDC', 'USDT', 'SOL')),
  amount numeric not null check (amount > 0),
  tx_signature text not null unique,
  ledger_entry_id uuid references public.ledger_entries(id),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'failed', 'reversed')),
  detected_at timestamptz not null default now(),
  confirmed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists deposits_auth_user_detected_idx
on public.deposits (auth_user_id, detected_at desc);

create index if not exists deposits_wallet_detected_idx
on public.deposits (wallet, detected_at desc);

alter table public.deposits enable row level security;

comment on table public.deposits is
  'Detected deposit records. Sync endpoint will insert idempotently by tx_signature and pair confirmed deposits with ledger_entries.';
