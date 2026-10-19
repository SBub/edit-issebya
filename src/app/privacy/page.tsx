import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { LANDING } from "@/content/landing";

export const metadata: Metadata = { title: "Privacy policy, edit issebya" };

// A stub until the owner's text is ready; the footer and the checkout form
// link here.
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        The full privacy policy is being finalised and will be published here. Your name, email and
        links are used only to set up and deliver your reels, and are shared only with Stripe to
        take the payment.
      </p>
      <p>
        Questions?{" "}
        <a href={LANDING.questions.href} className="underline underline-offset-2">
          {LANDING.questions.link}
        </a>
        .
      </p>
    </LegalPage>
  );
}
