# Supabase to Hostinger Migration Audit and Blueprint

Audit date: 31 October 2026. Branch: `admin-portal-v1`.

Supabase remains the production backend until the Hostinger replacement is built and tested. This document changes nothing. No secrets appear in it.

## 1. How this audit was done

| Source | Used for |
|---|---|
| `supabase/migrations/*.sql` | Functions, triggers, policies, grants, constraints, indexes |
| `supabase/functions/*/index.ts` | Edge Function behaviour |
| `app/api/*`, `lib/*`, `public/spiritdrop-cart.js`, `public/spiritdrop-data.js` | What the live website actually does |
| `scripts/test-backend.mjs`, `scripts/check-catalog.mjs` | Existing tests |
| Supabase read-only metadata tools | Live tables, columns, row counts, migration history, Edge Function versions |

No SQL was executed against production, including read-only queries.

**Confirmed against live metadata:** all 12 tables and their columns match the migrations. All 12 have RLS enabled. All four migrations are recorded as applied. Both Edge Functions are at the versions last deployed from this repo.

**Taken from migration files, not re-read from the live database:** policies, grants, function bodies, triggers and indexes.

**Not known from this audit:**

- The current `inventory_config.active_dispenser_capacity` value. It was seeded as a placeholder of 10; only a SQL read can confirm whether it has been changed.
- Whether `RESEND_API_KEY`, `EMAIL_FROM` or `ALLOWED_ORIGINS` have been set since testing.
- The MariaDB version on Hostinger.

## 2. Key findings

These matter more than any schema detail, and they affect what "preserve behaviour" means.

1. **The live checkout does not use the orders system.** `public/spiritdrop-cart.js` posts to `/api/booking-requests`, which writes to `booking_requests`. Nothing in the website calls `create-checkout-session`. `orders`, `order_items` and `order_notifications` have 0 rows, and only the test script exercises them.
2. **Capacity is not enforced on the live site.** `booking_requests` is not counted by `check_availability`, and the route never checks availability. A customer can request any date for up to 50 dispensers. The availability, hold and locking system exists but is not connected.
3. **Live bookings and enquiries notify nobody.** `send-order-notifications` only handles paid `orders`. New `booking_requests` and `enquiries` sit in the database until someone looks.
4. **There are two pricing implementations.** The live route prices from `public/spiritdrop-data.js` in dollars. The orders system prices from database tables in cents. `npm run check:catalog` detects drift between them, but only when run by hand.
5. **Anyone holding the public key can write directly to the form tables.** The publishable key is public by design, and the `anon` role has INSERT on the three form tables. Going straight to the Supabase REST API skips all Next.js validation. For `booking_requests`, the database catches wrong dispenser prices, bonds and totals, but **not** a false delivery fee, a zone that doesn't match the postcode, or made-up flavour names. No form has rate limiting.
6. **A paid order could lose its notifications with no record.** If the trigger's HTTP call fails or the function is down, no `order_notifications` row is created and nothing retries. There is no scheduled retry anywhere.
7. **The Privacy Policy names Supabase in Sydney** (`content/legal.html`). It must be updated before customer data moves, and Hostinger's data location must be confirmed first.

## 3. Tables

There are 12 tables, all in `public`. The `private` schema has functions only. **No dedicated availability or hold table exists:** a hold is the `hold_expires_at` column on `orders`.

Row counts come from live metadata. All `created_at` and `updated_at` values default to `now()`. A dash means no default.

### 3.1 `enquiries` (1 row)

Event enquiry form. Primary key: `id`. No foreign keys, secondary indexes or unique constraints.

| Column | Type | Null | Default | Check |
|---|---|---|---|---|
| `id` | bigint identity (always) | No | generated | |
| `created_at` | timestamptz | No | `now()` | |
| `name` | text | No | - | length 1-120 |
| `phone` | text | No | - | length 8-30 |
| `email` | text | No | - | length 3-254, `LIKE '%_@_%._%'` |
| `event_type` | text | Yes | - | length up to 60 |
| `event_date` | date | Yes | - | |
| `guests` | text | Yes | - | length up to 30 |
| `suburb` | text | Yes | - | length up to 120 |
| `message` | text | Yes | - | length up to 4000 |

The 1 row is real data, not a test row, and must be migrated.

### 3.2 `newsletter_signups` (0 rows)

Optional "Drop List" marketing sign-ups. Primary key: `id`. Unique index `newsletter_signups_email_key` on `lower(email)`.

| Column | Type | Null | Default | Check |
|---|---|---|---|---|
| `id` | bigint identity (always) | No | generated | |
| `created_at` | timestamptz | No | `now()` | |
| `email` | text | No | - | length 3-254, `LIKE '%_@_%._%'` |

### 3.3 `booking_requests` (0 rows)

**What the live checkout writes.** Primary key: `id`. Index: `booking_requests_event_date_idx` on `event_date`. No foreign keys, so `zone_id` and `flavours` are not tied to the catalog.

