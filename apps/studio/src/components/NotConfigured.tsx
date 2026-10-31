export function NotConfigured() {
  return (
    <p role="status" className="text-stone-600">
      The studio is not configured: its Supabase address and key are missing.
    </p>
  );
}
