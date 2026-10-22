import type { Metadata } from "next";
import { LegacyPage } from "@/lib/legacy-page";

export const metadata: Metadata = {
  title: "About | SpiritDrop",
  description:
    "SpiritDrop makes hosting effortless — ready-to-pour LED cocktail dispensers delivered, set up and collected the next day from our Liverpool 2170 base.",
};

export default function Page() {
  return <LegacyPage name="about" />;
}