| Column | Type | Null | Default | Check |
|---|---|---|---|---|
| `id` | uuid | No | `gen_random_uuid()` | Route generates it |
| `created_at` | timestamptz | No | `now()` | |
| `status` | text | No | `'new'` | `new`, `confirmed`, `cancelled`, `completed` |
| `flavours` | text[] | No | - | 1-50 entries, one name per dispenser |
| `dispensers` | integer | No | - | must equal number of `flavours` |
| `event_date` | date | No | - | |
| `collection_date` | date | No | - | must equal `event_date + 1` |
| `delivery_window` | text | No | - | length up to 40 |
| `collection_window` | text | No | - | length up to 40 |
| `street` | text | No | - | length 1-200 |
| `unit` | text | Yes | - | length up to 60 |
| `suburb` | text | No | - | length 1-120 |
| `state` | text | No | - | `NSW ACT VIC QLD SA WA TAS NT` |
| `postcode` | text | No | - | `^[0-9]{4}$` |
| `delivery_instructions` | text | Yes | - | length up to 500 |
| `event_notes` | text | Yes | - | length up to 2000 |
| `zone_id` | text | No | - | length up to 10 |
| `customer_name` | text | No | - | length 1-120 |
| `customer_email` | text | No | - | length 3-254, `LIKE '%_@_%._%'` |
| `customer_phone` | text | No | - | length 8-30 |
| `date_of_birth` | date | No | - | 18+ enforced by trigger |
| `recipient_type` | text | No | - | `self`, `other` |
| `recipient_name` | text | Yes | - | length up to 120; required when `other` |
| `responsible_supply_ack` | boolean | No | - | must be true |
| `terms_accepted` | boolean | No | - | must be true |
| `subtotal_aud` | numeric(10,2) | No | - | `= dispensers * 200` |
| `delivery_fee_aud` | numeric(10,2) | No | - | `>= 0` |
| `bond_aud` | numeric(10,2) | No | - | `= dispensers * 50` |
| `total_aud` | numeric(10,2) | No | - | `= subtotal + delivery + bond` |

The $200 and $50 are hard-coded in these constraints, so this is a third place prices live.

### 3.4 `catalog_flavours` (12 rows)

Primary key: `id`. Unique: `slug`, `name`. Publicly readable.

| Column | Type | Null | Default | Check |
|---|---|---|---|---|
| `id` | text | No | - | `^sd-[0-9]{2}$` |
| `slug` | text | No | - | unique |
| `name` | text | No | - | unique |
| `sort_order` | integer | No | - | |
| `active` | boolean | No | `true` | |

Seeded `sd-01` to `sd-12`: Tropical Sunset, Pineberry Spirit, Sweetmelon Vodka, Strawberry Cream, Fruit Fizz, Coconut Fix, Mint Mojito, Fresh Melon, Apple on Fire, Wow Grape, Piña Colada, Slurp Juice.

### 3.5 `delivery_zones` (4 rows)

Primary key: `id`. Publicly readable (active rows).

| Column | Type | Null | Default | Check |
|---|---|---|---|---|
| `id` | text | No | - | |
| `name` | text | No | - | |
| `fee_cents` | integer | No | - | `>= 0` |
| `postcode_prefixes` | text[] | No | - | |
| `active` | boolean | No | `true` | |

| Zone | Name | Fee | First three postcode digits |
|---|---|---|---|
| `z1` | Zone 1 · Liverpool Local | $0 | 216, 217, 218, 219, 220 |
| `z2` | Zone 2 · South-West & Parramatta | $19 | 214, 215, 255, 256, 274, 275, 276, 277 |
| `z3` | Zone 3 · Sydney Metro | $29 | 200-213, 221, 222, 223 |
| `z4` | Zone 4 · Outer Metro & Fringe | $39 | 225, 226, 227, 245, 248, 250, 251, 252, 253, 278 |

### 3.6 `pricing_config` (1 row)

A single row, enforced by a boolean primary key with `CHECK (id)`. Publicly readable.

| Column | Type | Null | Default | Check | Seed |
|---|---|---|---|---|---|
| `id` | boolean | No | `true` | must be true | |
| `dispenser_price_cents` | integer | No | - | `> 0` | 20000 |
| `bond_per_dispenser_cents` | integer | No | - | `>= 0` | 5000 |
| `drinks_per_dispenser` | integer | No | - | `> 0` | 20 |
| `currency` | text | No | `'aud'` | must be `aud` | aud |
| `updated_at` | timestamptz | No | `now()` | | |

### 3.7 `inventory_config` (1 row)

The single source of fleet capacity, in a single row. Not public.

| Column | Type | Null | Default | Check | Seed |
|---|---|---|---|---|---|
| `id` | boolean | No | `true` | must be true | |
| `active_dispenser_capacity` | integer | No | - | `>= 0` | **10 (placeholder)** |
| `pending_hold_minutes` | integer | No | 35 | 31-1440 | 35 |
| `updated_at` | timestamptz | No | `now()` | | |

### 3.8 `catalog_addons` (3 rows, dormant)

Primary key: `id`. Not public.

| Column | Type | Null | Default | Check |
|---|---|---|---|---|
| `id` | text | No | - | |
| `name` | text | No | - | |
| `unit_price_cents` | integer | Yes | - | `>= 0` |
| `active` | boolean | No | `false` | active requires a price |

Seeded: `cups`, `garnish`, `ice`, all inactive with no price.

### 3.9 `orders` (0 rows)

Primary key: `id`. Unique: `order_number`, `payment_session_id`, `payment_reference`. Indexes: `orders_event_date_idx`, `orders_status_idx`. Foreign key: `delivery_zone` references `delivery_zones(id)`.

