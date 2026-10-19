import type { Metadata } from "next";
import Link from "next/link";
import { EmailLink, ExternalLink, LegalPage, LegalSection } from "@/components/LegalPage";
import { QuestionsLink } from "@/components/QuestionsLink";
import { LEGAL } from "@/content/legal";

export const metadata: Metadata = { title: "Privacy policy, edit issebya" };

// The privacy policy in plain English (GDPR and Lei 58/2019). Provider facts
// come from LEGAL (src/content/legal.ts). The analytics section describes
// what PostHog does on the live site today: see app_docs/analytics.md.
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        This policy explains what personal data we collect when you visit this site or buy the reel
        editing service, why, who we share it with and what your rights are.
      </p>

      <LegalSection id="controller" title="Who is responsible">
        <p>
          The controller of your data is {LEGAL.ownerName}, trading as {LEGAL.tradingName}, a sole
          trader registered in Portugal (NIF {LEGAL.nif}), {LEGAL.address}. Email: <EmailLink />.
        </p>
      </LegalSection>

      <LegalSection id="collect" title="What we collect">
        <ul className="list-inside list-disc">
          <li>
            The checkout form: your name, email, the social media links you add (optional) and
            whether you ticked the box to get occasional emails
          </li>
          <li>
            Your payment: Stripe collects your card and billing details. We see the amount, the
            date, your name, email and billing country, never your full card details
          </li>
          <li>Booking the discovery call: the name, email and time you enter in Google Calendar</li>
          <li>
            Messages you send us by email or WhatsApp, and the footage and material you send for
            your reels
          </li>
          <li>
            Usage analytics on the live site: the pages you view, clicks on the reels and the call
            to action, your browser and device type, approximate location derived from your IP
            address, and the campaign parameters in the link you came from. Never your form answers
          </li>
          <li>
            Technical logs: our host records IP addresses and requests to keep the site secure
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="purposes" title="Why we use it, and on what legal basis">
        <ul className="list-inside list-disc">
          <li>
            To deliver the service you bought, book the discovery call and send you emails about
            your order: to perform our contract with you (GDPR article 6(1)(b))
          </li>
          <li>
            To issue invoices and keep accounting records: to meet our legal obligations under
            Portuguese tax law (article 6(1)(c))
          </li>
          <li>
            To send you occasional emails with new offers and tips: only if you ticked the box, on
            the basis of your consent (article 6(1)(a)). You can withdraw it at any time
          </li>
          <li>
            To understand how the site is used and improve it (anonymous, aggregate analytics): our
            legitimate interest (article 6(1)(f)); see &quot;Cookies and analytics&quot; below
          </li>
          <li>
            To keep the site secure and answer your messages: our legitimate interest (article
            6(1)(f))
          </li>
          <li>
            To show finished reels in our portfolio: our legitimate interest in showing our work
            (article 6(1)(f)). You can object at any time by email, and we then stop using them
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="processors" title="Who we share it with">
        <p>We use these service providers, who process data on our behalf:</p>
        <ul className="list-inside list-disc">
          <li>Stripe: payments</li>
          <li>Resend: sends the confirmation and newsletter emails</li>
          <li>PostHog: anonymous usage analytics, hosted in the EU</li>
          <li>Google: the booking calendar for the discovery call</li>
          <li>Vercel: hosts the site</li>
        </ul>
        <p>
          If you message us on WhatsApp, WhatsApp (Meta) also processes that conversation under its
          own privacy policy.
        </p>
        <p>
          Some of these providers are based in the United States or use staff and servers there.
          Those transfers are protected by the EU-US Data Privacy Framework where the provider is
          certified, or by the European Commission&apos;s Standard Contractual Clauses. We never
          sell your data.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="How long we keep it">
        <ul className="list-inside list-disc">
          <li>
            Order, form and booking data and your material: as long as needed to deliver the service
            and to deal with any claim about it
          </li>
          <li>Invoices and accounting records: as long as Portuguese tax law requires</li>
          <li>
            Newsletter: until you unsubscribe, plus a record of your consent and when you withdrew
            it
          </li>
          <li>Analytics: until it is no longer needed to understand how the site is used</li>
        </ul>
      </LegalSection>

      <LegalSection id="rights" title="Your rights">
        <p>
          You can ask to access, correct or delete your data, to restrict or object to its use
          (including showing your reels in our portfolio), and to receive it in a portable format.
          You can withdraw your newsletter consent at any time by replying to any email or using the
          unsubscribe link in it. Write to <EmailLink />; we reply within one month.
        </p>
        <p>
          You can also complain to the Portuguese data protection authority,{" "}
          <ExternalLink href={LEGAL.dataProtectionAuthority.url}>
            {LEGAL.dataProtectionAuthority.name} ({LEGAL.dataProtectionAuthority.url})
          </ExternalLink>
          .
        </p>
      </LegalSection>

      <LegalSection id="cookies" title="Cookies and analytics">
        <p>
          This site stores nothing on your device: no cookies, no local storage and no session
          storage, for analytics or anything else. That is why there is no cookie banner.
        </p>
        <p>
          On the live site, PostHog analytics runs in cookieless mode. It does not give your browser
          an identifier; PostHog&apos;s servers derive a short-lived anonymous hash instead, so we
          only see anonymous, aggregate statistics about how the site is used. It is not used for
          advertising or shared for marketing. The legal basis is our legitimate interest in
          understanding and improving the site (GDPR article 6(1)(f)), and you can object at any
          time by email.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          <EmailLink />. Questions first? <QuestionsLink className="underline underline-offset-2" />
          . The{" "}
          <Link href="/terms" className="underline underline-offset-2">
            terms and conditions
          </Link>{" "}
          explain how the service works.
        </p>
      </LegalSection>

      <LegalSection id="law" title="Applicable law">
        <p>
          Regulation (EU) 2016/679 (GDPR), Lei 58/2019 (its Portuguese implementation) and Lei
          41/2004 (privacy in electronic communications, which covers cookies).
        </p>
      </LegalSection>
    </LegalPage>
  );
}
