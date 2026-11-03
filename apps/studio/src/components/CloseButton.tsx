// The cross that closes a studio dialog, at the top right of its header: a
// plain X in ink with no background or shape, a 40x40 tap target, a slight
// fade on hover. Shared, so the photo and upload dialogs close the same way.
export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close"
      title="Close"
      onClick={onClick}
      className="-mr-2 flex size-10 flex-none items-center justify-center text-ink transition-opacity hover:opacity-70"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}
