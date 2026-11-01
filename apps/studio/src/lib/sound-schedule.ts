// What the scheduler needs of a sound hit (`SoundHit` in @edit-issebya/edit).
interface Hit {
  id: string;
  at: number;
  path: string;
  gain: number;
}

export interface ScheduledSound {
  id: string;
  path: string;
  gain: number;
  // AudioContext time to start it at.
  when: number;
}

// The hits to start when the player's clock starts at `playerTime` and the
// audio context reads `contextTime` at that moment: every hit from that point
// on, each at its offset from the start. A hit that has already begun is
// skipped, never started mid-click.
export function scheduleFrom(
  hits: readonly Hit[],
  playerTime: number,
  contextTime: number,
): ScheduledSound[] {
  return hits
    .filter((hit) => hit.at >= playerTime)
    .map((hit) => ({
      id: hit.id,
      path: hit.path,
      gain: hit.gain,
      when: contextTime + (hit.at - playerTime),
    }));
}
