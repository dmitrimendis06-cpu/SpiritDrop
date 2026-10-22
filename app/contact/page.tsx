import type { Metadata } from "next";
import { LegacyPage } from "@/lib/legacy-page";

export const metadata: Metadata = {
  title: "Contact & Event Enquiries | SpiritDrop",
  description:
    "Get in touch with SpiritDrop — plan an event, ask a question or book your ready-to-pour cocktail dispensers.",
};

export default function Page() {
  return <LegacyPage name="contact" />;
}
