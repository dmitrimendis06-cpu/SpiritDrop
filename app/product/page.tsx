import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { LegacyPage } from "@/lib/legacy-page";

const DESCRIPTION =
  "A ready-to-pour LED cocktail dispenser — $200, 20 ready-to-pour drinks, delivered, set up and collected the next day.";

/** Flavour name for a slug, read from the shared data layer so it stays the single source of truth. */
function flavourName(slug: string | undefined): string | undefined {
  const data = fs.readFileSync(path.join(process.cwd(), "public", "spiritdrop-data.js"), "utf8");
  const flavours = [...data.matchAll(/name: "([^"]+)", slug: "([^"]+)"/g)].map((m) => ({ name: m[1], slug: m[2] }));
  // Same fallback as the page script: unknown slug renders the first flavour.
  return (flavours.find((f) => f.slug === slug) ?? flavours[0])?.name;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ flavour?: string | string[] }>;
}): Promise<Metadata> {
  const { flavour } = await searchParams;
  const name = flavourName(Array.isArray(flavour) ? flavour[0] : flavour);
  return {
    title: name ? `SpiritDrop — ${name}` : "Cocktail Dispenser | SpiritDrop",
    description: DESCRIPTION,
  };
}

export default function Page() {
  return <LegacyPage name="product" />;
}
