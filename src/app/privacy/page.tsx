import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { LegalPage } from "@/components/LegalPage";
import { QuestionsLink } from "@/components/QuestionsLink";

export const metadata: Metadata = { title: "Privacy policy, edit issebya" };

const CONTACT_EMAIL = "edit@issebya.com";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="font-medium text-neutral-900">{title}</h2>
      {children}
    </section>
  );
}

// A plain-language draft until the owner's final text is ready; the footer,
// the checkout form and the terms page link here.
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p className="text-neutral-500">Draft. The final version will be published here.</p>

      <Section title="What we collect">
        <ul className="list-inside list-disc">
          <li>Your name and email</li>
          <li>The social media links you add, if any</li>
          <li>Whether you ticked the box to get occasional emails</li>
          <li>Your payment, which Stripe handles. We never see or store your card details</li>
        </ul>
      </Section>

      <Section title="Where it is stored">
        <ul className="list-inside list-disc">
          <li>Stripe, which holds your order and your form answers</li>
          <li>Resend, which sends the confirmation and newsletter emails</li>
          <li>PostHog, for anonymous usage analytics, on the live site only</li>
        </ul>
      </Section>

      <Section title="Why">
        <p>
          To deliver your reels and book our discovery call. We send you the newsletter only if you
          ticked the box.
        </p>
      </Section>

      <Section title="How long">
        <p>As long as needed to deliver the service and as long as accounting law requires.</p>
      </Section>

      <Section title="Your rights">
        <p>
          You can ask to see, correct or delete your data. You can withdraw your newsletter consent
          any time by replying to any email or using the unsubscribe link in it.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          <Link href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-2">
            {CONTACT_EMAIL}
          </Link>
          . Questions first? <QuestionsLink className="underline underline-offset-2" />.
        </p>
      </Section>
    </LegalPage>
  );
}
