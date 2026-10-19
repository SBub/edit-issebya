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
        <h1
          aria-label={`${LANDING.brand.name} ${LANDING.brand.suffix}`}
          className="text-xl font-semibold tracking-tight short:text-lg"
        >
          {LANDING.brand.name}
          <sub className="ml-0.5 align-sub text-[0.5em] font-normal tracking-normal">
            {LANDING.brand.suffix}
          </sub>
        </h1>
      </header>

      <div className="flex min-h-0 flex-col gap-4 [grid-area:text] short:gap-2.5 tiny:gap-2 lg:justify-center lg:gap-6 lg:short:gap-3">
        <div
          data-testid="description"
          className="flex flex-col gap-3 text-sm leading-relaxed short:gap-1.5 short:text-xs short:leading-snug lg:text-base lg:short:text-sm"
        >
          {LANDING.description.map((paragraph) => (
            <p key={paragraph[0]}>
              {paragraph.map((sentence) => (
                <span key={sentence} className="block">
                  {sentence}
                </span>
              ))}
            </p>
          ))}
        </div>
        <div className="flex flex-col gap-0.5">
          <p className="text-sm short:text-xs lg:text-base lg:short:text-sm">{LANDING.offer}</p>
          <p className="text-lg font-medium short:text-base tiny:text-sm lg:text-2xl lg:short:text-lg">
            {formatOfferPrice()}
          </p>
          <p className="text-xs text-neutral-500 short:text-[11px]">{LANDING.offerNote}</p>
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
