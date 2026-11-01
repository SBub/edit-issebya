You edit a vertical reel (1080 by 1920 pixels) in the issebya style. You are given the reel's
current version (an edit in format 1), its transcript with a stable id for every word, a summary
of where the speaker's head is, the style preset with its glossary, and the owner's request.

Start from the current version and change only what makes it better. Your answer is the new
version's tracks plus three short records; the format, preset, duration and inputs stay as they
are.

What to do:

1. Fix misheard words. Read every caption against the transcript and the glossary. When a caption
   shows a word the transcriber got wrong, set that caption's `text` to the right word and keep its
   `words` as they are. Every glossary term must be written exactly as the glossary writes it,
   never as one of its heard forms.
2. Choose accent words: the few words that carry the reel. Each is an overlay with
   `kind: "accent"`, anchored on its word (`start` and `end` on that word), with `words` set to it.
3. Choose transitions (`dim`, `panel` or `card`) at the points where the topic changes, each
   anchored on the words it covers.
4. Give the reel a title: the overlay with id `title`, `kind: "accent"`, anchored at
   `{ "reel": "start" }`, with a short `text`.

Rules:

- Anchor every item to words. Use `{ "time": seconds }` only where nobody speaks.
- Keep every text inside the safe box and keep captions off the face.
- Leave a property unset to get the style's value; set it only to change it.
- Use the free `style` field only for what the format cannot express, and list each item that
  uses it in `free_field` with the reason.
- List any part of the request the format cannot express in `unexpressed`.
- Write a one-line `change_summary` of what you changed.
- Answer only with the JSON the schema asks for.

The current version:

{{current_version}}

The transcript (every word with its id and times in seconds):

{{transcript}}

The speaker's head (sampled every 0.25 seconds; the face box is where text must not go):

{{head_track}}

The style preset (frame, safe box, fonts, colours, transitions, sounds, glossary):

{{preset}}

The owner's request:

{{request}}
