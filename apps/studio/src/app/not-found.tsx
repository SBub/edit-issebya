import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Reel not found</h1>
        <p className="text-muted">It does not exist, or it is not yours</p>
        <Link href="/" className="text-sm underline">
          Back to your reels
        </Link>
      </section>
    </main>
  );
}
