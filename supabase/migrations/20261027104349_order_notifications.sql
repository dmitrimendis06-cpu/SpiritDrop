-- Paid-order email notifications + provider-neutral payment fields.
--
-- Flow: orders.status changes to 'paid'
--   -> trigger private.queue_order_notifications() (pg_net, async, after commit)
--   -> Edge Function `send-order-notifications` (token-checked)
--   -> claims each notification once (order_notifications), sends via the email
--      provider, records the outcome. Supabase stays the source of truth;
--      an email failure never changes the order's status.

-- ===========================================================================
-- 1. Provider-neutral payment fields (payment processor not chosen yet)
-- ===========================================================================
alter table public.orders rename column stripe_checkout_session_id to payment_session_id;
alter table public.orders rename column stripe_payment_intent_id to payment_reference;
alter table public.orders rename constraint orders_stripe_checkout_session_id_key to orders_payment_session_id_key;
alter table public.orders rename constraint orders_stripe_payment_intent_id_key to orders_payment_reference_key;
alter table public.orders
  add column payment_provider text check (char_length(payment_provider) <= 40),
  add column business_notification_sent_at timestamptz,
  add column customer_confirmation_sent_at timestamptz;

comment on column public.orders.payment_provider is 'Payment processor name once chosen (generic; no provider hard-coded).';
comment on column public.orders.payment_session_id is 'Provider checkout/session id for this order.';
comment on column public.orders.payment_reference is 'Provider payment reference (e.g. payment/charge id) once paid.';
comment on column public.orders.addon_total_cents is 'Add-ons are not offered at launch; always 0 until catalog_addons are activated.';

-- paid_at is always set by the server when an order first becomes paid.
create function public.orders_set_paid_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'paid' and new.paid_at is null then
    new.paid_at := now();
  end if;
  return new;
end;
$$;

create trigger orders_set_paid_at
  before insert or update of status on public.orders
  for each row execute function public.orders_set_paid_at();

-- ===========================================================================
-- 2. Notification log: one row per (order, kind). Makes sending idempotent and
--    records failures for retry.
-- ===========================================================================
create table public.order_notifications (
  order_id uuid not null references public.orders (id) on delete cascade,
  kind text not null check (kind in ('business', 'customer')),
  status text not null check (status in ('sending', 'sent', 'failed', 'provider_not_configured')),
  attempts integer not null default 1 check (attempts >= 1),
  last_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  provider_message_id text,
  last_error text check (char_length(last_error) <= 1000),
  primary key (order_id, kind)
);
create index order_notifications_status_idx on public.order_notifications (status);

-- Claim the right to send one notification. Returns true only if the caller
-- should send now: never after a successful send, and never while another
-- attempt is in flight (unless that attempt is stale, >10 min).
create function public.claim_order_notification(p_order_id uuid, p_kind text)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  if not exists (
    select 1 from public.orders
    where id = p_order_id
      and status in ('paid', 'preparing', 'out_for_delivery', 'delivered', 'collected', 'bond_refunded')
  ) then
    return false; -- only genuinely paid orders are ever notified
  end if;

  insert into public.order_notifications as n (order_id, kind, status)
  values (p_order_id, p_kind, 'sending')
  on conflict (order_id, kind) do update
    set status = 'sending', attempts = n.attempts + 1, last_attempt_at = now(), last_error = null
    where n.status in ('failed', 'provider_not_configured')
       or (n.status = 'sending' and n.last_attempt_at < now() - interval '10 minutes')
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

-- Record the outcome of a claimed attempt. Never touches orders.status.
create function public.record_order_notification(
  p_order_id uuid, p_kind text, p_status text, p_message_id text default null, p_error text default null
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed', 'provider_not_configured') then
    raise exception 'invalid notification status %', p_status;
  end if;

  update public.order_notifications
     set status = p_status,
         sent_at = case when p_status = 'sent' then now() else sent_at end,
         provider_message_id = coalesce(p_message_id, provider_message_id),
         last_error = left(p_error, 1000)
   where order_id = p_order_id and kind = p_kind;

  if p_status = 'sent' then
    update public.orders
       set business_notification_sent_at = case when p_kind = 'business' then coalesce(business_notification_sent_at, now()) else business_notification_sent_at end,
           customer_confirmation_sent_at = case when p_kind = 'customer' then coalesce(customer_confirmation_sent_at, now()) else customer_confirmation_sent_at end
     where id = p_order_id;
  end if;
end;
$$;

-- ===========================================================================
-- 3. Trigger: queue notifications when an order becomes paid
-- ===========================================================================
create extension if not exists pg_net with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Random token shared between the trigger and the Edge Function. Generated
-- inside the database; its value never appears in source control.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'order_notify_token',
  'Authenticates calls from the paid-order trigger to send-order-notifications');
select vault.create_secret('https://nafwzirivmdbvdzdkjhq.supabase.co/functions/v1/send-order-notifications',
  'order_notify_url', 'send-order-notifications Edge Function URL');

-- Queues an async HTTP call (sent after the transaction commits). Also usable
-- by staff to retry: select private.queue_order_notifications('<order uuid>');
-- SECURITY DEFINER only to read Vault; lives in the unexposed `private` schema.
create function private.queue_order_notifications(p_order_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'order_notify_url');
  v_token text := (select decrypted_secret from vault.decrypted_secrets where name = 'order_notify_token');
begin
  return net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-token', v_token),
    body := jsonb_build_object('order_id', p_order_id)
  );
end;
$$;
revoke execute on function private.queue_order_notifications(uuid) from public, anon, authenticated;

create function private.orders_queue_paid_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.queue_order_notifications(new.id);
  return new;
end;
$$;
revoke execute on function private.orders_queue_paid_notifications() from public, anon, authenticated;

-- Fires only on the transition into 'paid' (pending_payment never notifies;
-- a repeated "paid" update is not a transition, so it doesn't fire again).
create trigger orders_queue_paid_notifications
  after update of status on public.orders
  for each row
  when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function private.orders_queue_paid_notifications();

-- Lets the Edge Function check the token without reading Vault itself.
-- Returns only true/false. SECURITY DEFINER to read Vault; service_role only.
create function public.verify_order_notify_token(p_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_token is not null and p_token = (
    select decrypted_secret from vault.decrypted_secrets where name = 'order_notify_token'
  );
$$;

-- ===========================================================================
-- 4. Privileges
-- ===========================================================================
revoke all on table public.order_notifications from public, anon, authenticated;
alter table public.order_notifications enable row level security;

revoke execute on function
  public.orders_set_paid_at(),
  public.claim_order_notification(uuid, text),
  public.record_order_notification(uuid, text, text, text, text),
  public.verify_order_notify_token(text)
  from public, anon, authenticated;
grant execute on function
  public.claim_order_notification(uuid, text),
  public.record_order_notification(uuid, text, text, text, text),
  public.verify_order_notify_token(text)
  to service_role;
