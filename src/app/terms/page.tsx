import type { Metadata } from "next";
import Link from "next/link";
import { EmailLink, ExternalLink, LegalPage, LegalSection } from "@/components/LegalPage";
import { QuestionsLink } from "@/components/QuestionsLink";
import { LEGAL } from "@/content/legal";
import { EARLY_BIRD, formatOfferPrice, OFFER, reelSlotsFor } from "@/lib/offer";

export const metadata: Metadata = { title: "Terms and conditions, edit issebya" };

const EARLY_PRICE = formatOfferPrice({
  amountCents: EARLY_BIRD.amountCents,
  currency: OFFER.currency,
});
const STANDARD_PRICE = formatOfferPrice();
const MINUTES = OFFER.maxSeconds / 60;
const MINUTE_WORD = MINUTES === 1 ? "minute" : "minutes";
// The terms of the one service the site sells, in plain English, for a sole
// trader in Portugal selling to businesses and consumers. Every number comes
// from OFFER or EARLY_BIRD and every provider fact from LEGAL
// (src/content/legal.ts), so placeholders are filled in one place.
export default function TermsPage() {
  return (
    <LegalPage title="Terms and conditions">
      <p>
        These terms apply when you buy the reel editing service on this site. Please read them
        before you pay. By paying you agree to them.
      </p>

      <LegalSection id="provider" title="Who we are">
        <p>
          {LEGAL.tradingName} is the trading name of {LEGAL.ownerName}, a sole trader (trabalhador
          independente) registered in Portugal.
        </p>
        <ul className="list-inside list-disc">
          <li>Tax number (NIF): {LEGAL.nif}</li>
          <li>Address: {LEGAL.address}</li>
          <li>
            Email: <EmailLink />
          </li>
        </ul>
        <p>
          In these terms, &quot;we&quot; means {LEGAL.tradingName} and &quot;you&quot; means the
          person or business buying the service.
        </p>
        <p>
          The service is sold to businesses and professionals (including sole traders with an open
          activity) buying it for their business.
        </p>
      </LegalSection>

      <LegalSection id="service" title="The service">
        <p>When you buy the service, you get:</p>
        <ul className="list-inside list-disc">
          <li>A visual identity for your reels, proposed after our discovery call</li>
          <li>A recording guide, so your footage edits into the best possible reel</li>
          <li>
            {OFFER.reelCount} edited reels, each up to {MINUTES} {MINUTE_WORD} long
          </li>
          <li>
            {OFFER.footageDays} days to send footage for all {OFFER.reelCount} reels, starting once
            your visual identity is ready
          </li>
          <li>Each edited reel within {OFFER.deliveryHours} hours of receiving its footage</li>
        </ul>
        <p>
          After payment, your confirmation email has a link to book the discovery call. We use the
          call to understand your brand, audience and positioning before proposing the visual
          identity.
        </p>
      </LegalSection>

      <LegalSection id="reel-length" title="Reel length">
        <p>
          Each reel is up to {MINUTES} {MINUTE_WORD} long. A longer reel has no extra price: it
          counts as more than one of your {OFFER.reelCount} reels, one for every started{" "}
          {MINUTE_WORD} of length. A reel longer than 1 minute and up to 2 minutes counts as{" "}
          {reelSlotsFor(OFFER.maxSeconds * 2)} reels, one longer than 2 minutes and up to 3 minutes
          counts as {reelSlotsFor(OFFER.maxSeconds * 3)}, and so on. For example, a reel of 2
          minutes and 10 seconds counts as {reelSlotsFor(130)} reels.
        </p>
      </LegalSection>

      <LegalSection id="price" title="Price and payment">
        <ul className="list-inside list-disc">
          <li>
            The first {EARLY_BIRD.spots} clients pay {EARLY_PRICE}. After that the price is{" "}
            {STANDARD_PRICE}. The price that applies is the one shown when you pay.
          </li>
          <li>
            No VAT is charged: we are exempt under article 53 of the Portuguese VAT Code (CIVA).
          </li>
          <li>
            You pay the full price upfront by card through Stripe. We never see or store your card
            details.
          </li>
          <li>
            We issue an invoice-receipt (fatura-recibo, the &quot;recibo verde&quot;) for your
            payment.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="footage" title="Your footage and the footage window">
        <p>
          You have {OFFER.footageDays} days to send footage for all {OFFER.reelCount} reels, counted
          from the day your visual identity is ready. Reels you have not sent footage for by the end
          of that window expire and are not refunded, so please plan your recordings for that
          period.
        </p>
      </LegalSection>

      <LegalSection id="revisions" title="Revisions">
        <p>Each reel includes one round of revisions. Further rounds can be agreed separately.</p>
      </LegalSection>

      <LegalSection id="content" title="Your content">
        <ul className="list-inside list-disc">
          <li>
            You confirm that you own, or have permission to use, the footage, music, logos and other
            material you send us, and that using them in your reels does not break anyone
            else&apos;s rights.
          </li>
          <li>You give us permission to use that material only to edit and deliver your reels.</li>
          <li>
            The finished reels are yours to use. We may show them in our portfolio unless you tell
            us not to. You can opt out at any time by emailing <EmailLink />; we then stop using
            them from that point on.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="withdrawal" title="Cancellation and right of withdrawal">
        <p>
          The service is for business use. If you buy for your business or profession, no statutory
          right of withdrawal applies.
        </p>
        <p className="font-medium text-neutral-900">If you buy as a consumer</p>
        <p>
          If you buy for purposes outside your trade, business or profession, the law gives you 14
          days from the day you pay to withdraw without giving a reason. Work starts once the visual
          identity process begins, with the discovery call. If you cancel within the 14 days, we
          refund what you paid minus the value of the work already done (the discovery call, your
          visual identity and any delivered reels). Once all the work is delivered, you can no
          longer withdraw.
        </p>
        <p>
          To withdraw, email us at <EmailLink /> with a clear statement that you want to withdraw.
          You can use the model form below, but you do not have to. We refund what is due within 14
          days of receiving your notice, by the same payment method you used.
        </p>
        <div className="flex flex-col gap-1 rounded-md border border-neutral-200 p-4">
          <p className="font-medium text-neutral-900">Model withdrawal form</p>
          <p>
            To {LEGAL.ownerName} ({LEGAL.tradingName}), {LEGAL.address}, {LEGAL.email}:
          </p>
          <p>
            I/We (*) hereby give notice that I/We (*) withdraw from my/our (*) contract for the
            provision of the following service (*):
          </p>
          <p>Ordered on (*):</p>
          <p>Name of consumer(s):</p>
          <p>Address of consumer(s):</p>
          <p>Signature of consumer(s) (only if this form is sent on paper):</p>
          <p>Date:</p>
          <p className="text-neutral-500">(*) Delete as appropriate.</p>
        </div>
      </LegalSection>

      <LegalSection id="liability" title="Liability">
        <p>
          We do the work with care and skill. Our total liability under this contract is limited to
          the price you paid, except for damage we cause intentionally or through gross negligence,
          and except where the law does not allow a limit. Nothing in these terms limits the rights
          consumers have under the law.
        </p>
      </LegalSection>

      <LegalSection id="force-majeure" title="Events outside our control">
        <p>
          We are not responsible for delays caused by events outside our reasonable control, such as
          serious illness, power or internet outages or natural disasters. We will tell you as soon
          as possible and agree new dates with you.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes to these terms">
        <p>
          We may update these terms. The version that applies to your purchase is the one shown on
          this page when you paid.
        </p>
      </LegalSection>

      <LegalSection id="data" title="Personal data">
        <p>
          Your personal data is handled as described in the{" "}
          <Link href="/privacy" className="underline underline-offset-2">
            privacy policy
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="complaints" title="Complaints and disputes">
        <p>
          If something is wrong, please email us first at <EmailLink />, or send a WhatsApp message:{" "}
          <QuestionsLink location="terms" className="underline underline-offset-2" />.
        </p>
        <p>
          You can also complain in the electronic complaints book (Livro de Reclamações Eletrónico):{" "}
          <ExternalLink href={LEGAL.complaintsBook}>{LEGAL.complaintsBook}</ExternalLink>.
        </p>
        <p>
          If you are a consumer, you can take a dispute to an alternative dispute resolution entity:{" "}
          <ExternalLink href={LEGAL.adrEntity.url}>{LEGAL.adrEntity.name}</ExternalLink>. The list
          of all Portuguese consumer dispute resolution entities is on the consumer portal,{" "}
          <ExternalLink href={LEGAL.consumerPortal}>{LEGAL.consumerPortal}</ExternalLink>.
        </p>
      </LegalSection>

      <LegalSection id="law" title="Applicable law">
        <p>
          These terms are governed by Portuguese law. If you are a consumer, you also keep the
          protection of the mandatory rules of the country where you live, and you can bring a claim
          in the courts of your place of residence. Main laws: Decreto-Lei 7/2004 (e-commerce),
          Decreto-Lei 24/2014 (distance contracts), Lei 144/2015 (consumer dispute resolution),
          Decreto-Lei 156/2005 as amended by Decreto-Lei 74/2017 (complaints book) and article 53 of
          the Portuguese VAT Code.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
