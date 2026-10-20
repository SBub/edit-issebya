"use client";

import { LANDING } from "@/content/landing";
import { capture } from "@/lib/track";

/** Where a QuestionsLink sits: the `location` property of message_clicked. */
export type MessageLocation = "offer" | "terms" | "privacy";

/** "Message me here": opens the WhatsApp chat in a new tab, on every page that offers it. */
export function QuestionsLink({
  location,
  className,
}: {
  location: MessageLocation;
  className?: string;
}) {
  return (
    <a
      href={LANDING.questions.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => capture("message_clicked", { location })}
      className={className}
    >
      {LANDING.questions.link}
    </a>
  );
}
