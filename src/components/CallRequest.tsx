"use client";

import posthog from "posthog-js";
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { startCheckout } from "@/app/actions";
import { LANDING } from "@/content/landing";
import {
  CALL_REQUEST_FIELDS,
  parseCallRequest,
  type CallRequestErrors,
  type CallRequestField,
} from "@/lib/call-request";
import type { Utm } from "@/lib/utm";
import { CallFormFields } from "./CallForm";

export type CheckoutState = "success" | "cancelled" | null;

const PRIMARY_BUTTON =
  "w-full bg-neutral-900 px-5 py-3 text-sm font-medium tracking-wide text-white hover:bg-neutral-700 disabled:cursor-wait disabled:opacity-70 short:py-2.5 tiny:py-2";

function formValues(form: HTMLFormElement): Record<string, string> {
  const data = new FormData(form);
  const values: Record<string, string> = {};
  for (const field of CALL_REQUEST_FIELDS) {
    const value = data.get(field);
    values[field] = typeof value === "string" ? value : "";
  }
  return values;
}

/**
 * The page's one call to action and everything behind it: the form dialog, the
 * thank-you dialog after a paid Checkout and the note after a cancelled one.
 * Events never carry form answers.
 */
export function CallRequest({
  checkout,
  sessionId,
  utm,
}: {
  checkout: CheckoutState;
  sessionId: string | null;
  utm: Utm;
}) {
  const ctaRef = useRef<HTMLButtonElement | null>(null);
  const formDialogRef = useRef<HTMLDialogElement | null>(null);
  const thanksDialogRef = useRef<HTMLDialogElement | null>(null);
  const startedRef = useRef(false);
  const [errors, setErrors] = useState<CallRequestErrors>({});
  const [unavailable, setUnavailable] = useState(false);
  const [pending, startTransition] = useTransition();

  // The thank-you dialog is opened through the DOM dialog API, an external
  // system. purchase_completed is sent once per session id, guarded in
  // sessionStorage against strict-mode double effects and reloads.
  useEffect(() => {
    if (checkout !== "success") return;
    const dialog = thanksDialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    if (!sessionId) return;
    const key = `purchase_completed:${sessionId}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // sessionStorage can throw (private mode); count the purchase anyway.
    }
    posthog.capture("purchase_completed", { session_id: sessionId });
  }, [checkout, sessionId]);

  function openForm() {
    posthog.capture("cta_clicked");
    startedRef.current = false;
    formDialogRef.current?.showModal();
  }

  function onInput(event: FormEvent<HTMLFormElement>) {
    if (!startedRef.current) {
      startedRef.current = true;
      posthog.capture("call_form_started");
    }
    const name = (event.target as HTMLInputElement).name as CallRequestField;
    if (!errors[name]) return;
    const result = parseCallRequest(formValues(event.currentTarget));
    const next = result.ok ? undefined : result.errors[name];
    setErrors((current) => ({ ...current, [name]: next }));
  }

  function focusFirstInvalid(form: HTMLFormElement, fieldErrors: CallRequestErrors) {
    const first = CALL_REQUEST_FIELDS.find((field) => fieldErrors[field]);
    if (first) form.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const fields = formValues(form);
    const parsed = parseCallRequest(fields);
    setUnavailable(false);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      focusFirstInvalid(form, parsed.errors);
      return;
    }
    setErrors({});
    posthog.capture("call_form_submitted");
    startTransition(async () => {
      const result = await startCheckout({ fields: parsed.value, utm: { ...utm } });
      if (result.ok) {
        posthog.capture("checkout_started");
        window.location.assign(result.url);
      } else if (result.error === "invalid") {
        setErrors(result.fieldErrors);
        focusFirstInvalid(form, result.fieldErrors);
      } else {
        setUnavailable(true);
      }
    });
  }

  function closeThanks() {
    window.history.replaceState(null, "", "/");
  }

  return (
    <div className="flex flex-col gap-2 tiny:gap-1.5">
      <button ref={ctaRef} type="button" onClick={openForm} className={PRIMARY_BUTTON}>
        {LANDING.cta}
      </button>
      {checkout === "cancelled" ? (
        <p role="status" className="text-center text-xs text-neutral-500">
          {LANDING.cancelled}
        </p>
      ) : null}

      <DialogShell
        dialogRef={formDialogRef}
        titleId="call-dialog-title"
        title="Book your discovery call"
        onClose={() => ctaRef.current?.focus()}
      >
        <form
          noValidate
          onSubmit={onSubmit}
          onInput={onInput}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <CallFormFields errors={errors} />
          </div>
          <div className="flex flex-col gap-2 border-t border-neutral-200 px-5 py-4">
            {unavailable ? (
              <p role="alert" className="text-sm text-red-700">
                {LANDING.unavailable}
              </p>
            ) : null}
            <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
              {pending ? "Redirecting..." : "Continue to payment"}
            </button>
          </div>
        </form>
      </DialogShell>

      <DialogShell
        dialogRef={thanksDialogRef}
        titleId="thanks-dialog-title"
        title="Thank you"
        onClose={closeThanks}
      >
        <p className="px-5 py-4 text-sm leading-relaxed">{LANDING.thankYou}</p>
      </DialogShell>
    </div>
  );
}

function DialogShell({
  dialogRef,
  titleId,
  title,
  onClose,
  children,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  titleId: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] bg-white p-0 text-neutral-900 open:flex open:flex-col"
    >
      <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3">
        <h2 id={titleId} className="text-base font-medium">
          {title}
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={() => dialogRef.current?.close()}
          className="flex size-8 items-center justify-center text-neutral-600 hover:text-neutral-900"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {children}
    </dialog>
  );
}
