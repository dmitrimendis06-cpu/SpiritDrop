# SpiritDrop MariaDB Schema Design

Branch: `admin-portal-v1`. Migrations: `backend/migrations/`. Background: `backend/docs/supabase-migration-audit.md`.

**Status: tested on local MariaDB 11.8.9 and 10.11.19, not yet run on Hostinger.** Nothing has been executed on Hostinger or Supabase (section 16).

## 1. Architecture

```
public website  ─┐
                 ├─> Node API (api.spiritdrop.com.au) ─> MariaDB
admin portal    ─┘
```

Browsers never connect to MariaDB, and credentials stay on the server. With no Row Level Security, the API is the only security boundary: it validates every request, calculates every price and authorises every admin action.

Business logic lives in Node transactions, not in triggers or stored procedures. Shared hosting often restricts those features, and logic in Node is easier to test and review. The database still enforces whatever a `CHECK`, `UNIQUE` or foreign key can express, as a second layer.

## 2. Tables (12)

| Table | Purpose |
|---|---|
| `schema_migrations` | Records which migration files have been applied |
| `app_config` | Single row: capacity, prices, hold, windows, business email |
| `order_reference_counter` | Single row: the sequence behind `SD-000001` |
| `flavours` | The 12 flavours, with `is_active` |
| `delivery_zones` | The 4 zones and their fees |
| `delivery_zone_prefixes` | Postcode prefix to zone |
| `orders` | One row per booking |
| `order_items` | Flavour lines with name and price snapshots |
| `order_status_history` | Append-only audit trail of status changes |
| `notification_outbox` | Durable email queue |
| `enquiries` | Event enquiry form |
| `newsletter_subscriptions` | Drop List sign-ups |

## 3. Relationships

```
delivery_zones 1─< delivery_zone_prefixes
delivery_zones 1─< orders
orders         1─< order_items >─1 flavours
orders         1─< order_status_history
orders         1─< notification_outbox
```

**Every foreign key is `ON DELETE RESTRICT ON UPDATE RESTRICT`.** Financial history can't disappear through a cascade. To retire a flavour or zone, set `is_active = 0`; a row referenced by an order can't be deleted.

## 4. Status model

Orders use three separate columns. A single status can't describe a booking that is delivered, partly refunded and has its bond outstanding, all at once. Supabase's single column needed `bond_refunded` and `payment_failed` as lifecycle values, and this separation replaces both.

### 4.1 `orders.status`: where the booking is

| Value | Meaning | Holds stock? |
|---|---|---|
| `pending_payment` | Awaiting payment | Only while `hold_expires_at` is in the future |
| `paid` | Paid and confirmed, not yet being prepared | Yes |
| `preparing` | Being prepared | Yes |
| `out_for_delivery` | On the way | Yes |
| `delivered` | At the event | Yes |
| `collected` | Equipment returned | No |
| `cancelled` | Cancelled | No |
| `expired` | Hold ran out unpaid | No |

Intended transitions, enforced by the API with conditional updates:

```
pending_payment -> paid | cancelled | expired
paid            -> preparing | cancelled
preparing       -> out_for_delivery | cancelled
out_for_delivery -> delivered
delivered       -> collected
```

### 4.2 `orders.payment_status`: what happened to the money

| Value | Meaning |
|---|---|
| `unpaid` | Nothing received |
| `paid` | Received |
| `failed` | An attempt failed; the customer can retry while the hold lasts |
| `refunded` | Refunded in full |
| `partially_refunded` | Part refunded, other than the normal bond return |

**Decision: a normal bond return changes `bond_status` only.** Otherwise every completed booking would end up `partially_refunded`, hiding the unusual cases. `payment_refunded_cents` tracks non-bond refunds. In a full cancellation refund, the bond portion goes in `bond_refunded_cents` and the rest in `payment_refunded_cents`.

### 4.3 `orders.bond_status`: the refundable equipment bond

| Value | Meaning | Amount rules |
|---|---|---|
| `not_held` | Not paid yet, or never paid | Refunded and retained are 0 |
| `held` | Held during the booking | Refunded and retained are 0 |
| `refund_ready` | Collected without issue, refund due | Refunded and retained are 0 |
| `refunded` | Returned in full | Refunded = bond total, retained = 0 |
| `partially_retained` | Some or all kept for damage, per the Terms | Retained > 0, refunded + retained = bond total |

