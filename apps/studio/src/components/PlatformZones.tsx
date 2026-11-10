import { ISSEBYA_PRESET, SAFE_ZONE } from "@edit-issebya/edit";
import { platformZones } from "@/lib/platform-zones";

const ZONES = platformZones(ISSEBYA_PRESET.frame, SAFE_ZONE.box, SAFE_ZONE.notch);

// What TikTok and Instagram cover with their own interface (the margins and
// the button column's notch), shaded over the preview. Takes no clicks and is never part of the built page or the export.
export function PlatformZones() {
  return (
    <div
      aria-hidden="true"
      data-testid="platform-zones"
      className="pointer-events-none absolute inset-0"
    >
      {ZONES.map((zone) => (
        <div
          key={zone.id}
          data-zone={zone.id}
          className="absolute bg-danger/25 outline outline-1 -outline-offset-1 outline-danger/70"
          style={{
            left: `${zone.left}%`,
            top: `${zone.top}%`,
            width: `${zone.width}%`,
            height: `${zone.height}%`,
          }}
        />
      ))}
    </div>
  );
}
