# SpiritDrop — internal deployment notes

Internal only. Not deployed, not linked from the site. Customer-facing policy
text lives in `content/legal.html`; unresolved items live here, never on the
public Legal page.

## Confirmed business details (single source: `public/spiritdrop-data.js` → `SD.COPY`)

- Trading name: SpiritDrop
- Operator: J HASSARATI & D.S MENDIS partnership, ABN 84 187 494 574 (not a company — no ACN)
- NSW packaged liquor licensee: Dmitri Mendis — licence LIQP770018577
- Public email: spiritdropjd@gmail.com (the only public address)
- $200 per dispenser, GST-inclusive where applicable, no automatic quantity discounts
- $50 refundable equipment bond per dispenser
- Cancellation: 24 hours before scheduled delivery

The footer licence/ABN block is repeated in every `content/*.html` footer.
If any detail changes, update all eight files and `SD.COPY`.

## Routing

Clean routes: `/`, `/shop`, `/product?flavour=<slug>`, `/delivery`, `/about`,
`/contact`, `/legal`. Every internal link uses these exact lowercase paths.
Old static URLs (`/Contact.html`, `/Shop.html`, …) 308-redirect via
`next.config.ts`. Do not reintroduce `.html` links.

## Backend: Supabase (project `nafwzirivmdbvdzdkjhq`, Sydney ap-southeast-2)

Forms post to Next.js API routes, which validate, recompute all money from
`public/spiritdrop-data.js` (loaded server-side by `lib/sd-data.ts`), and
insert with the publishable key:

| Form | Route | Table |
|---|---|---|
| Checkout booking request | `/api/booking-requests` | `booking_requests` |
| Event enquiry (Contact + home) | `/api/enquiries` | `enquiries` |
| Drop List sign-up | `/api/newsletter` | `newsletter_signups` |

- Schema lives in `supabase/migrations/`. The `anon` role may only INSERT the
  listed columns: no SELECT, UPDATE or DELETE. Read submissions in the
  Supabase dashboard (Table Editor).
- The database re-checks price ($200), bond ($50), totals, 18+ DOB, next-day
  collection and future event dates. **If prices change, update both
  `SD.RULES` and the `booking_requests` check constraints** (new migration).
- Env vars: `.env` (git-ignored); template in `.env.example`.

## Orders backend (pre-payment-provider)

Checkpoint before this work: git tag `checkpoint/pre-orders-backend`.
Schema: `supabase/migrations/20261023090542_orders_backend.sql`.
Edge Function: `supabase/functions/create-checkout-session/` (`verify_jwt = false`, see `supabase/config.toml`).

**Flow.** Browser → Edge Function `create-checkout-session` (checks the caller's
publishable `apikey`, whitelists fields, drops any browser prices/status) →
`public.create_pending_order(jsonb)` using the server-only secret key → `orders` +
`order_items`. Returns `status: "payment_provider_not_configured"` with the order
number and server-calculated cents. It never confirms a booking or a payment.
The live checkout still uses `/api/booking-requests`; switching it to the Edge
Function is a Phase 2 step (same `items: [{flavour_id, quantity}]` payload).

**Single sources of truth (database).**
- `pricing_config`: $200 = 20000 cents per dispenser, $50 = 5000 cents bond, 20 drinks.
- `delivery_zones`: the current four postcode zones (first-3-digit prefixes), fees in cents.
- `catalog_flavours`: the 12 flavours, ids `sd-01`…`sd-12`. Unknown or inactive ids are rejected.
- `inventory_config.active_dispenser_capacity`: the fleet size. **Currently a
  PLACEHOLDER of 10** — set the real number:
  `update public.inventory_config set active_dispenser_capacity = <n>, updated_at = now();`
- `catalog_addons`: cups, garnishes, ice — inactive, no prices. **Add-ons are not
  offered at launch**: no add-on UI on the site, `orders.addon_total_cents` is
  always 0, and `order_addons` stays empty. The tables are kept so add-ons can
  return later (set prices in `catalog_addons`, then add UI and pricing).
- The website preview still reads `public/spiritdrop-data.js`. Run
  `npm run check:catalog` after changing prices, zones or flavours on either side.

