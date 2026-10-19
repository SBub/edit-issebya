import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { LANDING } from "@/content/landing";

export const metadata: Metadata = { title: "Terms and conditions, edit issebya" };

// A stub until the owner's text is ready; the footer and the checkout form
// link here.
export default function TermsPage() {
  return (
    <LegalPage title="Terms and conditions">
      <p>
        The full terms are being finalised and will be published here before the first project
        starts.
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
