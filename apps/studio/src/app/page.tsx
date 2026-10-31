import { LoginForm } from "@/components/LoginForm";
import { NotConfigured } from "@/components/NotConfigured";
import { ReelList } from "@/components/ReelList";
import { SignOutButton } from "@/components/SignOutButton";
import type { ReelSummary } from "@/lib/reels";
import { REEL_COLUMNS } from "@/lib/reels";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export default async function StudioHome({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return (
      <>
        <h1 className="mb-6 text-2xl font-semibold">Studio</h1>
        <NotConfigured />
      </>
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const { error } = await searchParams;
    return (
      <>
        <h1 className="mb-6 text-2xl font-semibold">Studio</h1>
        {error === "link" && (
          <p role="alert" className="mb-4 text-sm text-red-700">
            That sign-in link has expired or was already used.
          </p>
        )}
        <LoginForm />
      </>
    );
  }

  // RLS returns only the owner's rows; no owner filter here, so a missing
  // policy can never be masked by the query.
  const { data, error } = await supabase
    .from("reels")
    .select(REEL_COLUMNS)
    .order("created_at", { ascending: false })
    .returns<ReelSummary[]>();
  if (error) throw new Error(`studio: reels not loaded: ${error.message}`);

  return (
    <>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Your reels</h1>
          <p className="text-sm break-all text-stone-600">{user.email}</p>
        </div>
        <SignOutButton />
      </header>
      <ReelList reels={data ?? []} />
    </>
  );
}
