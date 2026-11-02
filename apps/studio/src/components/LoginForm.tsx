"use client";

import { useActionState } from "react";
import { type LoginState, sendMagicLink } from "@/app/actions";

const INITIAL: LoginState = { status: "idle" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(sendMagicLink, INITIAL);
  const invalid = state.status === "invalid";

  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
      <label htmlFor="email" className="text-sm font-medium">
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        defaultValue={invalid ? state.email : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby="login-status"
        className="rounded-md border border-stone-300 bg-white px-3 py-2 text-base"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-stone-900 px-4 py-2 text-base font-medium text-white disabled:opacity-60"
      >
        Send sign-in link
      </button>
      <p id="login-status" aria-live="polite" className="min-h-6 text-sm">
        {state.status === "invalid" && "Enter a valid email address."}
        {state.status === "sent" && "If this address has an account, a sign-in link is on its way."}
        {state.status === "unavailable" && "Sign-in is not available right now."}
      </p>
    </form>
  );
}
