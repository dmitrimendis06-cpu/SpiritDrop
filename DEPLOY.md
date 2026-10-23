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

## Orders backend (pre-Stripe)

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
- `catalog_addons`: cups, garnishes, ice — inactive, no prices.
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
In Phase 2, create the Stripe Checkout Session with `expires_at` no later than
`hold_expires_at` (Stripe requires ≥ 30 minutes, hence 35), and have the webhook
re-check that the hold is still valid before marking an order `paid`. Optionally
add a scheduled job later to mark expired holds `cancelled` (housekeeping only).

**Order numbers.** `SD-000001` from `order_number_seq`, for customers only. The
UUID `id` stays the internal key; never use the order number for access control.

**Access.** anon/authenticated: no access to `orders`, `order_items`,
`order_addons`, `inventory_config`, `catalog_addons`, and no EXECUTE on the order
functions. anon may SELECT the public catalog (flavours, zones, pricing). The
Edge Function uses `SUPABASE_SECRET_KEYS.default`, injected by Supabase and
never sent to the browser.

**Edge Function secrets.** Optional now: `ALLOWED_ORIGINS` (comma-separated
browser origins; defaults to `http://localhost:3000`). Phase 2 will need
`STRIPE_SECRET_KEY` (checkout) and `STRIPE_WEBHOOK_SECRET` (webhook function).
Neither is configured.

**Tests.** `npm run test:backend` (42 checks: anonymous access denied, forged
prices/bond/status ignored, validation, availability, race). It creates test
orders for `test+backend@example.com`. Clean up afterwards:
`delete from public.orders where customer_email = 'test+backend@example.com';`

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
3. **Staff notifications.** Submissions are stored but nobody is emailed.
   Add a notification (e.g. Supabase Database Webhook → email) so new booking
   requests and enquiries reach spiritdropjd@gmail.com.
4. **UPDATE PRIVACY PROVIDER LIST BEFORE FURTHER BACKEND/ANALYTICS ENABLEMENT.**
   Supabase is now named in the Privacy Policy. Name each further provider
   (hosting, payments, email, address validation, analytics) and where it
   stores data once actually implemented. Marked with an HTML comment in
   `content/legal.html`.
5. **Analytics.** `spiritdrop-ux.js` has GA4/Clarity/Meta IDs set to `null`, so
   no consent banner shows and the Privacy Policy says no analytics run. If
   any ID is set, update the "Cookies and browser storage" section at the same
   time.
6. **Add-on prices and pack sizes** (Cocktail Cups, Dried Garnishes, Ice Bags).
   Purchasing controls stay disabled (`pending: true` in `SD.ADDONS`) until
   prices are configured.
7. **Legal page `noindex`** (`app/legal/page.tsx`). Remove when the site
   approaches production launch.
8. **Production domain.** Set `metadataBase`, `og:url`, `og:image`, canonical
   links, and absolute URLs in `public/robots.txt` and `public/sitemap.xml`.
9. **Payments (Phase 2).** Not implemented: the live checkout sends a booking
   request and says "No payment is taken online". Next: extend
   `create-checkout-session` to create a Stripe Checkout Session from the
   server-calculated `orders` row (never browser figures), add a webhook
   function to mark orders `paid`, then point the checkout at the Edge Function.
10. **Real fleet size.** `inventory_config.active_dispenser_capacity` is a
    placeholder (10). Set the true number before taking real orders.
11. **Admin access.** Staff currently read submissions in the Supabase
    dashboard. A staff-facing page would need authentication plus a
    server-only secret key (never `NEXT_PUBLIC_`).
12. **Allergens.** Only Strawberry Cream is verified (`allergensVerified`);
   confirm the remaining 11 flavours.
