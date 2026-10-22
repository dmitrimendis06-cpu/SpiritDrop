import type { Metadata } from "next";
import { LegacyPage } from "@/lib/legacy-page";

export const metadata: Metadata = {
  title: "Shop Cocktails | SpiritDrop",
  description:
    "Browse the SpiritDrop cocktail dispenser range — 12 flavours, 20 ready-to-pour drinks per dispenser, $200 each. Delivered, set up and collected the next day.",
};

export default function Page() {
  return <LegacyPage name="shop" />;
}