`partially_retained` also covers keeping the whole bond (refunded = 0). `bond_resolved_at` is required once resolved. No refund code exists yet.

### 4.4 Rules the database enforces across statuses

- `pending_payment` must have a hold and be `unpaid` or `failed`.
- `paid_at` is set exactly when `payment_status` is `paid`, `refunded` or `partially_refunded`.
- `paid`, `preparing`, `out_for_delivery`, `delivered` and `collected` require `paid_at`.
- A bond can't be held unless the order has been paid.
- Refunds can't exceed the order total; bond amounts can't exceed the bond.

Which status may follow which can't be expressed in a `CHECK`, so the API enforces it. Every change adds a row to `order_status_history` in the same transaction.

## 5. Payment model

Provider-neutral. No processor name appears anywhere in the schema.

| Column | Purpose |
|---|---|
| `payment_status` | Section 4.2 |
| `payment_provider` | Free-text name, set when a provider is chosen |
| `payment_session_id` | The provider's checkout session |
| `payment_reference` | The provider's payment ID |
| `payment_refunded_cents` | Non-bond refunds |
| `paid_at` | Server time when first paid |

The provider and reference are unique as a pair, so the same payment can't be attached to two orders. No card numbers, CVV, expiry dates or credentials are stored.

**Without a payment provider, no order can reach `paid`.** Checkout on this schema can't complete a booking until a provider is connected, and unpaid holds simply expire after 35 minutes. The current `booking_requests` flow stays on Supabase until then.

## 6. Pricing model

All money is `INT` cents in AUD. There is no `FLOAT` or `DECIMAL`, and `CHECK` constraints reject negatives.

| Value | Source | Launch value |
|---|---|---|
| Dispenser | `app_config.dispenser_unit_price_cents` | 20000 ($200) |
| Bond per dispenser | `app_config.bond_per_dispenser_cents` | 5000 ($50) |
| Delivery | Zone fee, by the postcode's first 3 digits | 0, 1900, 2900, 3900 |
| Add-ons | Not in the schema | None |

```
product_subtotal = dispenser_quantity × unit price
bond_total       = dispenser_quantity × bond
total            = product_subtotal + delivery_fee + bond_total
```

- The API calculates these. Figures from the browser are ignored.
- `chk_orders_total` and `chk_order_items_line_total` enforce the arithmetic.
- That `product_subtotal_cents` equals the sum of item lines spans rows, so the API enforces it.
- Prices are copied onto each order, so changing `app_config` never alters past orders.
- `delivery_zone_prefixes` has the prefix as its primary key, so a postcode can never match two zones.

**Add-ons were left out on purpose.** Add-ons are disabled at launch and the old tables have no data. When add-ons return, a new migration can add the tables and an `addon_total_cents` column.

## 7. Availability and locking

### 7.1 Rule

A dispenser booked for event date E is out on E and on E+1. A request for date D therefore needs stock on both D and D+1.

```
committed(day X) = quantity of counting orders with event_date in (X-1, X)
available        = capacity - max(committed(D), committed(D+1))
```

**Counting orders:** `paid`, `preparing`, `out_for_delivery`, `delivered`, plus `pending_payment` with `hold_expires_at` in the future. `collected`, `cancelled` and `expired` don't count.

`collected` not counting can't release stock early in practice. Collection happens on or after E+1, and a new booking can only be made for tomorrow or later, so its dates no longer overlap.

### 7.2 Query

```sql
SELECT
  COALESCE(SUM(CASE WHEN event_date IN (DATE_SUB(:d, INTERVAL 1 DAY), :d) THEN dispenser_quantity END), 0) AS committed_day,
  COALESCE(SUM(CASE WHEN event_date IN (:d, DATE_ADD(:d, INTERVAL 1 DAY)) THEN dispenser_quantity END), 0) AS committed_next_day
FROM orders
WHERE event_date BETWEEN DATE_SUB(:d, INTERVAL 1 DAY) AND DATE_ADD(:d, INTERVAL 1 DAY)
  AND (status IN ('paid', 'preparing', 'out_for_delivery', 'delivered')
       OR (status = 'pending_payment' AND hold_expires_at > UTC_TIMESTAMP(6)));
```

