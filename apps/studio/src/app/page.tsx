import { LoginForm } from "@/components/LoginForm";
import { NotConfigured } from "@/components/NotConfigured";
import { SignOutButton } from "@/components/SignOutButton";
import { StudioIdentify } from "@/components/StudioIdentify";
import { DeleteReelButton } from "@/components/DeleteReelButton";
import { type ThumbnailGridItem, ThumbnailGrid } from "@/components/ThumbnailGrid";
import { UploadDialog } from "@/components/UploadDialog";
import { parsePreviewCopies, thumbnailKey } from "@/lib/preview-sources";
import {
  REEL_GRID_COLUMNS,
  type ReelGridRow,
  formatAge,
  formatBytes,
  formatCreatedAt,
  reelName,
} from "@/lib/reels";
import { studioStorage } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase-server";

// Long enough for the page to stay open a while; the browser caches it.
const THUMBNAIL_URL_SECONDS = 3600;

// One tile per reel: its thumbnail signed from the key derived (here, on the
// server) from the current version's key and reels.preview_copies; a reel
// without one, or whose signing fails, gets a neutral tile. The version key
// never reaches the client.
async function reelTiles(rows: readonly ReelGridRow[]): Promise<ThumbnailGridItem[]> {
  const storage = studioStorage();
  const now = Date.now();
  return Promise.all(
    rows.map(async (reel) => {
      const key =
        reel.current_version && reel.current_version_id
          ? thumbnailKey({
              r2Key: reel.current_version.r2_key,
              reelId: reel.id,
              versionId: reel.current_version_id,
              previewCopies: parsePreviewCopies(reel.preview_copies),
            })
          : null;
      let imageUrl: string | null = null;
      if (key && storage) {
        try {
          imageUrl = await storage.signDownload(key, { expiresInSeconds: THUMBNAIL_URL_SECONDS });
        } catch (error) {
          console.error("studio: thumbnail not signed:", (error as Error).message);
        }
      }
      return {
        id: reel.id,
        href: `/reels/${reel.id}`,
        title: reelName(reel),
        imageUrl,
        meta: (
          <>
            <time dateTime={reel.created_at} title={formatCreatedAt(reel.created_at)}>
              {formatAge(reel.created_at, now)}
            </time>
            {` · ${formatBytes(reel.source_bytes)}`}
          </>
        ),
        badge: reel.status,
        badgeTestId: "reel-list-status",
        corner: <DeleteReelButton reelId={reel.id} title={reelName(reel)} />,
      };
    }),
  );
}

export default async function StudioHome({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <h1 className="mb-6 text-2xl font-semibold">Studio</h1>
        <NotConfigured />
      </main>
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const { error } = await searchParams;
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <h1 className="mb-6 text-2xl font-semibold">Studio</h1>
        {error === "link" && (
          <p role="alert" className="mb-4 text-sm text-danger">
            That sign-in link has expired or was already used
          </p>
        )}
        <LoginForm />
      </main>
    );
  }

  // RLS returns only the owner's rows; no owner filter here, so a missing
  // policy can never be masked by the query.
  const { data, error } = await supabase
    .from("reels")
    .select(REEL_GRID_COLUMNS)
    .order("created_at", { ascending: false })
    .returns<ReelGridRow[]>();
  if (error) throw new Error(`studio: reels not loaded: ${error.message}`);
  const tiles = await reelTiles(data ?? []);

  return (
    <div className="flex h-dvh flex-col">
      <StudioIdentify userId={user.id} />
      <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-line bg-chrome px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Your reels</h1>
          <p className="truncate text-xs text-muted">{user.email}</p>
        </div>
        <SignOutButton />
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-24 sm:p-4 sm:pb-24">
        <ThumbnailGrid label="Reels" items={tiles} empty={<p>No reels yet</p>} rounded />
      </main>
      <UploadDialog />
    </div>
  );
}