| Column | Type | Null | Default | Check or note |
|---|---|---|---|---|
| `id` | uuid | No | `gen_random_uuid()` | |
| `order_number` | text | No | `'SD-' + 6-digit nextval` | unique; from `order_number_seq` |
| `customer_name` | text | No | - | length 1-120 |
| `customer_email` | text | No | - | length 3-254; lowercased on insert |
| `customer_phone` | text | No | - | length 8-30 |
| `customer_dob` | date | No | - | 18+ checked in function |
| `delivery_street` | text | No | - | length 1-200 |
| `delivery_unit` | text | Yes | - | length up to 60 |
| `delivery_suburb` | text | No | - | length 1-120 |
| `delivery_state` | text | No | - | `NSW ACT VIC QLD SA WA TAS NT` |
| `delivery_postcode` | text | No | - | `^[0-9]{4}$` |
| `delivery_instructions` | text | Yes | - | length up to 500 |
| `delivery_zone` | text | No | - | foreign key |
| `event_notes` | text | Yes | - | length up to 2000 |
| `event_date` | date | No | - | |
| `collection_date` | date | Generated | `event_date + 1` stored | |
| `delivery_window` | text | No | - | label; length up to 40 |
| `collection_window` | text | No | - | label; length up to 40 |
| `recipient_type` | text | No | - | `self`, `other` |
| `recipient_name` | text | Yes | - | length up to 120; required when `other` |
| `terms_accepted_at` | timestamptz | No | - | set by server |
| `responsible_supply_ack_at` | timestamptz | No | - | set by server |
| `dispenser_quantity` | integer | No | - | 1-50 |
| `product_subtotal_cents` | integer | No | - | `>= 0` |
| `delivery_fee_cents` | integer | No | - | `>= 0` |
| `bond_total_cents` | integer | No | - | `>= 0` |
| `addon_total_cents` | integer | No | 0 | `>= 0`; always 0 at launch |
| `total_cents` | integer | No | - | `= subtotal + delivery + bond + addons` |
| `currency` | text | No | `'aud'` | must be `aud` |
| `status` | `order_status` enum | No | `'pending_payment'` | see section 4 |
| `hold_expires_at` | timestamptz | Yes | - | required when `pending_payment` |
| `payment_session_id` | text | Yes | - | unique; renamed from a Stripe column |
| `payment_reference` | text | Yes | - | unique; renamed from a Stripe column |
| `payment_provider` | text | Yes | - | length up to 40 |
| `created_at` | timestamptz | No | `now()` | |
| `updated_at` | timestamptz | No | `now()` | updated by trigger |
| `paid_at` | timestamptz | Yes | - | set by trigger |
| `business_notification_sent_at` | timestamptz | Yes | - | |
| `customer_confirmation_sent_at` | timestamptz | Yes | - | |

### 3.10 `order_items` (0 rows)

Primary key: `id`. Unique: `(order_id, flavour_id)`, so one row per flavour. Foreign keys: `order_id` to `orders` (ON DELETE CASCADE), `flavour_id` to `catalog_flavours`.

| Column | Type | Null | Default | Check |
|---|---|---|---|---|
| `id` | uuid | No | `gen_random_uuid()` | |
| `order_id` | uuid | No | - | |
| `flavour_id` | text | No | - | |
| `flavour_name_snapshot` | text | No | - | |
| `quantity` | integer | No | - | 1-50 |
| `unit_price_cents` | integer | No | - | `>= 0` |
| `created_at` | timestamptz | No | `now()` | |

### 3.11 `order_addons` (0 rows, dormant)

Primary key: `id`. Unique: `(order_id, addon_id)`. Foreign keys: `order_id` to `orders` (ON DELETE CASCADE), `addon_id` to `catalog_addons`.

| Column | Type | Null | Default | Check |
|---|---|---|---|---|
| `id` | uuid | No | `gen_random_uuid()` | |
| `order_id` | uuid | No | - | |
| `addon_id` | text | No | - | |
| `addon_name_snapshot` | text | No | - | |
| `quantity` | integer | No | - | 1-100 |
| `unit_price_cents` | integer | No | - | `>= 0` |
| `created_at` | timestamptz | No | `now()` | |

### 3.12 `order_notifications` (0 rows)

The email send log. Composite primary key: `(order_id, kind)`. Index: `order_notifications_status_idx`. Foreign key: `order_id` to `orders` (ON DELETE CASCADE).

| Column | Type | Null | Default | Check |
|---|---|---|---|---|
| `order_id` | uuid | No | - | |
| `kind` | text | No | - | `business`, `customer` |
| `status` | text | No | - | `sending`, `sent`, `failed`, `provider_not_configured` |
| `attempts` | integer | No | 1 | `>= 1` |
| `last_attempt_at` | timestamptz | No | `now()` | |
| `sent_at` | timestamptz | Yes | - | |
| `provider_message_id` | text | Yes | - | |
| `last_error` | text | Yes | - | length up to 1000 |

## 4. Exact status values

**`orders.status`** (Postgres enum `order_status`):

`pending_payment`, `paid`, `preparing`, `out_for_delivery`, `delivered`, `collected`, `bond_refunded`, `cancelled`, `payment_failed`

There is no `expired` status. An expired hold stays `pending_payment` with a past `hold_expires_at`. The database does not restrict which status can follow which.

| Group | Statuses | Used by |
|---|---|---|
| Holds stock (when hold is unexpired) | `pending_payment` | `check_availability` |
| Holds stock | `paid`, `preparing`, `out_for_delivery`, `delivered` | `check_availability` |
| Frees stock | `collected`, `bond_refunded`, `cancelled`, `payment_failed` | `check_availability` |
| Email eligible | `paid`, `preparing`, `out_for_delivery`, `delivered`, `collected`, `bond_refunded` | `claim_order_notification`, `send-order-notifications` |

**`booking_requests.status`:** `new`, `confirmed`, `cancelled`, `completed`

**`order_notifications.status`:** `sending`, `sent`, `failed`, `provider_not_configured`

## 5. Order flow

### 5.1 What happens today (live checkout)

1. The customer completes four steps in `public/spiritdrop-cart.js`. Browser validation includes postcode zone, 18+ DOB and the two checkboxes.
2. The browser posts to `POST /api/booking-requests`: `items: [{flavour_id, quantity}]` plus event, address, customer and recipient fields. No prices are sent.
3. `app/api/booking-requests/route.ts` validates against `public/spiritdrop-data.js`, which is loaded server-side by `lib/sd-data.ts`:
   - flavour IDs and quantities, 1-50 dispensers in total
   - event date is tomorrow or later, using **the server's timezone**
   - delivery and collection window IDs, converted to labels
   - postcode zone
   - email, phone, DOB format and age 18+
   - `recipient` other than `other` is treated as `self`
   - an invalid `state` silently becomes `NSW`
   - both checkboxes are true