**Pricing.** `public.quote_order(items, postcode)` is the only price calculator.
All money is integer cents; the `orders` table also enforces
`total = subtotal + delivery + bond + add-ons`.

**Availability.** A dispenser for event date E is out on E (delivery) and E+1
(collection), so a request for D competes on days D and D+1:
`available = capacity − max(committed(D), committed(D+1))`, where an order
commits stock if it is `paid`/`preparing`/`out_for_delivery`/`delivered`, or
`pending_payment` with `hold_expires_at` still in the future. `collected`,
`bond_refunded`, `cancelled`, `payment_failed` and expired holds free the stock.

**No double-booking.** `create_pending_order` starts with
`select … from inventory_config … for update`, so concurrent checkouts are
processed one at a time; the availability check and insert happen inside that
lock. Tested: three simultaneous customers for the last dispenser → exactly one
succeeds, two get HTTP 409 with `available_quantity`.

**Pending holds (no ghost bookings).** Each `pending_payment` order gets
`hold_expires_at = now() + pending_hold_minutes` (35 min). Expired holds are
ignored by availability immediately, so an abandoned checkout can't block stock.
In Phase 2, create the payment provider's checkout session with an expiry no
later than `hold_expires_at` (some providers, e.g. Stripe, require ≥ 30 minutes,
hence 35), and have the payment webhook re-check that the hold is still valid before marking an order `paid`. Optionally
add a scheduled job later to mark expired holds `cancelled` (housekeeping only).

**Order numbers.** `SD-000001` from `order_number_seq`, for customers only. The
UUID `id` stays the internal key; never use the order number for access control.

**Access.** anon/authenticated: no access to `orders`, `order_items`,
`order_addons`, `inventory_config`, `catalog_addons`, and no EXECUTE on the order
functions. anon may SELECT the public catalog (flavours, zones, pricing). The
Edge Function uses `SUPABASE_SECRET_KEYS.default`, injected by Supabase and
never sent to the browser.

**Edge Function secrets.** Optional now: `ALLOWED_ORIGINS` (comma-separated
browser origins; defaults to `http://localhost:3000`). Phase 2 will need the
chosen payment provider's secret key and webhook signing secret. Email needs
`RESEND_API_KEY` and `EMAIL_FROM` (see below). None is configured.

**Payment fields are provider-neutral.** `orders.payment_provider`,
`payment_session_id` and `payment_reference` (renamed from the earlier
`stripe_*` columns). No processor is hard-coded; `paid_at` is set by the
database when `status` first becomes `paid`.

**Tests.** `npm run test:backend` (42 checks: anonymous access denied, forged
prices/bond/status ignored, validation, availability, race). It creates test
orders for `test+backend@example.com`. Clean up afterwards:
`delete from public.orders where customer_email = 'test+backend@example.com';`

## Paid-order email notifications

Migration: `supabase/migrations/20261027104349_order_notifications.sql`.
Edge Function: `supabase/functions/send-order-notifications/` (`verify_jwt = false`).

**Flow.** `orders.status` changes to `paid` (only the *transition* into paid;
`pending_payment` never notifies) → trigger `orders_queue_paid_notifications` →
`private.queue_order_notifications(order_id)` queues an async HTTP call via
pg_net (sent after commit) with `x-notify-token` → Edge Function verifies the
token, reloads the order from the database, and sends two emails at most once
each:

- **business** → spiritdropjd@gmail.com, subject `NEW SPIRITDROP ORDER — SD-000123`
- **customer** → the customer, subject `Your drop is locked in — SD-000123`

Neither email contains date of birth or any payment credentials (the function
never selects `customer_dob`). The business email shows suburb/postcode; the
full address stays in Supabase.

**Duplicate prevention.** `order_notifications` has one row per
`(order_id, kind)`. `claim_order_notification()` atomically claims a send and
refuses once a row is `sent` (or another attempt is in flight < 10 min).
Repeated payment webhooks that write `paid` again are not status transitions,
so the trigger doesn't fire; retries/concurrent calls are refused by the claim.
Resend also receives an `Idempotency-Key` of `<order id>-<kind>`.
`orders.business_notification_sent_at` / `customer_confirmation_sent_at` record
successful sends.