Served by `idx_orders_event_status`.

### 7.3 Quantity limit

There is no fixed maximum such as 50. A requested quantity must be at least 1 and no more than `available`, checked inside the transaction below, so it can never exceed the configured fleet. The schema enforces only `>= 1`, because a `CHECK` can't read `app_config`. **The API is therefore the only upper limit, and the database won't catch a bug there.**

### 7.4 Where `SELECT ... FOR UPDATE` is used

The `app_config` row is the one lock for stock decisions. Anything that could *reduce* available stock takes it first.

| Operation | Lock | Why |
|---|---|---|
| Create order (checkout) | `SELECT id FROM app_config WHERE id = 1 FOR UPDATE` | Serialises check-then-insert |
| Mark paid when the hold has expired | Same lock, then re-check availability | The stock may have been taken in the meantime |
| Admin lowers capacity, or changes an order's date or quantity | Same lock | These reduce stock |
| Payment webhook | `SELECT ... FROM orders WHERE id = ? FOR UPDATE` | Applies repeated webhooks one at a time |
| Expire holds, mark `collected`, cancel | No stock lock | These only free stock |

**Lock order:** always `app_config`, then the order, then `order_reference_counter`. A consistent order prevents deadlocks.

### 7.5 Checkout transaction (future)

```
validate input (no transaction yet)
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED
BEGIN
  SELECT ... FROM app_config WHERE id = 1 FOR UPDATE   -- capacity, prices, hold
  read zone and flavours; calculate money
  run the availability query; if quantity > available: ROLLBACK, return 409
  UPDATE order_reference_counter ... LAST_INSERT_ID(last_number + 1)
  SELECT LAST_INSERT_ID()
  INSERT orders, order_items, order_status_history
COMMIT
then, outside the transaction: create the payment session
```

Transaction rules:

- **READ COMMITTED**, so the availability query sees everything committed before the lock was granted.
- **Never call a payment or email provider inside the transaction.** It would hold the lock, and one of the 5 pooled connections, while waiting on the network.
- Set a short `innodb_lock_wait_timeout` per session, and retry on deadlock (1213) and lock timeout (1205).

### 7.6 Hold expiry

Holds expire passively: the availability query ignores them the moment `hold_expires_at` passes. A cron job later sets `status = 'expired'` for tidiness and admin reporting, but availability never depends on it. `hold_duration_minutes` is 35.

**Late payments:** if a provider reports payment after a hold has expired, the API takes the stock lock and re-checks. If the stock has gone, the order must be cancelled and refunded rather than overbooked. This needs a written process when the provider is chosen.

## 8. Order reference

Format `SD-000001`, stored in `order_reference` with a unique key and a format check. It never uses `COUNT(*) + 1`.

```sql
UPDATE order_reference_counter SET last_number = LAST_INSERT_ID(last_number + 1) WHERE id = 1;
SELECT LAST_INSERT_ID();
```

`LAST_INSERT_ID()` is per connection, and the row lock is held until commit. Two checkouts can't receive the same number, and a rolled-back order returns its number, so normally there are no gaps. References are for people to read and aren't a security boundary.

## 9. Identifiers

| Table | Key | Why |
|---|---|---|
| `orders` | UUID in `CHAR(36) ascii_bin`, generated by Node's `crypto.randomUUID()` | Safe to share with payment providers and in return URLs because it can't be guessed. There is no database default, so a missing ID fails loudly. Works on MariaDB and MySQL, unlike MariaDB's `UUID` type |
| `order_items`, history, outbox, enquiries, newsletter | `BIGINT UNSIGNED AUTO_INCREMENT` | Internal, and small |
| `flavours`, `delivery_zones` | Existing short codes (`sd-01`, `z1`) | Matches the website data |
| Config and counter | `TINYINT` with `CHECK (id = 1)` | Guarantees a single row |

Random UUID keys cost InnoDB some insert efficiency, which doesn't matter at SpiritDrop's order volumes.