4. The route calculates subtotal, bond, delivery fee and total in dollars.
5. It generates a UUID and inserts into `booking_requests` using the **publishable key** as `anon`.
6. Database checks and the date trigger run.
7. The response is `{ok: true, reference: "SD-" + first 8 UUID characters, total}`.
8. The browser shows "Booking request sent" and clears the cart.

**Not done on this path:** availability check, hold, lock, payment, email, or any row in `orders`.

**Edge cases:**

- An impossible date such as `2027-02-31` passes the route, because JavaScript rolls it over to March. Postgres then rejects it, and the customer sees the generic 500 message.
- The postcode and state are not cross-checked.
- The route has no maximum future date.

### 5.2 What is built but not connected (orders)

Only `scripts/test-backend.mjs` calls this path.

1. A caller posts to Edge Function `create-checkout-session` with the `apikey` header.
2. The function allows POST and OPTIONS, rejects keys that aren't publishable keys for this project (401), and rejects bodies over 20,000 characters (413).
3. It copies only whitelisted fields. Prices, totals, status and timestamps sent by the caller are dropped. Item lines keep only `flavour_id` and `quantity`, and at most 50 lines.
4. It calls `create_pending_order(p)` with the secret key. Everything below runs in one database transaction.
5. **Lock:** `SELECT pending_hold_minutes FROM inventory_config WHERE id FOR UPDATE`.
6. **Validate:** name, email, phone, DOB (18+ in Sydney time), event date (after today in Sydney, within 730 days), window IDs, street, suburb, state, recipient, both acknowledgements.
7. **Price:** `quote_order(items, postcode)`, section 6.
8. **Availability:** `check_availability(event_date, quantity)`, section 7. If short, raises `SD409` with `available_quantity` and `requested_quantity`.
9. **Create:** inserts the order (status `pending_payment`, `hold_expires_at = now() + 35 min`) and one `order_items` row per flavour.
10. **Commit**, which releases the lock.
11. The function returns HTTP 200 with `status: "payment_provider_not_configured"`, order number, status, dates, hold expiry, items and cents. It never says a booking is confirmed.

Errors map as follows: `SD400` to HTTP 400, `SD422` to 422, `SD409` to 409, anything else to a generic 500.

### 5.3 Steps that do not exist yet

- **Payment session.** No payment provider code exists.
- **Marking an order paid.** No application code does this. It has only been done by manual SQL in testing.
- **Re-checking the hold at payment time.** A paid order whose hold has expired could overbook. `DEPLOY.md` lists this as a Phase 2 requirement.

## 6. Pricing

| Item | Live checkout (`booking_requests`) | Orders system |
|---|---|---|
| Source | `public/spiritdrop-data.js` | `pricing_config`, `delivery_zones` |
| Calculated in | `app/api/booking-requests/route.ts` | `public.quote_order` |
| Dispenser | $200 | 20000 cents |
| Bond | $50 per dispenser | 5000 cents per dispenser |
| Stored as | numeric(10,2) dollars | integer cents |
| Add-ons | not applicable | `addon_total_cents` always 0 |
| Database re-check | price, bond and total, not the delivery fee | total adds up; unit price comes from config |

**Calculation (both):**

```
subtotal = dispensers × dispenser price
bond     = dispensers × bond
delivery = fee of the zone whose prefixes contain the postcode's first 3 digits
total    = subtotal + delivery + bond
```

- **Quantity:** each dispenser has one flavour. The orders system merges repeated flavour lines. Each line accepts 1-99, and the order total must be 1-50.
- **No discounts.** Delivery is one flat fee per order and does not change with quantity.
- **Rounding:** none is needed. All amounts are whole dollars or integer cents, with no percentages.
- **GST:** not calculated. Prices include any GST applicable by law, per the Terms.
- **Currency:** AUD only, enforced by check constraints.
- **Unsupported postcodes** are rejected with the "outside our standard delivery area" message.
- **Display:** `public/spiritdrop-cart.js` shows estimates from the data file, and the server's figures are authoritative.

**Dormant add-ons:** `catalog_addons`, `order_addons` and `orders.addon_total_cents` exist. `quote_order` always returns 0, `create_pending_order` writes no add-on rows, and the Edge Function drops add-on fields. Nothing is shown on the website.

## 7. Availability, holds and locking

This describes the orders system only. **It does not apply to the live checkout (section 2).**

- **Capacity source:** `inventory_config.active_dispenser_capacity`, the only place it lives. Seeded as a placeholder of 10.
- **Next-day collection affects availability.** A dispenser booked for event date E is out on E and on E+1.
- **Calculation** for a request on date D, in `public.check_availability(date, quantity)`:

```
holding orders  = orders with event_date between D-1 and D+1 that are:
                    status in (paid, preparing, out_for_delivery, delivered), or
                    status = pending_payment AND hold_expires_at > now()
committed(day X) = sum of dispenser_quantity where event_date is X-1 or X
committed        = max(committed(D), committed(D+1))
available_qty    = max(capacity - committed, 0)
available        = available_qty >= requested
```

  It returns `available`, `available_quantity` and `requested_quantity`.
