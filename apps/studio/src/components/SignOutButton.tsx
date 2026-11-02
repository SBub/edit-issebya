import { signOut } from "@/app/actions";

export function SignOutButton() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium"
      >
        Log out
      </button>
    </form>
  );
}
