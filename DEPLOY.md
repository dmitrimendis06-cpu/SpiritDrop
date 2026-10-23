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
2. **UPDATE PRIVACY PROVIDER LIST BEFORE LIVE BACKEND/ANALYTICS ENABLEMENT.**
   Name each provider (hosting, payments, email, address validation,
   analytics) and where it stores data once actually implemented. Marked with
   an HTML comment in `content/legal.html`.
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
9. **Payments.** Not implemented: checkout sends a booking request and says
   "No payment is taken online". Use Stripe-hosted payment entry, verify via
   webhooks, and keep recalculating all money server-side.
10. **Admin access.** Staff currently read submissions in the Supabase
    dashboard. A staff-facing page would need authentication plus a
    server-only secret key (never `NEXT_PUBLIC_`).
11. **Allergens.** Only Strawberry Cream is verified (`allergensVerified`);
   confirm the remaining 11 flavours.
