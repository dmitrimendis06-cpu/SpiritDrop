-- SpiritDrop public form submissions.
--
-- Access model (no authentication yet):
--   * anon may INSERT into the columns the website forms send, and nothing else.
--   * anon may not SELECT, UPDATE or DELETE. Submissions are read in the
--     Supabase dashboard (postgres role) or, later, via a server-only secret key.
--   * Prices and age rules are re-checked here so a submission sent straight to
--     the Data API with the public key can't store impossible values.
--     Keep these figures in sync with public/spiritdrop-data.js (SD.RULES).

-- ---------------------------------------------------------------------------
-- Event enquiries (Contact page and home page enquiry form)
-- ---------------------------------------------------------------------------
create table public.enquiries (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 120),
  phone text not null check (char_length(phone) between 8 and 30),
  email text not null check (char_length(email) between 3 and 254 and email like '%_@_%._%'),
  event_type text check (char_length(event_type) <= 60),
  event_date date,
  guests text check (char_length(guests) <= 30),
  suburb text check (char_length(suburb) <= 120),
  message text check (char_length(message) <= 4000)
);

-- ---------------------------------------------------------------------------
-- Newsletter ("Drop List") sign-ups — separate, optional marketing consent
-- ---------------------------------------------------------------------------
create table public.newsletter_signups (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  email text not null check (char_length(email) between 3 and 254 and email like '%_@_%._%')
);
create unique index newsletter_signups_email_key on public.newsletter_signups (lower(email));

-- ---------------------------------------------------------------------------
-- Booking requests (checkout). No payment is taken; staff confirm each one.
-- ---------------------------------------------------------------------------
create table public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status text not null default 'new'
    check (status in ('new', 'confirmed', 'cancelled', 'completed')),

  -- one flavour name per dispenser
  flavours text[] not null check (cardinality(flavours) between 1 and 50),
  dispensers integer not null,
  constraint booking_requests_dispensers_match check (dispensers = cardinality(flavours)),

  event_date date not null,
  collection_date date not null,
  constraint booking_requests_next_day_collection check (collection_date = event_date + 1),
  delivery_window text not null check (char_length(delivery_window) <= 40),
  collection_window text not null check (char_length(collection_window) <= 40),

  street text not null check (char_length(street) between 1 and 200),
  unit text check (char_length(unit) <= 60),
  suburb text not null check (char_length(suburb) between 1 and 120),
  state text not null check (state in ('NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT')),
  postcode text not null check (postcode ~ '^[0-9]{4}$'),
  delivery_instructions text check (char_length(delivery_instructions) <= 500),
  event_notes text check (char_length(event_notes) <= 2000),
  zone_id text not null check (char_length(zone_id) <= 10),

  customer_name text not null check (char_length(customer_name) between 1 and 120),
  customer_email text not null check (char_length(customer_email) between 3 and 254 and customer_email like '%_@_%._%'),
  customer_phone text not null check (char_length(customer_phone) between 8 and 30),
  date_of_birth date not null,
  recipient_type text not null check (recipient_type in ('self', 'other')),
  recipient_name text check (char_length(recipient_name) <= 120),
  constraint booking_requests_recipient_named check (recipient_type = 'self' or recipient_name is not null),
  responsible_supply_ack boolean not null check (responsible_supply_ack),
  terms_accepted boolean not null check (terms_accepted),

  -- AUD, GST-inclusive where applicable. $200 per dispenser, $50 bond per dispenser.
  subtotal_aud numeric(10, 2) not null,
  delivery_fee_aud numeric(10, 2) not null check (delivery_fee_aud >= 0),
  bond_aud numeric(10, 2) not null,
  total_aud numeric(10, 2) not null,
  constraint booking_requests_subtotal check (subtotal_aud = dispensers * 200),
  constraint booking_requests_bond check (bond_aud = dispensers * 50),
  constraint booking_requests_total check (total_aud = subtotal_aud + delivery_fee_aud + bond_aud)
);

create index booking_requests_event_date_idx on public.booking_requests (event_date);

-- Date rules depend on today's date, so they live in a trigger rather than a CHECK.
create function public.booking_requests_validate_dates()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.date_of_birth > (current_date - interval '18 years')::date then
    raise exception 'Purchaser must be 18 or over' using errcode = 'check_violation';
  end if;
  if new.event_date <= current_date then
    raise exception 'Event date must be after today (no same-day delivery)' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger booking_requests_validate_dates
  before insert or update on public.booking_requests
  for each row execute function public.booking_requests_validate_dates();

-- Trigger function is not an API endpoint.
revoke execute on function public.booking_requests_validate_dates() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Privileges: least privilege. Start from nothing, then grant insert-only.
-- ---------------------------------------------------------------------------
revoke all on table public.enquiries, public.newsletter_signups, public.booking_requests
  from public, anon, authenticated;

grant insert (name, phone, email, event_type, event_date, guests, suburb, message)
  on table public.enquiries to anon;

grant insert (email) on table public.newsletter_signups to anon;

grant insert (
  flavours, dispensers, event_date, collection_date, delivery_window, collection_window,
  street, unit, suburb, state, postcode, delivery_instructions, event_notes, zone_id,
  customer_name, customer_email, customer_phone, date_of_birth, recipient_type, recipient_name,
  responsible_supply_ack, terms_accepted,
  subtotal_aud, delivery_fee_aud, bond_aud, total_aud
) on table public.booking_requests to anon;

-- ---------------------------------------------------------------------------
-- Row Level Security: anyone may submit; no one may read back via the API.
-- ---------------------------------------------------------------------------
alter table public.enquiries enable row level security;
alter table public.newsletter_signups enable row level security;
alter table public.booking_requests enable row level security;

create policy "Anyone can submit an enquiry"
  on public.enquiries for insert to anon with check (true);

create policy "Anyone can join the newsletter"
  on public.newsletter_signups for insert to anon with check (true);

create policy "Anyone can submit a booking request"
  on public.booking_requests for insert to anon with check (true);
