export function NotConfigured() {
  return (
    <p role="status" className="text-muted">
      The studio is not configured: its Supabase address and key are missing.
    </p>
  );
}
