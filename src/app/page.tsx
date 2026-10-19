import Link from "next/link";
import { BRAND_CLASS, BrandName, PAGE_PADDING } from "@/components/Brand";
import { CallRequest, type CheckoutState } from "@/components/CallRequest";
import { QuestionsLink } from "@/components/QuestionsLink";
import { ReelSlider } from "@/components/ReelSlider";
import { LANDING } from "@/content/landing";
import { REELS } from "@/content/reels";
import { EARLY_BIRD, formatOfferPrice, OFFER } from "@/lib/offer";
import { currentOfferPrice } from "@/lib/offer-price";
import { pickUtm } from "@/lib/utm";

// The two lists: hanging indents (markers outside, wrapped lines align with
// the text), a little air between items and under the heading. `mid:` (one
// screen, 820px tall or less) drops the air so the column still fits.
const LIST_HEADING = "mb-2 font-medium mid:mb-0";
const LIST = "list-outside space-y-1 pl-5 mid:space-y-0";

type SearchParams = Record<string, string | string[] | undefined>;

function checkoutState(value: SearchParams[string]): CheckoutState {
  return value === "success" || value === "cancelled" ? value : null;
}

/**
 * Two-column layout only: one between every pair of blocks in the right
 * column (quote, introduction, the two sections, closing line, offer box).
 * All are identical flex items (globals.css, .landing-spacer), so the gaps
 * are always equal: each grows into the column's free height from a minimum
 * up to 6rem. Hidden in the stacked layout, where one grid and flex gap
 * (--landing-gap) spaces the same blocks.
 */
function Spacer() {
  return <div aria-hidden="true" className="landing-spacer" />;
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
  // Cached for a minute; the server action counts again at checkout time.
  const price = await currentOfferPrice({ fresh: false });

  return (
    <main className={`landing grid gap-x-10 ${PAGE_PADDING}`}>
      <header className="[grid-area:title]">
        <h1 aria-label={`${LANDING.brand.name} ${LANDING.brand.suffix}`} className={BRAND_CLASS}>
          <BrandName />
        </h1>
      </header>

      <div className="landing-text min-h-0 flex-col justify-center">
        <div className="landing-intro flex flex-col text-sm leading-relaxed short:gap-1.5 short:text-xs short:leading-snug lg:text-base lg:mid:text-sm lg:short:text-sm">
          {/* The page's tagline, highlighted and first: the owner's own
              words, so a styled paragraph, not a blockquote (nothing is
              quoted from elsewhere). The curly quotes are part of the text. */}
          <p className="text-lg leading-snug font-semibold text-neutral-900 italic short:text-sm tiny:text-sm lg:text-xl lg:mid:text-lg lg:short:text-base">
            “{LANDING.quote}”
          </p>
          <Spacer />
          <p>{LANDING.intro}</p>
        </div>
        <Spacer />
        <div className="landing-details flex flex-col">
          <section
            aria-label="How we work together"
            className="text-sm short:text-xs lg:text-base lg:mid:text-sm lg:short:text-sm"
          >
            <h2 className={LIST_HEADING}>{LANDING.howItWorks.title}</h2>
            <ol className={`list-decimal ${LIST}`}>
              {LANDING.howItWorks.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>
          <Spacer />
          <section
            aria-label="What you get"
            className="text-sm short:text-xs lg:text-base lg:mid:text-sm lg:short:text-sm"
          >
            <h2 className={LIST_HEADING}>{LANDING.whatYouGet.title}</h2>
            <ul className={`list-disc ${LIST}`}>
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
          <Spacer />
          <p className="text-sm leading-relaxed short:text-xs short:leading-snug lg:text-base lg:mid:text-sm lg:short:text-sm">
            {LANDING.closing}
          </p>
        </div>
        <Spacer />
        {/* Inside the text column so its gap matches the others; on phones
            .landing-text is display: contents and grid-area cta places it. */}
        <section
          aria-label="Offer"
          className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 [grid-area:cta] short:gap-2 short:p-4 lg:max-w-md lg:mid:gap-2 lg:mid:p-4"
        >
          <div className="flex flex-col gap-1 short:gap-0.5">
            {price.tier === "early" ? (
              <p className="flex flex-wrap items-baseline gap-x-2 text-lg font-medium short:text-base tiny:text-sm lg:text-2xl lg:mid:text-xl lg:short:text-lg">
                <span>
                  {formatOfferPrice({ amountCents: price.amountCents, currency: OFFER.currency })}
                </span>
                <s className="text-sm font-normal text-neutral-500 short:text-xs lg:text-base lg:mid:text-sm lg:short:text-sm">
                  <span className="sr-only">was </span>
                  {formatOfferPrice()}
                </s>
              </p>
            ) : (
              <p className="text-lg font-medium short:text-base tiny:text-sm lg:text-2xl lg:mid:text-xl lg:short:text-lg">
                {formatOfferPrice()}
              </p>
            )}
            <p className="text-xs text-neutral-500">{LANDING.vatExempt}</p>
            {price.tier === "early" ? (
              <p className="text-xs text-fuchsia-700">
                {LANDING.earlyBird(price.spotsLeft, EARLY_BIRD.spots)}
              </p>
            ) : null}
          </div>
          <CallRequest checkout={checkout} sessionId={sessionId} utm={utm} />
          <p className="text-xs leading-relaxed text-neutral-600">{LANDING.afterPurchase}</p>
          <p className="text-xs text-neutral-600">
            {LANDING.questions.lead}{" "}
            <QuestionsLink className="text-neutral-900 underline underline-offset-2 hover:text-fuchsia-700" />
            .
          </p>
        </section>
      </div>

      <div className="reel-area min-h-0 [grid-area:slider]">
        <ReelSlider reels={REELS} />
      </div>

      <footer className="text-xs text-neutral-500 [grid-area:footer]">
        <nav aria-label="Legal" className="flex flex-wrap gap-x-4 gap-y-1">
          {LANDING.footer.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-neutral-900">
              {item.label}
            </Link>
          ))}
          <a
            href={LANDING.complaintsBook.href}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-neutral-900"
          >
            {LANDING.complaintsBook.label}
          </a>
        </nav>
      </footer>
    </main>
  );
}
