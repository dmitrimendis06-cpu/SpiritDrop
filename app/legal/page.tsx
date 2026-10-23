import type { Metadata } from "next";
import { LegacyPage } from "@/lib/legacy-page";

export const metadata: Metadata = {
  title: "Terms, Privacy & Cancellation | SpiritDrop",
  description:
    "SpiritDrop terms and conditions, privacy policy and cancellation policy, including the 24-hour cancellation rule, the $50 refundable equipment bond and NSW responsible-supply requirements.",
  // Staging: keep noindex until the site approaches production launch, then remove.
  robots: { index: false },
};

export default function Page() {
  return <LegacyPage name="legal" />;
}