**Collations.** `ascii_bin` on IDs, references and postcodes makes comparisons exact, so `SD-01` doesn't match `sd-01`. Default `utf8mb4_unicode_ci` applies to names and addresses.

## 10. Time

| Data | Type | Convention |
|---|---|---|
| Timestamps | `DATETIME(6)` | UTC |
| Event, collection, birth dates | `DATE` | Calendar dates, in Sydney terms |

`DATETIME` doesn't convert time zones, so `CURRENT_TIMESTAMP(6)` follows the session setting. **Every connection must run `SET time_zone = '+00:00'`.** `createDbPool()` in `backend/src/config/database.js` does this on every new pooled connection, along with strict `sql_mode` and mysql2 options `timezone: 'Z'` and `dateStrings: ['DATE']`, so that dates can't shift by a day. A connection that can't be set up is destroyed rather than used. All database code must go through this pool. Rows inserted by hand in phpMyAdmin depend on that session's setting.

This matters in practice: on a server not set to UTC, without this setup, `next_attempt_at` was stored hours in the future and the email worker couldn't claim the row. The first test run caught exactly that.

**API and UI:**

- The API calculates "today" and age in `Australia/Sydney`, using `Intl`, so the server's zone doesn't matter.
- It sends timestamps to clients as ISO 8601 UTC, and the UI displays them in Sydney time.
- Same-day and age rules can't be `CHECK` constraints, because a `CHECK` can't use the current date. The API enforces them.

## 11. Email outbox

```
payment confirmed
  BEGIN
    UPDATE orders ... WHERE id = ? AND status = 'pending_payment'
    if 1 row changed: INSERT 2 notification_outbox rows + history
    if 0 rows: repeat webhook, change nothing
  COMMIT
cron script (separate, short-lived) sends and retries
```

- **Nothing can be lost.** The email rows commit together with the payment, closing the gap found in the audit. If email is down, the rows wait.
- **Nothing is sent for `pending_payment`.** Rows are only created in the mark-paid transaction.
- **Duplicates are blocked twice.** `idempotency_key` is unique (format `order:<id>:<type>`), and the key is also passed to the email provider.

**Cron script behaviour** (not built; no cron job has been created):

1. Select due rows: `status = 'pending' AND next_attempt_at <= UTC_TIMESTAMP(6)`, served by `idx_notification_outbox_due`.
2. Also reclaim rows stuck in `sending` for over 10 minutes, as today's Supabase code does.
3. Claim each row atomically: `UPDATE ... SET status = 'sending', claimed_at = ..., attempt_count = attempt_count + 1 WHERE id = ? AND status = 'pending' AND next_attempt_at <= ...`. Continue only if 1 row changed.
4. Render the email from the order at send time, never selecting `customer_dob`.
5. On success: `sent`, with `sent_at` and `provider_message_id`.
6. On failure: back to `pending` with a later `next_attempt_at` and `last_error`. After too many attempts: `failed`, for a person to look at. The backoff and attempt limit are worker settings, to be decided when it's built.
7. If no email provider is configured: leave rows `pending`, note it in `last_error`, and never mark them sent.

The script exits when finished, so there is no always-running worker. Whatever the outcome, the order stays `paid`. Supabase's `provider_not_configured` status isn't needed, since `pending` with a note covers it.

The outbox covers orders only. Emailing enquiries would be a later change, because `order_id` is required.

## 12. Enquiries and newsletter

**`enquiries`** keeps every field the current form sends: `name, phone, email, event_type, event_date, guests, suburb, message`, plus `created_at`. There's no status column yet; the admin portal can add one.

**`newsletter_subscriptions`:** the `email` column has an explicit `utf8mb4_unicode_ci` collation and a unique key, so `Name@Example.com` and `name@example.com` conflict. The API should also lowercase and trim, and treat `ER_DUP_ENTRY` as success so the form doesn't reveal who has signed up. Side effects of this collation: accents are ignored, so `josé@` would conflict with `jose@`, which is rare and harmless in email addresses. `unsubscribed_at` supports the unsubscribe promise in the Privacy Policy.

## 13. Configuration seed

`002_seed_launch_config.sql` contains only confirmed values. A static test compares prices, drinks, windows, flavours and zones to `public/spiritdrop-data.js`, so they can't drift unnoticed.

