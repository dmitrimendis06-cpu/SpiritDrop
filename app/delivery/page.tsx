import type { Metadata } from "next";
import { LegacyPage } from "@/lib/legacy-page";

export const metadata: Metadata = {
  title: "Delivery & Collection | SpiritDrop",
  description:
    "How SpiritDrop delivers and collects your cocktail dispenser. Delivery fee calculated by zone from our Liverpool 2170 base, next-day collection and basic setup included.",
};

export default function Page() {
  return <LegacyPage name="delivery" />;
}
