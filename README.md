# SpiritDrop — Next.js

Next.js (App Router) port of the SpiritDrop static site. Source of the port: `../spiritdrop-original/`.

```bash
npm install
npm run dev     # http://localhost:3000
npm run build && npm start
```

## Routes

| Route | Was |
|---|---|
| `/` | SpiritDrop.html |
| `/shop` | Shop.html |
| `/product?flavour=<slug>` | Product.html |
| `/delivery` | Delivery.html |
| `/about` | About.html |
| `/contact` | Contact.html |
| `/legal` (noindex) | Legal.html |
| 404 (`app/not-found.tsx`) | 404.html |

Old `*.html` URLs permanently redirect to the new routes (`next.config.ts`).

## How it's put together

- `content/*.html` — each page's body markup, unchanged apart from link/asset paths.
- `lib/legacy-page.tsx` — server component that renders a `content/` page.
- `public/` — the original CSS, vanilla JS (data layer, cart, map, UX) and `images/`.
- `app/layout.tsx` — shared `<head>`: fonts, stylesheets, `spiritdrop-data.js`.

The original scripts run exactly as on the static site, so links are plain `<a href>`
(full page loads). Pages can be converted to React components one at a time;
`public/spiritdrop-data.js` remains the single source of truth for prices, flavours and zones.

See `../spiritdrop-original/DEPLOY.md` for the backend / payment / compliance notes,
which still apply.