| Setting | Value | Source |
|---|---|---|
| `active_fleet_capacity` | 10 | Launch decision |
| `hold_duration_minutes` | 35 | Launch decision |
| `dispenser_unit_price_cents` | 20000 | Business rules |
| `bond_per_dispenser_cents` | 5000 | Business rules |
| `drinks_per_dispenser` | 20 | Website data |
| `currency` | AUD | Business rules |
| `max_advance_booking_days` | 730 | Existing Supabase rule |
| Delivery windows | Start hours 10-20 | Website data |
| Collection windows | Start hours 9-19 | Website data |
| `business_notification_email` | spiritdropjd@gmail.com | Confirmed business email |
| `order_reference_counter.last_number` | 0 | First order is `SD-000001` |
| Flavours | 12 | Website data and audit |
| Zones | 4 zones, 40 prefixes | Website data and audit |

## 14. Indexes

| Index | Used for |
|---|---|
| `orders` PK | Fetch by internal ID |
| `uq_orders_reference` | Look up by order reference; guarantees uniqueness |
| `uq_orders_payment_session` | Find the order when a provider session returns |
| `uq_orders_payment_reference` | Find the order from a webhook; stops one payment attaching to two orders |
| `idx_orders_event_status` | Availability query; delivery schedule |
| `idx_orders_status_hold` | Finding expired holds; also serves filtering by order status |
| `idx_orders_payment_status` | Admin payment filter |
| `idx_orders_delivery_zone` | Required by the foreign key |
| `uq_order_items_order_flavour` | One line per flavour; loads an order's items |
| `idx_order_items_flavour` | Required by the foreign key |
| `idx_order_status_history_order` | An order's timeline, in order |
| `uq_notification_outbox_idempotency` | Prevents duplicate emails |
| `idx_notification_outbox_due` | The cron script's main query |
| `idx_notification_outbox_order` | Required by the foreign key; an order's emails |
| `idx_enquiries_created` | Newest enquiries first |
| `uq_newsletter_subscriptions_email` | Case-insensitive uniqueness |
| `uq_flavours_slug`, `uq_flavours_name` | No duplicates in the catalogue |
| `idx_delivery_zone_prefixes_zone` | Required by the foreign key |

Customer name and email search, and sorting orders by date created, aren't indexed yet. Add them when the admin portal needs them.

## 15. Differences from Supabase

| Supabase | MariaDB design | Why |
|---|---|---|
| `booking_requests` | **Not recreated** | Orders replace it; it isn't the intended architecture |
| `catalog_addons`, `order_addons`, `addon_total_cents` | **Not recreated** | Add-ons are off; a migration can restore them |
| `pricing_config`, `inventory_config` | Merged into `app_config` | One configuration row |
| One `order_status` with 9 values | Three status columns | Section 4 |
| `bond_refunded`, `payment_failed` statuses | Replaced by `bond_status`, `payment_status` | |
| No `expired` status | `expired` added | Clearer reporting |
| Quantity limited to 1-50 | At least 1, then limited by availability | Launch decision |
| No status history | `order_status_history` | Requested audit trail |
| `order_notifications` (one row per kind) | `notification_outbox` with retry times | Durable retries |
| Trigger plus `pg_net` HTTP call | Outbox rows in the payment transaction | Can't lose notifications |
| No automatic retry | Cron script | |
| `order_number_seq` | Counter row | No sequences on all servers |
| `uuid`, `gen_random_uuid()` | `CHAR(36)` from Node | |
| `text[]` | Child table for prefixes; rows for items | |
| `timestamptz` | `DATETIME(6)` in UTC | |
| `~` regex | `REGEXP` | |
| `lower(email)` unique index | Case-insensitive collation | |
| RLS, grants, `anon`, `service_role` | API-level security | Browsers have no database access |
| Vault | Hostinger environment variables | |
| PL/pgSQL functions, custom error codes | Node modules and typed errors | |
| `paid_at`, `updated_at` triggers | Set in the transaction; `ON UPDATE CURRENT_TIMESTAMP(6)` | |
| `ON DELETE CASCADE` on items, add-ons, notifications | `RESTRICT` everywhere | Protects history |
| Date check using the database's UTC day | API check in Sydney time | Fixes the audit's timezone inconsistency |

