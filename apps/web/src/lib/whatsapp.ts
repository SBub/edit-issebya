// A WhatsApp click-to-chat link: the number in international form, digits
// only, and the message the chat opens with.
export function whatsAppUrl(number: string, text: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
