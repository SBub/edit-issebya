import {
  CALL_REQUEST_FIELDS,
  CALL_REQUEST_HINTS,
  CALL_REQUEST_LABELS,
  MAX_FIELD_LENGTH,
  type CallRequestErrors,
  type CallRequestField,
} from "@/lib/call-request";

const INPUT_TYPES: Partial<Record<CallRequestField, string>> = {
  email: "email",
  content_link: "url",
};

const AUTOCOMPLETE: Partial<Record<CallRequestField, string>> = {
  name: "name",
  email: "email",
  company_role: "organization-title",
  content_link: "url",
};

const FIELD_CLASS =
  "w-full border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none aria-[invalid=true]:border-red-700";

/**
 * The six discovery-call fields, uncontrolled so typed values survive an
 * error. Native `required` and `type` stay for semantics and mobile keyboards;
 * the form is `noValidate`, so the inline messages come from parseCallRequest,
 * the same validator the server action runs.
 */
export function CallFormFields({ errors }: { errors: CallRequestErrors }) {
  return (
    <div className="flex flex-col gap-3">
      {CALL_REQUEST_FIELDS.map((field) => {
        const error = errors[field];
        const hint = CALL_REQUEST_HINTS[field];
        const hintId = `${field}-hint`;
        const errorId = `${field}-error`;
        const describedBy = [hint ? hintId : null, error ? errorId : null]
          .filter(Boolean)
          .join(" ");
        const shared = {
          id: field,
          name: field,
          required: true,
          maxLength: MAX_FIELD_LENGTH,
          "aria-invalid": error ? true : undefined,
          "aria-describedby": describedBy || undefined,
          className: FIELD_CLASS,
        };
        return (
          <div key={field} className="flex flex-col gap-1">
            <label htmlFor={field} className="text-sm font-medium">
              {CALL_REQUEST_LABELS[field]}
            </label>
            {field === "reels_purpose" ? (
              <textarea {...shared} rows={3} className={`${FIELD_CLASS} resize-none`} />
            ) : (
              <input
                {...shared}
                type={INPUT_TYPES[field] ?? "text"}
                autoComplete={AUTOCOMPLETE[field]}
              />
            )}
            {hint ? (
              <p id={hintId} className="text-xs text-neutral-500">
                {hint}
              </p>
            ) : null}
            {error ? (
              <p id={errorId} className="text-xs text-red-700">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