## 16. Testing

```bash
npm test
```

| Suite | Status | Coverage |
|---|---|---|
| `test/migrations.static.test.js` | **Runs anywhere; 16 of 16 pass** | No Postgres syntax, no destructive statements, tables, types, statuses, foreign keys, indexes, no add-ons, card data or provider names, seed matches the website, test-database guard |
| `test/database-config.test.js` | **Runs anywhere; 4 of 4 pass** | UTC and strict-mode setup; a connection that fails setup is destroyed |
| `test/schema.integration.test.js` | **40 of 40 pass** on a local MariaDB; skipped without one | Real behaviour, below |

**Database test coverage:**

- **Migrations:** both files apply to an empty database and can't be applied twice.
- **Constraints:** each of the 54 `CHECK` constraints rejects a violating row, and the message must name that constraint. The test fails if a declared constraint has no violation case. All 6 foreign keys are `RESTRICT`.
- **Seed:** all configuration, flavours and zones match the website's data. Every postcode prefix (000-999) gives the same zone and fee as the website's own checker.
- **Concurrency:** six customers and then 15 rounds of 12 customers competing for the last dispenser, bookings on adjacent days, a second checkout blocking on the lock, and 25 simultaneous reference numbers.
- **Rollback:** a checkout failing part-way, a rejected over-capacity checkout, a connection lost mid-transaction, and payment with its email rows.
- **Connections:** UTC and strict mode on each of 5 separate pooled connections; bad data rejected; dates unchanged.

**Environments that passed:** MariaDB 11.8.9 with default settings; MariaDB 11.8.9 with a hostile server configuration (global `time_zone` +10:00 and an empty `sql_mode`), proving nothing relies on server defaults; MariaDB 10.11.19. Each used a clean database.

**The tests can fail.** Deliberately removing the `FOR UPDATE` lock, the connection setup, a `CHECK`, the rollback, a `RESTRICT` and a seed value was each caught.

**Not covered:** the Hostinger server itself, whose exact version isn't confirmed. MySQL was not tested, only MariaDB. The checkout and mark-paid transactions in these tests are stand-ins showing the locking design; the real API routes don't exist yet and need their own tests.

**To run it** on a throwaway local MariaDB (it drops and recreates its database):

```bash
TEST_DB_NAME=spiritdrop_test TEST_DB_USER=<local user> TEST_DB_PASSWORD=<local password> npm test
```

`test/helpers/test-db-guard.js` reads only `TEST_DB_*`, never the production `DB_*` variables. It refuses any host except localhost, any database not ending in `_test`, Hostinger-prefixed names and users, and `NODE_ENV=production`.

## 17. Before running on Hostinger

1. Deploy the connection change in `src/config/database.js` and confirm `/health/db` still passes.
2. Confirm the Hostinger server version. If it isn't 10.11 or 11.8, repeat the database tests locally on the same major version. `CHECK` enforcement needs MariaDB 10.2.1 or newer.
3. Confirm the database user may create tables and foreign keys.
4. Take a backup, even though the database is empty, and run `001` then `002` once.
5. MariaDB can't roll back `CREATE TABLE`. If `001` fails part-way, the tables created so far must be dropped by hand before retrying.
6. Afterwards, restrict the application's database user to what the API needs, if the plan allows it.

## 18. Open items

- **Payment provider:** needed before any order can be paid (section 5).
- **Late payment process:** section 7.6.
- **Email provider and domain:** the outbox waits until configured.
- **Privacy Policy:** still names Supabase in Sydney. Confirm Hostinger's data location and update it before customer data moves.
- **Data to migrate:** 1 real enquiry. Everything else in Supabase is seed or empty.
- **Date of birth retention:** `customer_dob` is stored for compliance, and the Privacy Policy promises it won't be kept longer than necessary. A retention rule needs deciding.
- **Admin users:** designed separately, as agreed.
- **Busy periods:** the pool allows 5 connections and 20 waiting requests, so a burst beyond that gets an error. Checkouts also run one at a time. The real routes should return a friendly "please try again", with rate limiting in front.