**Failure handling.** If the provider errors or is unreachable, the row is
marked `failed` with `last_error`; the order **stays paid** (emails never
change `orders.status`). Retry any time (safe; sent emails are skipped):
`select private.queue_order_notifications('<order uuid>');`
Find stuck ones: `select * from public.order_notifications where status <> 'sent';`

**Enabling email (Resend).** Until both secrets exist nothing is sent; each
notification is recorded as `provider_not_configured` and the function returns
`email_provider_not_configured`. To go live:
1. Create a Resend account, verify the sending domain (e.g. spiritdrop.com.au).
2. Supabase → Edge Functions → Secrets: set `RESEND_API_KEY` and
   `EMAIL_FROM` (e.g. `SpiritDrop <orders@spiritdrop.com.au>`). No redeploy needed.
3. Name Resend (and where it processes data) in the Privacy Policy.
4. Retry any `provider_not_configured` paid orders with the SQL above.

**Secrets.** The trigger→function token is generated inside the database and
stored in Vault (`order_notify_token`; URL in `order_notify_url`). It is never
in source control. Rotate by updating that Vault secret.

**Future private admin page (not built).** Everything it needs is in the
database: `orders` (indexed by `event_date`, `status`), `collection_date`,
`paid_at`, bond via `status = 'bond_refunded'`, `order_notifications`, and
`enquiries` / `booking_requests`. It must use authentication + a server-only
secret key; never expose these tables publicly.

## Internal TODO — genuinely unresolved

1. **Hosting target.** The app now has server API routes (`app/api/*`), so it
   needs a Node runtime (e.g. AWS Amplify Hosting, or a Node server behind
   CloudFront). A pure static export to private S3 can no longer serve the
   forms unless the routes are moved elsewhere (e.g. Supabase Edge Functions).
   Set the server timezone to `Australia/Sydney` (`TZ`) so "tomorrow" and age
   checks use Sydney dates, and set the two Supabase env vars on the host.
2. **Spam / abuse protection.** The form routes are public with no rate
   limiting or CAPTCHA-style check. Add rate limiting (or Turnstile-type
   verification) before launch.
3. **Email provider.** Paid-order notifications are built but dormant until
   `RESEND_API_KEY` + `EMAIL_FROM` are set (see "Paid-order email
   notifications"). Enquiries and booking requests are still not emailed.
4. **UPDATE PRIVACY PROVIDER LIST BEFORE FURTHER BACKEND/ANALYTICS ENABLEMENT.**
   Supabase is now named in the Privacy Policy. Name each further provider
   (hosting, payments, email, address validation, analytics) and where it
   stores data once actually implemented. Marked with an HTML comment in
   `content/legal.html`.
5. **Analytics.** `spiritdrop-ux.js` has GA4/Clarity/Meta IDs set to `null`, so
   no consent banner shows and the Privacy Policy says no analytics run. If
   any ID is set, update the "Cookies and browser storage" section at the same
   time.
6. **Add-ons (removed for launch).** Cocktail cups, dried garnishes and ice bags
   are not offered and not shown. To reintroduce: confirm prices and pack sizes,
   activate rows in `catalog_addons`, extend `quote_order`, and add UI.
7. **Legal page `noindex`** (`app/legal/page.tsx`). Remove when the site
   approaches production launch.
8. **Production domain.** Set `metadataBase`, `og:url`, `og:image`, canonical
   links, and absolute URLs in `public/robots.txt` and `public/sitemap.xml`.
9. **Payments (Phase 2, provider not chosen).** Not implemented: the live
   checkout sends a booking request and says "No payment is taken online".
   Next: extend `create-checkout-session` to create the provider's hosted
   checkout from the server-calculated `orders` row (never browser figures),
   add a signature-verified webhook function that sets `status = 'paid'` and
   `payment_reference` (this fires the order emails), then point the checkout
   at the Edge Function.
10. **Real fleet size.** `inventory_config.active_dispenser_capacity` is a
    placeholder (10). Set the true number before taking real orders.
11. **Admin access.** Staff currently read submissions in the Supabase
    dashboard. A staff-facing page would need authentication plus a
    server-only secret key (never `NEXT_PUBLIC_`).
12. **Allergens.** Only Strawberry Cream is verified (`allergensVerified`);
   confirm the remaining 11 flavours.
