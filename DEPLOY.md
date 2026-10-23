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

## Internal TODO — genuinely unresolved

1. **Hosting target vs. private S3 + CloudFront.** This is a Next.js app, not
   a folder of `.html` objects. Choose one before go-live:
   - Node hosting (e.g. Amplify Hosting, or a server behind CloudFront), which
     runs the app as-is, including the redirects; or
   - Static export (`output: "export"`) to S3. This requires: (a) moving
     `/product`'s per-flavour `<title>` out of `generateMetadata` (it reads
     `searchParams`, which static export does not support); (b) a CloudFront
     Function that maps clean paths to objects (`/contact` → `/contact.html`,
     case-sensitive, lowercase); (c) re-creating the `.html` → clean-path
     redirects in that function, since `next.config.ts` redirects do not run
     on S3; (d) mapping 403/404 to `/404.html`.
2. **UPDATE PRIVACY PROVIDER LIST BEFORE LIVE BACKEND/ANALYTICS ENABLEMENT.**
   Name each provider (hosting, payments, email, address validation,
   analytics) and where it stores data once actually implemented. Marked with
   an HTML comment in `content/legal.html`.
3. **Analytics.** `spiritdrop-ux.js` has GA4/Clarity/Meta IDs set to `null`, so
   no consent banner shows and the Privacy Policy says no analytics run. If
   any ID is set, update the "Cookies and browser storage" section at the same
   time.
4. **Add-on prices and pack sizes** (Cocktail Cups, Dried Garnishes, Ice Bags).
   Purchasing controls stay disabled (`pending: true` in `SD.ADDONS`) until
   prices are configured.
5. **Legal page `noindex`** (`app/legal/page.tsx`). Remove when the site
   approaches production launch.
6. **Production domain.** Set `metadataBase`, `og:url`, `og:image`, canonical
   links, and absolute URLs in `public/robots.txt` and `public/sitemap.xml`.
7. **Backend, payments and order confirmation.** Not implemented. Recalculate
   all money server-side, use Stripe-hosted payment entry, and add a real
   confirmation page only once orders exist. The checkout still says
   "Prototype — no payment is taken".
8. **Allergens.** Only Strawberry Cream is verified (`allergensVerified`);
   confirm the remaining 11 flavours.
