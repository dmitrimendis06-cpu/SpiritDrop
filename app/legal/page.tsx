import type { Metadata } from "next";
import { LegacyPage } from "@/lib/legacy-page";

export const metadata: Metadata = {
  title: "Terms, Privacy & Cancellation | SpiritDrop",
  description:
    "SpiritDrop terms and conditions, privacy policy and cancellation policy. Draft structure pending owner and legal review.",
  robots: { index: false },
};

export default function Page() {
  return <LegacyPage name="legal" />;
}