- **Resolution is one calendar day.** A dispenser collected on the morning of day X is not available for an event on day X. Delivery and collection windows are ignored. `collected` releases stock early only if the status is actually set.
- **Holds:** there is no holds table. The hold is the unpaid order itself, with `hold_expires_at`. `pending_hold_minutes` defaults to 35 so that it can outlast a 30-minute hosted checkout session.
- **Expiry:** passive. Availability ignores expired holds immediately. Nothing changes their status, and no scheduled job exists (`pg_cron` is not installed).
- **Overbooking prevention:** `create_pending_order` takes a `FOR UPDATE` row lock on the single `inventory_config` row before anything else. All order creation is therefore serialised. The availability check and insert happen under that lock, in one transaction.
- **Tested:** three simultaneous customers for the last dispenser gave exactly one success and two HTTP 409 responses. The next day was also blocked, and expired holds freed the stock.
- **Advisory locks:** none are used.

## 8. Security: RLS, roles and server-only operations

**Roles in use:**

| Role | Used by | Access |
|---|---|---|
| `anon` | Next.js routes, and anyone holding the publishable key | Section 8.1 |
| `authenticated` | Nobody; there is no login | None |
| `service_role` | Edge Functions via the secret key | Bypasses RLS; executes order functions |
| `postgres` | Dashboard, migrations, the two `private` functions | Full |

### 8.1 RLS policies (6)

| Table | Policy | Action | Role | Rule | In plain English |
|---|---|---|---|---|---|
| `enquiries` | Anyone can submit an enquiry | INSERT | `anon` | `true` | Visitors can add an enquiry but can't see any |
| `newsletter_signups` | Anyone can join the newsletter | INSERT | `anon` | `true` | Visitors can sign up but can't see the list |
| `booking_requests` | Anyone can submit a booking request | INSERT | `anon` | `true` | Visitors can add a request but can't see customer details |
| `catalog_flavours` | Anyone can read active flavours | SELECT | `anon` | `active` | Public menu; retired flavours are hidden |
| `delivery_zones` | Anyone can read active delivery zones | SELECT | `anon` | `active` | Public delivery fees and postcodes |
| `pricing_config` | Anyone can read pricing | SELECT | `anon` | `true` | Public prices |

**RLS on, no policies (deny all to `anon` and `authenticated`):** `orders`, `order_items`, `order_addons`, `order_notifications`, `inventory_config`, `catalog_addons`. These protect customer details, DOBs, addresses, and order and fleet data.

### 8.2 Column-level grants

`anon` may INSERT only these columns, so it can't set `id` (except where listed), `status` or `created_at`:

- `enquiries`: `name, phone, email, event_type, event_date, guests, suburb, message`
- `newsletter_signups`: `email`
- `booking_requests`: all form and money columns plus `id`, but not `status` or `created_at`

`anon` may SELECT `catalog_flavours`, `delivery_zones` and `pricing_config`. It has no rights on `order_number_seq`.

### 8.3 Server-only operations

Executable by `service_role` only: `quote_order`, `check_availability`, `create_pending_order`, `claim_order_notification`, `record_order_notification`, `verify_order_notify_token`.

All other functions have EXECUTE revoked from `public`, `anon` and `authenticated`.

**Tested:** anonymous SELECT, INSERT, UPDATE, DELETE and direct RPC against the private tables and functions were refused with HTTP 401.

## 9. Database functions and triggers

### 9.1 Functions (14)

| Function | Language | Security | Purpose |
|---|---|---|---|
| `public.sydney_today()` | SQL | invoker | Today's date in Sydney |
| `public.parse_iso_date(text)` | plpgsql | invoker | Strict date parse, NULL if invalid |
| `public.window_label(kind, id)` | plpgsql | invoker | `h14` to `2:00 PM – 3:00 PM`; delivery hours 10-20, collection 9-19 |
| `public.quote_order(items, postcode)` | plpgsql | invoker | The orders pricing calculator |
| `public.check_availability(date, qty)` | SQL | invoker | Availability calculation |
| `public.create_pending_order(jsonb)` | plpgsql | invoker | Atomic validate, price, reserve, insert |
| `public.booking_requests_validate_dates()` | plpgsql | invoker | Trigger: 18+ and future event date, using the database's date (UTC) |
| `public.set_updated_at()` | plpgsql | invoker | Trigger: maintains `updated_at` |
| `public.orders_set_paid_at()` | plpgsql | invoker | Trigger: sets `paid_at` when first paid |
| `public.claim_order_notification(order, kind)` | plpgsql | invoker | Atomic once-only claim of an email |
| `public.record_order_notification(...)` | plpgsql | invoker | Records an email outcome |
| `public.verify_order_notify_token(token)` | SQL | **definer** | Compares a token to Vault, returns true or false |
| `private.queue_order_notifications(order)` | plpgsql | **definer** | Sends the HTTP call via pg_net; also the manual retry |
| `private.orders_queue_paid_notifications()` | plpgsql | **definer** | Trigger wrapper for the above |

### 9.2 Triggers (4)

| Trigger | Table | When | Does |
|---|---|---|---|
| `booking_requests_validate_dates` | `booking_requests` | BEFORE INSERT OR UPDATE | Rejects under-18 and non-future event dates |
| `orders_set_updated_at` | `orders` | BEFORE UPDATE | Sets `updated_at` |
| `orders_set_paid_at` | `orders` | BEFORE INSERT OR UPDATE OF `status` | Sets `paid_at` if paid and empty |
| `orders_queue_paid_notifications` | `orders` | AFTER UPDATE OF `status`, when changing into `paid` | Queues the notification call |

An order *inserted* as `paid` would not trigger the notification, because the trigger covers updates only.

## 10. Edge Functions

Neither function contacts a payment provider. Both are deployed with `verify_jwt = false`.

### 10.1 `create-checkout-session` (version 2)

