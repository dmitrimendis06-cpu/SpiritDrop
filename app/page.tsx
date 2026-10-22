import type { Metadata } from "next";
import { LegacyPage } from "@/lib/legacy-page";

export const metadata: Metadata = {
  title: "SpiritDrop | Ready-To-Pour Cocktail Dispensers, Delivered",
  description:
    "Ready-to-pour LED cocktail dispensers delivered, set up and collected the next day. $200 per dispenser, 20 ready-to-pour drinks, delivered to selected zones around Liverpool 2170.",
};

export default function Home() {
  return <LegacyPage name="home" />;
}
