import type { Metadata } from "next";
import { LegacyPage } from "@/lib/legacy-page";

export const metadata: Metadata = {
  title: "Page Not Found | SpiritDrop",
  description:
    "That SpiritDrop page could not be found. Browse the 12-flavour cocktail dispenser range, check delivery zones, or head back to the homepage.",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return <LegacyPage name="404" />;
}
