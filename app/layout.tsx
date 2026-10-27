import type { Metadata, Viewport } from "next";
import { versioned } from "@/lib/assets";

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23090909'/%3E%3Cpath d='M16 6c4 5.2 6 8.4 6 11a6 6 0 11-12 0c0-2.6 2-5.8 6-11z' fill='%23a855f7'/%3E%3C/svg%3E";

// TODO (deploy): set metadataBase and add og:url / og:image / canonical once the production domain is configured.
export const metadata: Metadata = {
  title: "SpiritDrop | Ready-To-Pour Cocktail Dispensers, Delivered",
  icons: { icon: ICON },
  openGraph: {
    type: "website",
    siteName: "SpiritDrop",
    title: "SpiritDrop — Cocktails. Delivered. Ready To Pour.",
    description:
      "Ready-to-pour LED cocktail dispensers delivered, set up and collected the next day. 12 flavours, 20 ready-to-pour drinks per dispenser.",
  },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Bebas+Neue&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href={versioned("/spiritdrop.css")} />
        <link rel="stylesheet" href={versioned("/spiritdrop-cart.css")} />
        <link rel="stylesheet" href={versioned("/spiritdrop-pages.css")} />
        <script dangerouslySetInnerHTML={{ __html: 'document.documentElement.className += " js";' }} />
        {/* Shared data layer (window.SD, FLAVOURS, …) — must load before any page script. */}
        <script src={versioned("/spiritdrop-data.js")} />
      </head>
      <body>{children}</body>
    </html>
  );
}
