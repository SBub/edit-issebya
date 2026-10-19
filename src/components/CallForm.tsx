"use client";

import Link from "next/link";
import { useState } from "react";
import {
  CALL_REQUEST_HINTS,
  CALL_REQUEST_LABELS,
  MAX_FIELD_LENGTH,
  MAX_SOCIALS,
  type CallRequestErrors,
} from "@/lib/call-request";

const FIELD_CLASS =
  "w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none aria-[invalid=true]:border-red-700";

const ICON_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-md border border-neutral-300 text-neutral-700 hover:border-neutral-900 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40";

function FieldError({ id, error }: { id: string; error: string | undefined }) {
  return error ? (
    <p id={id} className="text-xs text-red-700">
      {error}
    </p>
  ) : null;
}

/**
 * The checkout form's fields, uncontrolled so typed values survive an error:
 * name, email, social links (optional, one row to start, more with the +
 * button) and the terms checkbox. Native `required` and `type` stay for
 * semantics and mobile keyboards; the form is `noValidate`, so the inline
 * messages come from parseCallRequest, the same validator the server action
 * runs.
 */
export function CallFormFields({
  errors,
  onTermsChange,
}: {
  errors: CallRequestErrors;
  // Tells the dialog whether the terms box is ticked, so it can enable the
  // submit button. The checkbox itself stays uncontrolled.
  onTermsChange: (checked: boolean) => void;
}) {
  // Row keys, not values: the inputs stay uncontrolled.
  const [rows, setRows] = useState<number[]>([0]);
  const [nextRow, setNextRow] = useState(1);

  function addRow() {
    if (rows.length >= MAX_SOCIALS) return;
    setRows([...rows, nextRow]);
    setNextRow(nextRow + 1);
  }

  function removeRow(key: number) {
    setRows(rows.filter((row) => row !== key));
  }

  const describe = (...ids: (string | false)[]) => ids.filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="name" className="text-sm font-medium">
          {CALL_REQUEST_LABELS.name}
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          maxLength={MAX_FIELD_LENGTH}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={describe(!!errors.name && "name-error")}
          className={FIELD_CLASS}
        />
        <FieldError id="name-error" error={errors.name} />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-sm font-medium">
          {CALL_REQUEST_LABELS.email}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={MAX_FIELD_LENGTH}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={describe(!!errors.email && "email-error")}
          className={FIELD_CLASS}
        />
        <FieldError id="email-error" error={errors.email} />
      </div>

      <fieldset className="flex flex-col gap-1" aria-describedby="socials-hint">
        <legend className="text-sm font-medium">{CALL_REQUEST_LABELS.socials}</legend>
        <p id="socials-hint" className="text-xs text-neutral-500">
          {CALL_REQUEST_HINTS.socials}
        </p>
        <div className="flex flex-col gap-1.5 pt-1">
          {rows.map((row, index) => (
            <div key={row} className="flex items-center gap-1.5">
              <input
                name="socials"
                type="text"
                inputMode="url"
                autoComplete="url"
                placeholder="instagram.com/you"
                aria-label={`${CALL_REQUEST_LABELS.socials} ${index + 1}`}
                maxLength={MAX_FIELD_LENGTH}
                aria-invalid={errors.socials ? true : undefined}
                aria-describedby={describe(!!errors.socials && "socials-error")}
                className={FIELD_CLASS}
              />
              {rows.length > 1 ? (
                <button
                  type="button"
                  aria-label={`${CALL_REQUEST_LABELS.removeSocial} ${index + 1}`}
                  onClick={() => removeRow(row)}
                  className={ICON_BUTTON}
                >
                  <span aria-hidden="true">&times;</span>
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addRow}
          disabled={rows.length >= MAX_SOCIALS}
          aria-label={CALL_REQUEST_LABELS.addSocial}
          className={`${ICON_BUTTON} mt-0.5`}
        >
          <span aria-hidden="true">+</span>
        </button>
        <FieldError id="socials-error" error={errors.socials} />
      </fieldset>

      <div className="flex flex-col gap-1">
        <label className="flex items-start gap-2 text-sm">
          <input
            name="terms"
            type="checkbox"
            required
            onChange={(event) => onTermsChange(event.currentTarget.checked)}
            aria-invalid={errors.terms ? true : undefined}
            aria-describedby={describe(!!errors.terms && "terms-error")}
            className="mt-0.5 size-4 shrink-0 accent-fuchsia-700"
          />
          <span>
            I agree to the{" "}
            <Link href="/terms" target="_blank" className="underline underline-offset-2">
              terms and conditions
            </Link>{" "}
            and the{" "}
            <Link href="/privacy" target="_blank" className="underline underline-offset-2">
              privacy policy
            </Link>
          </span>
        </label>
        <FieldError id="terms-error" error={errors.terms} />
      </div>
    </div>
  );
}