| Aspect | Detail |
|---|---|
| Purpose | Prepare a `pending_payment` order, then stop before payment |
| Input | POST JSON: `customer_name, customer_email, customer_phone, customer_dob, delivery_street, delivery_unit, delivery_suburb, delivery_state, delivery_postcode, delivery_instructions, event_notes, event_date, delivery_window, collection_window, recipient_type, recipient_name, terms_accepted, responsible_supply_ack, items[{flavour_id, quantity}]`; `apikey` header |
| Output | 200 with `status: "payment_provider_not_configured"`, order number, status, dates, hold expiry, currency, items, quantity, all cents. Errors: 400, 401, 405, 409 (with availability), 413, 422, 500 |
| Secrets and env | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS` (fallback `SUPABASE_SERVICE_ROLE_KEY`), optional `ALLOWED_ORIGINS` |
| Tables | Through `create_pending_order`: reads `inventory_config`, `pricing_config`, `delivery_zones`, `catalog_flavours`, `orders`; writes `orders`, `order_items` |
| External services | None |
| CORS | Defaults to localhost origins only. `spiritdrop.com.au` is not allowed unless `ALLOWED_ORIGINS` was set |
| Called by | Only `scripts/test-backend.mjs` |

### 10.2 `send-order-notifications` (version 1)

| Aspect | Detail |
|---|---|
| Purpose | Send the business and customer emails for a paid order, at most once each |
| Input | POST `{order_id, dry_run?}`; `x-notify-token` header |
| Output | `{order_number, status, results: {business, customer}}`. Results: `sent`, `failed`, `email_provider_not_configured`, `already_sent_or_in_progress`, `error`. Errors: 400, 401, 404, 405, 409 (not paid), 500. `dry_run` returns rendered text without sending |
| Secrets and env | `SUPABASE_URL`, `SUPABASE_SECRET_KEYS` (fallback `SUPABASE_SERVICE_ROLE_KEY`), `RESEND_API_KEY`, `EMAIL_FROM` |
| Vault secrets | `order_notify_token`, `order_notify_url`, read by database functions |
| Tables | Reads `orders` (never selects `customer_dob`), `order_items`; writes `order_notifications`, and `orders` notification timestamps through `record_order_notification` |
| External services | Resend (`https://api.resend.com/emails`), only when both email secrets exist |
| Called by | The paid-order trigger, or manual retry |

No Edge Function handles enquiries or availability checks for the website.

## 11. Email notifications

**Flow:**

1. `orders.status` changes into `paid`.
2. The trigger calls `private.queue_order_notifications`, which queues an async pg_net request. It is sent after commit.
3. The function verifies the token, reloads the order and confirms it is paid or later.
4. For each email: claim, send, record.

| Email | To | Subject | Content |
|---|---|---|---|
| Business | spiritdropjd@gmail.com | `NEW SPIRITDROP ORDER — {order_number}` | Order number, payment status, customer name, email, phone, event date, suburb and postcode, delivery window, next-day collection, flavours and quantities, dispenser count, subtotal, delivery fee, bond, total paid |
| Customer | `orders.customer_email` | `Your drop is locked in — {order_number}` | Order number, event date, flavours and quantities, dispenser count, delivery and collection windows, full delivery address, subtotal, delivery fee, bond, total paid, 18+ ID reminder. Reply-to: spiritdropjd@gmail.com |

Neither includes date of birth or payment details.

**State fields:** `orders.business_notification_sent_at`, `orders.customer_confirmation_sent_at`, and the whole `order_notifications` table.

**Duplicate prevention, in layers:**

1. The trigger fires only on the change into `paid`, not on a repeated `paid` write.
2. `claim_order_notification` uses an atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE` that succeeds only when no row exists, or when the row is `failed`, `provider_not_configured`, or `sending` for over 10 minutes.
3. Resend `Idempotency-Key`: `{order_id}-{kind}`.

**Failure handling:**

- A send failure sets the row to `failed` with `last_error`. The order stays paid.
- Without both email secrets, nothing is sent and the row is `provider_not_configured`.
- Retry is manual: `select private.queue_order_notifications('<order id>')`.

**Gaps to fix in the rebuild:**

- No automatic retry exists.
- If the trigger's HTTP call never reaches the function, no row is created, so the loss is invisible.
- The function ignores errors from `record_order_notification`. A sent email whose record fails could be re-sent once the 10-minute window passes.
- `verify_order_notify_token` uses plain equality rather than a constant-time comparison.

## 12. Enquiry and newsletter flows

| Form | Frontend | Browser call | Server | Supabase operation | Table | Security |
|---|---|---|---|---|---|---|
| Event enquiry | `/contact` and `/` (`#enquiry-form`) | `POST /api/enquiries` | `app/api/enquiries/route.ts` | `.from("enquiries").insert(row)` as `anon` | `enquiries` | Insert-only policy, column grants, check constraints |
| Drop List | `/` and `/shop` (`#news-form`) | `POST /api/newsletter` | `app/api/newsletter/route.ts` | `.from("newsletter_signups").insert({email})` as `anon` | `newsletter_signups` | Same, plus unique lowercase email |

**Enquiry validation:** name, phone and email required; phone and email format; date format only, so past dates are accepted; length limits. Field mapping: `type` to `event_type`, `date` to `event_date`.

**Newsletter behaviour:** email is lowercased. A duplicate (Postgres error `23505`) returns success on purpose, so the form doesn't reveal who has signed up.

**Neither form:** sends an email, has rate limiting, or has spam protection.

**Other Supabase uses:** `lib/supabase.ts` (client), `.env.production` and `.env.example` (URL and publishable key), `scripts/check-catalog.mjs` and `scripts/test-backend.mjs` (REST and function calls), `content/legal.html` (Privacy Policy), `package.json` (`@supabase/supabase-js`), `tsconfig.json` (excludes `supabase/`).

## 13. What will not translate directly

MariaDB and MySQL differ, so these proposals avoid features that exist in only one. Confirm the server version first.

