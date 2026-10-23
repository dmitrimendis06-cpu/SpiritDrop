-- SpiritDrop orders backend (pre-Stripe).
--
-- Flow: browser -> Edge Function `create-checkout-session` (secret key, server-side)
--       -> public.create_pending_order(jsonb) -> orders + order_items.
--
-- Access model:
--   * anon/authenticated have NO access to orders, order_items, order_addons,
--     inventory_config or catalog_addons, and cannot execute the order functions.
--   * Catalog data (flavours, zones, pricing) is public information: anon may SELECT it,
--     so the website can read the same source of truth the backend prices from.
--   * service_role (Edge Function only) creates orders through create_pending_order().
--   * All money is integer cents (AUD). All timestamps are server-side.

-- ===========================================================================
-- 1. Catalog: one server-side source of truth for flavours, zones and prices
--    Seeded from public/spiritdrop-data.js. `npm run check:catalog` detects drift.
-- ===========================================================================
create table public.catalog_flavours (
  id text primary key check (id ~ '^sd-[0-9]{2}$'),
  slug text not null unique,
  name text not null unique,
  sort_order integer not null,
  active boolean not null default true
);

insert into public.catalog_flavours (id, slug, name, sort_order) values
  ('sd-01', 'tropical-sunset',  'Tropical Sunset',  1),
  ('sd-02', 'pineberry-spirit', 'Pineberry Spirit', 2),
  ('sd-03', 'sweetmelon-vodka', 'Sweetmelon Vodka', 3),
  ('sd-04', 'strawberry-cream', 'Strawberry Cream', 4),
  ('sd-05', 'fruit-fizz',       'Fruit Fizz',       5),
  ('sd-06', 'coconut-fix',      'Coconut Fix',      6),
  ('sd-07', 'mint-mojito',      'Mint Mojito',      7),
  ('sd-08', 'fresh-melon',      'Fresh Melon',      8),
  ('sd-09', 'apple-on-fire',    'Apple on Fire',    9),
  ('sd-10', 'wow-grape',        'Wow Grape',        10),
  ('sd-11', 'pina-colada',      'Piña Colada',      11),
  ('sd-12', 'slurp-juice',      'Slurp Juice',      12);

-- Current postcode-zone rules: a postcode matches a zone by its first 3 digits.
create table public.delivery_zones (
  id text primary key,
  name text not null,
  fee_cents integer not null check (fee_cents >= 0),
  postcode_prefixes text[] not null,
  active boolean not null default true
);

insert into public.delivery_zones (id, name, fee_cents, postcode_prefixes) values
  ('z1', 'Zone 1 · Liverpool Local',          0,    array['216','217','218','219','220']),
  ('z2', 'Zone 2 · South-West & Parramatta',  1900, array['214','215','255','256','274','275','276','277']),
  ('z3', 'Zone 3 · Sydney Metro',             2900, array['200','201','202','203','204','205','206','207','208','209','210','211','212','213','221','222','223']),
  ('z4', 'Zone 4 · Outer Metro & Fringe',     3900, array['225','226','227','245','248','250','251','252','253','278']);

-- Single-row pricing config (the `id` column can only ever be true).
create table public.pricing_config (
  id boolean primary key default true check (id),
  dispenser_price_cents integer not null check (dispenser_price_cents > 0),
  bond_per_dispenser_cents integer not null check (bond_per_dispenser_cents >= 0),
  drinks_per_dispenser integer not null check (drinks_per_dispenser > 0),
  currency text not null default 'aud' check (currency = 'aud'),
  updated_at timestamptz not null default now()
);
insert into public.pricing_config (dispenser_price_cents, bond_per_dispenser_cents, drinks_per_dispenser)
values (20000, 5000, 20);

