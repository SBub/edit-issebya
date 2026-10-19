import Link from "next/link";
import { BRAND_CLASS, BrandName, PAGE_PADDING } from "@/components/Brand";
import { CallRequest, type CheckoutState } from "@/components/CallRequest";
import { QuestionsLink } from "@/components/QuestionsLink";
import { ReelSlider } from "@/components/ReelSlider";
import { LANDING } from "@/content/landing";
import { REELS } from "@/content/reels";
import { formatOfferPrice } from "@/lib/offer";
import { pickUtm } from "@/lib/utm";

type SearchParams = Record<string, string | string[] | undefined>;

function checkoutState(value: SearchParams[string]): CheckoutState {
  return value === "success" || value === "cancelled" ? value : null;
}

/**
 * Wide screens (and tablets in landscape): the whole site on one screen. The
 * main is 100dvh and every grid row is sized from it, so nothing scrolls,
 * nothing on html or body is clipped and nothing is hidden: the slider's
 * media is the only part that flexes. Narrow screens stack the slider, text
 * and CTA and scroll vertically (never sideways); the slider gets a fixed
 * share of the screen there. See app_docs/landing-page.md.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const checkout = checkoutState(params.checkout);
  const sessionId = typeof params.session_id === "string" ? params.session_id : null;
  const utm = pickUtm(params);

  return (
    <main className={`landing grid gap-x-10 gap-y-4 short:gap-y-2.5 tiny:gap-y-2 ${PAGE_PADDING}`}>
      <header className="[grid-area:title]">
        <h1 aria-label={`${LANDING.brand.name} ${LANDING.brand.suffix}`} className={BRAND_CLASS}>
          <BrandName />
        </h1>
      </header>

      <div className="flex min-h-0 flex-col gap-4 [grid-area:text] short:gap-2.5 tiny:gap-2 lg:justify-center lg:gap-6 lg:mid:gap-3 lg:short:gap-3">
        <div className="flex flex-col gap-3 text-sm leading-relaxed short:gap-1.5 short:text-xs short:leading-snug lg:text-base lg:mid:text-sm lg:short:text-sm">
          {LANDING.description.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <section
          aria-label="How it works"
          className="text-sm short:text-xs lg:text-base lg:mid:text-sm lg:short:text-sm"
        >
          <h2 className="font-medium">{LANDING.howItWorks.title}</h2>
          <ol className="list-inside list-decimal">
            {LANDING.howItWorks.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
        <section
          aria-label="What you get"
          className="text-sm short:text-xs lg:text-base lg:mid:text-sm lg:short:text-sm"
        >
          <h2 className="font-medium">{LANDING.whatYouGet.title}</h2>
          <ul className="list-inside list-disc">
            {LANDING.whatYouGet.items.map((item) => (
              <li key={item.text}>
                {item.text}
                {"note" in item ? (
                  <span className="text-neutral-500">
                    {" "}
                    ({item.note.lead}{" "}
                    <Link href={item.note.href} className="underline underline-offset-2">
                      {item.note.link}
                    </Link>
                    )
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        <p className="text-sm leading-relaxed short:text-xs short:leading-snug lg:text-base lg:mid:text-sm lg:short:text-sm">
          {LANDING.closing}
        </p>
      </div>

      <div className="reel-area min-h-0 [grid-area:slider]">
        <ReelSlider reels={REELS} />
      </div>

      <section
        aria-label="Offer"
        className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 [grid-area:cta] short:gap-2 short:p-4 lg:max-w-md lg:mid:gap-2 lg:mid:p-4"
      >
        <p className="text-lg font-medium short:text-base tiny:text-sm lg:text-2xl lg:mid:text-xl lg:short:text-lg">
          {formatOfferPrice()}
        </p>
        <CallRequest checkout={checkout} sessionId={sessionId} utm={utm} />
        <p className="text-xs leading-relaxed text-neutral-600">{LANDING.afterPurchase}</p>
        <p className="text-xs text-neutral-600">
          {LANDING.questions.lead}{" "}
          <QuestionsLink className="text-neutral-900 underline underline-offset-2 hover:text-fuchsia-700" />
          .
        </p>
      </section>

      <footer className="text-xs text-neutral-500 [grid-area:footer]">
        <nav aria-label="Legal" className="flex gap-4">
          {LANDING.footer.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-neutral-900">
              {item.label}
            </Link>
          ))}
        </nav>
      </footer>
    </main>
  );
}