| Postgres or Supabase feature | Where used | MariaDB / Node replacement |
|---|---|---|
| `uuid`, `gen_random_uuid()` | `orders`, items, requests | `CHAR(36)` with `crypto.randomUUID()` in Node |
| `bigint GENERATED ALWAYS AS IDENTITY` | `enquiries`, `newsletter_signups` | `BIGINT UNSIGNED AUTO_INCREMENT` |
| `text` with length checks | Most columns | `VARCHAR(n)`; `TEXT` for `message` and notes |
| `timestamptz` | All timestamps | `DATETIME(6)` stored as UTC, session `time_zone = '+00:00'` |
| `date` | Event dates, DOB | `DATE`. Configure mysql2 `dateStrings` for dates, or timezone conversion can shift them by a day |
| `numeric(10,2)` | `booking_requests` | `DECIMAL(10,2)`, or cents if the two flows merge |
| `boolean` | Flags, singleton keys | `TINYINT(1)` |
| Boolean singleton primary key | Both config tables | `TINYINT PRIMARY KEY` with `CHECK (id = 1)` |
| `text[]` | `flavours`, `postcode_prefixes` | Child tables (`delivery_zone_prefixes`, and `order_items`-style rows) |
| `order_status` enum | `orders.status` | `ENUM(...)` with the same 9 values |
| Stored generated column | `collection_date` | `DATE GENERATED ALWAYS AS (event_date + INTERVAL 1 DAY) STORED` |
| `order_number_seq`, `nextval` default | `order_number` | Counter table incremented in the order transaction, with `SD-` formatted in Node |
| Unique index on `lower(email)` | `newsletter_signups` | Lowercase in Node, plain `UNIQUE` under a case-insensitive collation |
| Case-sensitive comparison | IDs, statuses | Default collations are case-insensitive, so `SD-07` would match `sd-07`. Validate exactly in Node and use `ascii_bin` for ID columns |
| `~` regex in checks | Postcode, flavour ID | `REGEXP` in `CHECK`, plus Node validation |
| Check constraints | Throughout | Supported, but verify they are enforced on this version |
| Checks and triggers using today's date | 18+, future event | Node validation, using Sydney time (`Intl` with `Australia/Sydney`) |
| plpgsql functions, custom SQLSTATEs (`SD400`, `SD409`, `SD422`) | Order logic | Node service modules and typed errors mapped to the same HTTP codes |
| `jsonb` parameters | `quote_order`, `create_pending_order` | Normal JS objects, validated in Node |
| `INSERT ... ON CONFLICT DO UPDATE ... WHERE` | Email claim | `INSERT IGNORE` then conditional `UPDATE`, checking `affectedRows` |
| `RETURNING` | Claim, order insert | Generate IDs in Node, then re-select in the transaction if needed |
| Postgres error `23505` | Newsletter | `ER_DUP_ENTRY` (1062) |
| Row Level Security | All tables | API-level security. No browser reaches the database |
| `anon`, `authenticated`, `service_role`, column grants | Access control | One least-privilege app user, with route handlers as the boundary |
| Publishable key access | Next routes | API routes on `api.spiritdrop.com.au` |
| Edge Functions (Deno) | Both functions | Express routes and modules |
| Vault | Notification token | Hostinger environment variables |
| Triggers for `updated_at` | `orders` | `ON UPDATE CURRENT_TIMESTAMP(6)` |
| Trigger for `paid_at` | `orders` | Set in the "mark paid" transaction |
| pg_net after-commit HTTP call | Notifications | Outbox rows in the same transaction, sent after commit (section 15) |
| `FOR UPDATE` row lock | Order creation | Same syntax in InnoDB, with the cautions below |

**Transaction differences:**

- **Isolation.** Postgres defaults to READ COMMITTED; InnoDB defaults to REPEATABLE READ. Under REPEATABLE READ, a plain SELECT can see an older snapshot. Run order transactions with READ COMMITTED, or take the lock as the very first statement.
- **Round trips.** The Postgres function runs inside the database. In Node, each statement is a separate round trip, so the lock is held longer. Never call a payment or email provider inside the transaction.
- **Connection use.** The pool is limited to 5 connections and serialised checkouts each hold one. Set a short `innodb_lock_wait_timeout` per session, and retry on deadlock (1213) and lock timeout (1205).
- **Strict mode.** Without strict `sql_mode`, MariaDB can silently truncate data. Set it on every connection.

## 14. Migration blueprint