-- Single-row operational capacity: THE only place the fleet size lives.
create table public.inventory_config (
  id boolean primary key default true check (id),
  active_dispenser_capacity integer not null check (active_dispenser_capacity >= 0),
  -- How long an unpaid pending_payment order holds stock. Must exceed the future
  -- Stripe Checkout Session expiry (Stripe's minimum is 30 minutes).
  pending_hold_minutes integer not null default 35 check (pending_hold_minutes between 31 and 1440),
  updated_at timestamptz not null default now()
);
-- PLACEHOLDER CAPACITY: set the real fleet size with
--   update public.inventory_config set active_dispenser_capacity = <n>, updated_at = now();
insert into public.inventory_config (active_dispenser_capacity) values (10);

-- Future add-ons. Inactive until prices and pack sizes are confirmed; no prices invented.
create table public.catalog_addons (
  id text primary key,
  name text not null,
  unit_price_cents integer check (unit_price_cents >= 0),
  active boolean not null default false,
  constraint catalog_addons_priced_when_active check (not active or unit_price_cents is not null)
);
insert into public.catalog_addons (id, name) values
  ('cups', 'Cocktail Cups'),
  ('garnish', 'Dried Garnishes'),
  ('ice', 'Ice Bags (optional)');

-- ===========================================================================
-- 2. Orders
-- ===========================================================================
create type public.order_status as enum (
  'pending_payment', 'paid', 'preparing', 'out_for_delivery', 'delivered',
  'collected', 'bond_refunded', 'cancelled', 'payment_failed'
);

-- Customer-facing order numbers (SD-000001). Not a security boundary.
create sequence public.order_number_seq;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique
    default ('SD-' || lpad(nextval('public.order_number_seq')::text, 6, '0')),

  customer_name text not null check (char_length(customer_name) between 1 and 120),
  customer_email text not null check (char_length(customer_email) between 3 and 254),
  customer_phone text not null check (char_length(customer_phone) between 8 and 30),
  customer_dob date not null,

  delivery_street text not null check (char_length(delivery_street) between 1 and 200),
  delivery_unit text check (char_length(delivery_unit) <= 60),
  delivery_suburb text not null check (char_length(delivery_suburb) between 1 and 120),
  delivery_state text not null check (delivery_state in ('NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT')),
  delivery_postcode text not null check (delivery_postcode ~ '^[0-9]{4}$'),
  delivery_instructions text check (char_length(delivery_instructions) <= 500),
  delivery_zone text not null references public.delivery_zones (id),
  event_notes text check (char_length(event_notes) <= 2000),

  event_date date not null,
  collection_date date generated always as (event_date + 1) stored,
  delivery_window text not null check (char_length(delivery_window) <= 40),
  collection_window text not null check (char_length(collection_window) <= 40),

  recipient_type text not null check (recipient_type in ('self', 'other')),
  recipient_name text check (char_length(recipient_name) <= 120),
  constraint orders_recipient_named check (recipient_type = 'self' or recipient_name is not null),
  terms_accepted_at timestamptz not null,
  responsible_supply_ack_at timestamptz not null,

  dispenser_quantity integer not null check (dispenser_quantity between 1 and 50),
  product_subtotal_cents integer not null check (product_subtotal_cents >= 0),
  delivery_fee_cents integer not null check (delivery_fee_cents >= 0),
  bond_total_cents integer not null check (bond_total_cents >= 0),
  addon_total_cents integer not null default 0 check (addon_total_cents >= 0),
  total_cents integer not null,
  constraint orders_total_adds_up check (
    total_cents = product_subtotal_cents + delivery_fee_cents + bond_total_cents + addon_total_cents
  ),
  currency text not null default 'aud' check (currency = 'aud'),

  status public.order_status not null default 'pending_payment',
  -- Unpaid orders hold stock only until this time; expired holds never block availability.
  hold_expires_at timestamptz,
  constraint orders_pending_has_hold check (status <> 'pending_payment' or hold_expires_at is not null),

  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);

create index orders_event_date_idx on public.orders (event_date);
create index orders_status_idx on public.orders (status);
-- order_number, stripe_checkout_session_id and stripe_payment_intent_id are indexed by their UNIQUE constraints.

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  flavour_id text not null references public.catalog_flavours (id),
  flavour_name_snapshot text not null,
  quantity integer not null check (quantity between 1 and 50),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  created_at timestamptz not null default now(),
  constraint order_items_one_row_per_flavour unique (order_id, flavour_id)
);

create table public.order_addons (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  addon_id text not null references public.catalog_addons (id),
  addon_name_snapshot text not null,
  quantity integer not null check (quantity between 1 and 100),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  created_at timestamptz not null default now(),
  constraint order_addons_one_row_per_addon unique (order_id, addon_id)
);

-- Server-side updated_at.
create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- 3. Helpers
-- ===========================================================================

-- "Today" in Sydney, so same-day and age rules don't depend on the server timezone.
create function public.sydney_today()
returns date
language sql
stable
security invoker
set search_path = ''
as $$ select (now() at time zone 'Australia/Sydney')::date $$;

-- Strict YYYY-MM-DD parse; NULL for anything else (including impossible dates).
create function public.parse_iso_date(t text)
returns date
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if t is null or t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  return t::date;
exception when others then
  return null;
end;
$$;

