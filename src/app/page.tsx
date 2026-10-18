import { CallRequest, type CheckoutState } from "@/components/CallRequest";
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
 * The whole site on one screen. The main is h-dvh and every grid row is sized
 * from it, so at every supported viewport nothing scrolls, nothing on html or
 * body is clipped and nothing is hidden: the slider's media is the only part
 * that flexes, and text steps down with the short and tiny height variants
 * (see app_docs/landing-page.md).
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const checkout = checkoutState(params.checkout);
  const sessionId = typeof params.session_id === "string" ? params.session_id : null;
  const utm = pickUtm(params);

  return (
    <main className="landing grid h-dvh gap-x-10 gap-y-4 p-6 short:gap-y-2.5 short:p-4 tiny:gap-y-2 tiny:p-3 lg:p-10 lg:short:p-6">
      <header className="[grid-area:title]">
        <h1 className="text-3xl leading-tight font-medium tracking-tight short:text-2xl tiny:text-xl lg:text-5xl lg:short:text-3xl">
          {LANDING.heading}
        </h1>
      </header>

      <div className="flex min-h-0 flex-col gap-4 [grid-area:text] short:gap-2.5 tiny:gap-2 lg:justify-center lg:gap-6 lg:short:gap-3">
        <p className="text-base text-neutral-700 short:text-sm tiny:text-xs lg:text-lg lg:short:text-base">
          {LANDING.subline}
        </p>
        <p className="text-sm leading-relaxed short:text-xs short:leading-snug lg:text-base lg:short:text-sm">
          {LANDING.forWhom}
        </p>
        <ol
          aria-label="Process"
          className="flex list-inside list-decimal flex-col gap-1 text-sm short:gap-0.5 short:text-xs lg:text-base lg:short:text-sm"
        >
          {LANDING.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <p className="text-sm short:text-xs lg:text-base lg:short:text-sm">{LANDING.offer}</p>
          <p className="text-lg font-medium short:text-base tiny:text-sm lg:text-2xl lg:short:text-lg">
            {formatOfferPrice()}
          </p>
        </div>
      </div>

      <div className="min-h-0 [grid-area:slider]">
        <ReelSlider reels={REELS} />
      </div>

      <div className="[grid-area:cta] lg:max-w-sm">
        <CallRequest checkout={checkout} sessionId={sessionId} utm={utm} />
      </div>
    </main>
  );
}
