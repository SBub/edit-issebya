import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/LegalPage";
import { QuestionsLink } from "@/components/QuestionsLink";

export const metadata: Metadata = { title: "Terms and conditions, edit issebya" };

// A draft until the owner's text is ready; the footer and the checkout form
// link here.
export default function TermsPage() {
  return (
    <LegalPage title="Terms and conditions">
      <p>
        The full terms are being finalised and will be published here before the first project
        starts.
      </p>
      <p>
        Your personal data is handled as described in the{" "}
        <Link href="/privacy" className="underline underline-offset-2">
          privacy policy
        </Link>
        .
      </p>
      <p>
        Questions? <QuestionsLink className="underline underline-offset-2" />.
      </p>
    </LegalPage>
  );
}