-- Hourly window ids used by the checkout ("h14") -> label ("2:00 PM – 3:00 PM").
-- Delivery windows start 10:00–20:00, collection windows 09:00–19:00 (see SD.DELIVERY_SLOTS).
create function public.window_label(p_kind text, p_id text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  h integer;
begin
  if p_id is null or p_id !~ '^h[0-9]{1,2}$' then
    return null;
  end if;
  h := substr(p_id, 2)::integer;
  if (p_kind = 'delivery' and h between 10 and 20) or (p_kind = 'collection' and h between 9 and 19) then
    return to_char(make_time(h, 0, 0), 'FMHH12:MI AM') || ' – ' || to_char(make_time((h + 1) % 24, 0, 0), 'FMHH12:MI AM');
  end if;
  return null;
end;
$$;

-- ===========================================================================
-- 4. Authoritative pricing. Browser-sent prices are never read.
--    p_items: [{"flavour_id": "sd-07", "quantity": 2}, ...]
--    Errors use SQLSTATE SD400 (bad input) / SD422 (not serviceable).
-- ===========================================================================
create function public.quote_order(p_items jsonb, p_postcode text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_price public.pricing_config;
  v_zone public.delivery_zones;
  v_item jsonb;
  v_unknown integer;
  v_qty integer;
  v_lines jsonb;
  v_subtotal integer;
  v_bond integer;
begin
  select * into v_price from public.pricing_config where id;

  if p_postcode is null or p_postcode !~ '^[0-9]{4}$' then
    raise exception using errcode = 'SD400', message = 'Enter a valid 4-digit postcode.';
  end if;
  select * into v_zone
    from public.delivery_zones z
    where z.active and left(p_postcode, 3) = any (z.postcode_prefixes)
    order by z.id
    limit 1;
  if not found then
    raise exception using errcode = 'SD422',
      message = 'This location is currently outside our standard delivery area. Contact SpiritDrop to discuss availability.';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = 'SD400', message = 'Choose at least one dispenser.';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'flavour_id') is distinct from 'string'
       or jsonb_typeof(v_item -> 'quantity') is distinct from 'number'
       or (v_item ->> 'quantity') !~ '^[1-9][0-9]{0,1}$' then
      raise exception using errcode = 'SD400', message = 'Each dispenser line needs a flavour and a whole-number quantity.';
    end if;
  end loop;

  -- Merge duplicate flavour lines, then require every id to be a current flavour.
  with req as (
    select e ->> 'flavour_id' as flavour_id, sum((e ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) e
    group by 1
  )
  select
    count(*) filter (where f.id is null)::integer,
    coalesce(sum(req.quantity), 0)::integer,
    jsonb_agg(
      jsonb_build_object(
        'flavour_id', f.id,
        'flavour_name', f.name,
        'quantity', req.quantity,
        'unit_price_cents', v_price.dispenser_price_cents,
        'line_total_cents', req.quantity * v_price.dispenser_price_cents
      ) order by f.sort_order
    ) filter (where f.id is not null)
  into v_unknown, v_qty, v_lines
  from req
  left join public.catalog_flavours f on f.id = req.flavour_id and f.active;

  if v_unknown > 0 then
    raise exception using errcode = 'SD422', message = 'One of the selected flavours is not available.';
  end if;
  if v_qty < 1 or v_qty > 50 then
    raise exception using errcode = 'SD400', message = 'Choose between 1 and 50 dispensers.';
  end if;

  v_subtotal := v_qty * v_price.dispenser_price_cents;
  v_bond := v_qty * v_price.bond_per_dispenser_cents;

  return jsonb_build_object(
    'currency', v_price.currency,
    'dispenser_quantity', v_qty,
    'drinks', v_qty * v_price.drinks_per_dispenser,
    'zone_id', v_zone.id,
    'zone_name', v_zone.name,
    'product_subtotal_cents', v_subtotal,
    'bond_total_cents', v_bond,
    'delivery_fee_cents', v_zone.fee_cents,
    'addon_total_cents', 0,
    'total_cents', v_subtotal + v_bond + v_zone.fee_cents,
    'items', v_lines
  );
end;
$$;

-- ===========================================================================
-- 5. Availability for a finite fleet.
--    A dispenser booked for event date E is out on E (delivery) and E+1
--    (collection). A request for D therefore competes on days D and D+1:
--      committed(day X) = quantity of holding orders with event_date in (X-1, X)
--      available        = capacity - max(committed(D), committed(D+1))
--    Holding orders = confirmed statuses + unexpired pending_payment holds.
-- ===========================================================================
create function public.check_availability(p_event_date date, p_quantity integer)
returns table (available boolean, available_quantity integer, requested_quantity integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with cap as (
    select active_dispenser_capacity as capacity from public.inventory_config where id
  ),
  holding as (
    select o.event_date, o.dispenser_quantity as qty
    from public.orders o
    where o.event_date between p_event_date - 1 and p_event_date + 1
      and (
        o.status in ('paid', 'preparing', 'out_for_delivery', 'delivered')
        or (o.status = 'pending_payment' and o.hold_expires_at > now())
      )
  ),
  committed as (
    select greatest(
      coalesce(sum(qty) filter (where event_date in (p_event_date - 1, p_event_date)), 0),
      coalesce(sum(qty) filter (where event_date in (p_event_date, p_event_date + 1)), 0)
    )::integer as n
    from holding
  )
  select
    greatest(cap.capacity - committed.n, 0) >= p_quantity,
    greatest(cap.capacity - committed.n, 0),
    p_quantity
  from cap, committed;
$$;

-- ===========================================================================
-- 6. Create a pending_payment order atomically.
--    Locks the inventory_config row first, so concurrent checkouts queue and
--    two customers can never both take the last dispenser.
--    Errors: SD400 bad input, SD422 not serviceable, SD409 not enough stock.
-- ===========================================================================
create function public.create_pending_order(p jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_today date := public.sydney_today();
  v_hold_minutes integer;
  v_dob date;
  v_event date;
  v_delivery text;
  v_collection text;
  v_recipient text;
  v_quote jsonb;
  v_avail record;
  v_order public.orders;
begin
  -- Serialise all order creation on the single inventory row.
  select pending_hold_minutes into v_hold_minutes from public.inventory_config where id for update;

  if coalesce(btrim(p ->> 'customer_name'), '') = '' then
    raise exception using errcode = 'SD400', message = 'Enter your name.';
  end if;
  if coalesce(p ->> 'customer_email', '') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = 'SD400', message = 'Enter a valid email address.';
  end if;
  if coalesce(p ->> 'customer_phone', '') !~ '^[0-9+() -]{8,30}$' then
    raise exception using errcode = 'SD400', message = 'Enter a contactable phone number.';
  end if;

  v_dob := public.parse_iso_date(p ->> 'customer_dob');
  if v_dob is null or v_dob < date '1900-01-01' then
    raise exception using errcode = 'SD400', message = 'Enter a valid date of birth.';
  end if;
  if v_dob > (v_today - interval '18 years')::date then
    raise exception using errcode = 'SD400', message = 'You must be 18 or over to order alcohol.';
  end if;

  v_event := public.parse_iso_date(p ->> 'event_date');
  if v_event is null then
    raise exception using errcode = 'SD400', message = 'Enter a valid event date.';
  end if;
  if v_event <= v_today then
    raise exception using errcode = 'SD400', message = 'Same-day delivery is not available. Choose an event date from tomorrow onwards.';
  end if;
  if v_event > v_today + 730 then
    raise exception using errcode = 'SD400', message = 'Choose an event date within the next two years.';
  end if;

  v_delivery := public.window_label('delivery', p ->> 'delivery_window');
  v_collection := public.window_label('collection', p ->> 'collection_window');
  if v_delivery is null then
    raise exception using errcode = 'SD400', message = 'Pick a delivery window.';
  end if;
  if v_collection is null then
    raise exception using errcode = 'SD400', message = 'Pick a collection window.';
  end if;

  if coalesce(btrim(p ->> 'delivery_street'), '') = '' then
    raise exception using errcode = 'SD400', message = 'Enter your street address.';
  end if;
  if coalesce(btrim(p ->> 'delivery_suburb'), '') = '' then
    raise exception using errcode = 'SD400', message = 'Enter your suburb.';
  end if;
  if coalesce(p ->> 'delivery_state', '') not in ('NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT') then
    raise exception using errcode = 'SD400', message = 'Choose a valid state.';
  end if;

  v_recipient := p ->> 'recipient_type';
  if v_recipient is null or v_recipient not in ('self', 'other') then
    raise exception using errcode = 'SD400', message = 'Choose who will receive the delivery.';
  end if;
  if v_recipient = 'other' and coalesce(btrim(p ->> 'recipient_name'), '') = '' then
    raise exception using errcode = 'SD400', message = 'Enter the name of the adult receiving the delivery.';
  end if;

  if (p -> 'terms_accepted') is distinct from 'true'::jsonb then
    raise exception using errcode = 'SD400', message = 'Please agree to the terms to continue.';
  end if;
  if (p -> 'responsible_supply_ack') is distinct from 'true'::jsonb then
    raise exception using errcode = 'SD400', message = 'Please confirm you understand your responsible-supply obligations.';
  end if;

  -- Price and zone from the catalog only.
  v_quote := public.quote_order(p -> 'items', btrim(p ->> 'delivery_postcode'));

  select * into v_avail from public.check_availability(v_event, (v_quote ->> 'dispenser_quantity')::integer);
  if not v_avail.available then
    raise exception using errcode = 'SD409',
      message = 'Not enough dispensers are available for that date.',
      detail = jsonb_build_object(
        'available', false,
        'available_quantity', v_avail.available_quantity,
        'requested_quantity', v_avail.requested_quantity
      )::text;
  end if;

  insert into public.orders (
    customer_name, customer_email, customer_phone, customer_dob,
    delivery_street, delivery_unit, delivery_suburb, delivery_state, delivery_postcode,
    delivery_instructions, delivery_zone, event_notes,
    event_date, delivery_window, collection_window,
    recipient_type, recipient_name, terms_accepted_at, responsible_supply_ack_at,
    dispenser_quantity, product_subtotal_cents, delivery_fee_cents, bond_total_cents, addon_total_cents, total_cents,
    currency, status, hold_expires_at
  ) values (
    btrim(p ->> 'customer_name'), lower(btrim(p ->> 'customer_email')), btrim(p ->> 'customer_phone'), v_dob,
    btrim(p ->> 'delivery_street'), nullif(btrim(p ->> 'delivery_unit'), ''), btrim(p ->> 'delivery_suburb'),
    p ->> 'delivery_state', btrim(p ->> 'delivery_postcode'),
    nullif(btrim(p ->> 'delivery_instructions'), ''), v_quote ->> 'zone_id', nullif(btrim(p ->> 'event_notes'), ''),
    v_event, v_delivery, v_collection,
    v_recipient, case when v_recipient = 'other' then btrim(p ->> 'recipient_name') end, now(), now(),
    (v_quote ->> 'dispenser_quantity')::integer,
    (v_quote ->> 'product_subtotal_cents')::integer,
    (v_quote ->> 'delivery_fee_cents')::integer,
    (v_quote ->> 'bond_total_cents')::integer,
    0,
    (v_quote ->> 'total_cents')::integer,
    v_quote ->> 'currency', 'pending_payment', now() + make_interval(mins => v_hold_minutes)
  )
  returning * into v_order;

  insert into public.order_items (order_id, flavour_id, flavour_name_snapshot, quantity, unit_price_cents)
  select v_order.id, l ->> 'flavour_id', l ->> 'flavour_name', (l ->> 'quantity')::integer, (l ->> 'unit_price_cents')::integer
  from jsonb_array_elements(v_quote -> 'items') l;

  return v_quote || jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'status', v_order.status,
    'event_date', v_order.event_date,
    'collection_date', v_order.collection_date,
    'hold_expires_at', v_order.hold_expires_at
  );
end;
$$;

-- ===========================================================================
-- 7. Privileges and RLS
--    Supabase's default privileges grant new public objects to anon/authenticated,
--    so revoke explicitly, then grant back only what is intended.
-- ===========================================================================
revoke all on table
  public.catalog_flavours, public.delivery_zones, public.pricing_config, public.inventory_config,
  public.catalog_addons, public.orders, public.order_items, public.order_addons
  from public, anon, authenticated;
revoke all on sequence public.order_number_seq from public, anon, authenticated;

revoke execute on function
  public.set_updated_at(), public.sydney_today(), public.parse_iso_date(text), public.window_label(text, text),
  public.quote_order(jsonb, text), public.check_availability(date, integer), public.create_pending_order(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.quote_order(jsonb, text), public.check_availability(date, integer), public.create_pending_order(jsonb)
  to service_role;

alter table public.catalog_flavours enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.pricing_config enable row level security;
alter table public.inventory_config enable row level security;
alter table public.catalog_addons enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_addons enable row level security;

-- Public catalog: read-only, active rows only. No policies on the order or
-- inventory tables, so anon/authenticated can never read or write them.
grant select on table public.catalog_flavours, public.delivery_zones, public.pricing_config to anon;

create policy "Anyone can read active flavours"
  on public.catalog_flavours for select to anon using (active);
create policy "Anyone can read active delivery zones"
  on public.delivery_zones for select to anon using (active);
create policy "Anyone can read pricing"
  on public.pricing_config for select to anon using (true);