| Supabase component | Becomes | Notes |
|---|---|---|
| `enquiries` | MariaDB table | Migrate the real row |
| `newsletter_signups` | MariaDB table + unique constraint | |
| `booking_requests` | **Decision needed** (section 16) | Keep as a table, or fold into `orders` |
| `catalog_flavours` | MariaDB table | Seed 12 rows; IDs unchanged |
| `delivery_zones` | MariaDB table + prefix child table | Seed 4 zones |
| `pricing_config` | MariaDB table | Seed values |
| `inventory_config` | MariaDB table | Set the real capacity |
| `catalog_addons`, `order_addons` | MariaDB tables | Keep dormant |
| `orders` | MariaDB table + indexes + constraints | Same 9 statuses |
| `order_items` | MariaDB table + unique constraint | |
| `order_notifications` | MariaDB table | Add a `pending` state for the outbox |
| `order_number_seq` | MariaDB counter table | Updated in the order transaction |
| Length, format, money and status checks | MariaDB constraints + Node API validation | Keep both layers |
| `sydney_today`, `parse_iso_date`, `window_label` | Node API validation | Shared helpers |
| `quote_order` | Node module, called from API | One implementation for all flows |
| `check_availability` | Node + SQL query | Same formula; add a public availability route if wanted |
| `create_pending_order` | Node.js transaction | Same order: lock, validate, price, check, insert |
| `booking_requests_validate_dates` | Node API validation | Use Sydney time, not UTC |
| `set_updated_at` | MariaDB column definition | |
| `orders_set_paid_at` | Node.js transaction | Part of "mark paid" |
| Paid-order trigger, pg_net, Vault | Node.js transaction + outbox rows | |
| `claim_`, `record_order_notification` | Node.js + atomic SQL | Check every result |
| `verify_order_notify_token` | Removed | Retry endpoint needs admin or cron authentication, compared in constant time |
| `create-checkout-session` | Node API route | `POST /orders` or similar |
| `send-order-notifications` | Node module + email provider integration | Resend, or another provider |
| Failed email retry | Hostinger cron job + Node job | Also catches anything left `pending` |
| Expired holds | Passive in the query; optional Hostinger cron | Cron only tidies status |
| Payment webhook | Node API route (future) | Verify signature; conditional update so repeats are harmless |
| RLS: insert-only forms | Node API validation + rate limiting | No browser database access |
| RLS: public catalog | Public Node API route | `GET /catalog` |
| RLS: deny all on orders | Admin-only API operations | Requires authentication |
| Reading and changing order status | Admin-only API operation | Add allowed-transition rules, which don't exist today |
| Capacity and price changes | Admin-only API operation | Audit log recommended |
| `app/api/*` routes | Thin proxies or removed | Section 15 |
| `public/spiritdrop-data.js` | Stays for display; later fed from `GET /catalog` | Removes the drift risk |
| `scripts/test-backend.mjs` | Ported to the new API | Keep all 42 checks |
| `scripts/check-catalog.mjs` | Ported, or retired with `GET /catalog` | |
| Privacy Policy (`content/legal.html`) | Content update before go-live | Name Hostinger and its data location |
| `.env.production`, `@supabase/supabase-js` | Removed after cutover | Last step |

## 15. Proposed design notes

**Checkout transaction:**

1. Validate input before opening a transaction.
2. Begin the transaction.
3. `SELECT ... FROM inventory_config WHERE id = 1 FOR UPDATE`.
4. Read pricing and zones, and calculate.
5. Run the availability query.
6. Take the next order number from the counter.
7. Insert the order and items.
8. Commit, then call the payment provider outside the transaction.

**Mark-paid with outbox:**

1. Begin the transaction.
2. `UPDATE orders SET status = 'paid', paid_at = ... WHERE id = ? AND status = 'pending_payment'`.
3. If `affectedRows = 1`, insert two `pending` rows in `order_notifications`. If 0, it is a repeat webhook, so do nothing.
4. Commit, then attempt sending.
5. A Hostinger cron job retries `pending`, `failed` and stale `sending` rows.

This closes the "lost notification" gap, because the outbox rows commit together with the payment.

**Website connection:** keep `/api/*` in Next.js as thin server-side proxies to `api.spiritdrop.com.au`. The browser code then barely changes, API CORS stays closed for the public site, and the switch is reversible. The admin portal needs its own authenticated access and a CORS rule for `admin.spiritdrop.com.au` only.

**Time:** store UTC. Calculate "today" and age in `Australia/Sydney` in Node, so that the server's timezone doesn't matter. This also fixes the timezone inconsistency in the live route and the trigger.

**Hostinger limits to confirm:** cron availability on the plan, whether the Node app can run more than one instance, and restart behaviour. Don't rely on in-process timers.

## 16. Decisions needed before building

1. **What should checkout do at launch?** Carry on with no-payment booking requests, or move to `orders` with availability and holds? This decides whether `booking_requests` survives. Without payment, a hold expires after 35 minutes and frees the stock, so the hold design only fully works with a payment provider. A no-payment launch needs a different rule, such as requests holding stock until staff confirm or decline them.
2. **Should live bookings and enquiries send email?** They don't today, and someone must otherwise check the admin portal.
3. **What is the real fleet size?**
4. **Which payment provider?**
5. **Which email provider and sending domain?** Resend needs a verified domain.
6. **Where is Hostinger's database hosted?** The Privacy Policy depends on it.
7. **What are the allowed order status transitions?** The current database allows any.

## 17. Behaviour to preserve

The new API should pass the equivalent of all of these:

- Anonymous access to orders, customers, enquiries and capacity is refused.
- Browser-sent prices, bond, delivery fee, totals, status, `paid_at` and add-ons are ignored.
- Unknown flavour IDs and flavour names sent in place of IDs are rejected.
- Rejected: fractional or zero quantity, over 50 dispensers, under 18, missing DOB, same-day or past events, event dates more than 730 days ahead.
- Rejected: unsupported or invalid postcodes, missing street or phone, bad email, unnamed other recipient, invalid recipient type, invalid windows, unaccepted terms or acknowledgement (must be strictly `true`).
- Over-capacity requests return `available_quantity` and `requested_quantity`.
- The next day is blocked by an existing booking; expired holds free stock.
- Three simultaneous customers for the last dispenser: exactly one succeeds.
- `pending_payment` sends no email; a transition to `paid` makes both emails eligible.
- Repeated paid webhooks send no duplicates; provider failure leaves the order paid and logs the error.
- Emails never contain DOB.
- `addon_total_cents` is always 0.
- A duplicate newsletter sign-up returns success.
- Error responses never expose database details.

## 18. Suggested order of work

1. Confirm the MariaDB version and answer the section 16 decisions.
2. Create tables and seed the catalog on Hostinger.
3. Build pricing, availability and validation modules, and port the tests.
4. Build the order, enquiry and newsletter routes, and run the race test against Hostinger.
5. Build email with the outbox and cron retry.
6. Build the admin API with authentication, then the admin portal.
7. Update the Privacy Policy.
8. Copy Supabase data across (currently 1 enquiry) and switch the website routes.
9. Monitor, keep Supabase available for rollback, and only then remove Supabase code.
