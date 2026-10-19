import { LANDING } from "@/content/landing";

/** "Message me here": opens the WhatsApp chat in a new tab, on every page that offers it. */
export function QuestionsLink({ className }: { className?: string }) {
  return (
    <a
      href={LANDING.questions.href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {LANDING.questions.link}
    </a>
  );
}
