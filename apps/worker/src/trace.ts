// `yarn workspace @edit-issebya/worker trace [<reel id>] [--table]`: what
// Claude picked in every version of a reel, beside the script (the default),
// or with --table each pick beside what the layout engine did
// (app_docs/decide-step.md). With no reel id, the latest reels.
// Read-only: it reads the `versions` rows and the AI records, writes nothing.
import { type EngineNote, transcriptSchema } from "@edit-issebya/edit";
import { workerConfig } from "./config.ts";
import { aiRecordKey, type AiRecord } from "./decide/ai-record.ts";
import {
  answerJson,
  buildTrace,
  formatScript,
  formatTrace,
  hookOf,
  type TracedAnswer,
} from "./decision-trace.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";

const config = workerConfig();
const db = workerSupabase(config);
const storage = workerStorage();
const args = process.argv.slice(2);
const table = args.includes("--table");
const reelId = args.find((arg) => !arg.startsWith("--"));

async function readJson(key: string): Promise<unknown> {
  const bytes = await storage.get(key);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as unknown) : null;
}

if (!reelId) {
  const { data, error } = await db
    .from("reels")
    .select("id, status, created_at")
    .order("created_at", { ascending: false })
    .limit(15);
  if (error) throw new Error(`trace: ${error.message}`);
  for (const reel of data) console.log(`${reel.id}  ${reel.created_at}  ${reel.status}`);
  console.log("\nRun again with a reel id for its trace.");
  process.exit(0);
}

const { data: versions, error } = await db
  .from("versions")
  .select("id, number, inputs, engine_record")
  .eq("reel_id", reelId)
  .order("number");
if (error) throw new Error(`trace: ${error.message}`);
if (versions.length === 0) console.log(`No versions for reel ${reelId}.`);

// Each library photo by a short name: its first tag, else its description's
// first words.
const photoIds = new Set<string>();
const photoNames = new Map<string, string>();

for (const version of versions) {
  const title = `\n== reel ${reelId}, version ${version.number} ==`;
  const record = (await readJson(
    aiRecordKey(config.keyPrefix, reelId, version.id),
  )) as AiRecord | null;
  if (!record) {
    console.log(`${title}\nno AI record (made by an older worker, or saved without a decide)`);
    continue;
  }
  const decide = record.calls
    .filter((call) => call.role === "decide")
    .map((call) => answerJson(call.answerText))
    .filter((answer): answer is TracedAnswer => answer !== null && typeof answer === "object");
  const decided = decide.at(-1);
  if (!decided) {
    console.log(`${title}\nno readable decide answer in the AI record`);
    continue;
  }
  // The hook from its own call; an older record's hook is its decide answer's.
  const answer: TracedAnswer = { ...decided, hook: hookOf(record.calls, decided) };
  const ref = version.inputs.transcript as { step: string; fingerprint: string; file: string };
  const transcript = transcriptSchema.parse(
    await readJson(cacheKey(config.keyPrefix, ref.step, ref.fingerprint, ref.file)),
  );
  const attempts = decide.length > 1 ? `, ${decide.length} decide attempts` : "";
  const heading = `${title} (prompt ${record.prompt_version}${attempts})`;
  if (!table) {
    const wanted = (answer.photos ?? []).map((photo) => photo.photo_id);
    const missing = wanted.filter((id) => !photoIds.has(id));
    if (missing.length > 0) {
      const { data: photos } = await db
        .from("photos")
        .select("id, description, tags")
        .in("id", missing);
      for (const id of missing) photoIds.add(id);
      for (const photo of photos ?? []) {
        const tags = photo.tags as string[];
        const short = (photo.description as string | null)?.split(/\s+/).slice(0, 4).join(" ");
        const name = tags[0] ?? short;
        if (name) photoNames.set(photo.id as string, name);
      }
    }
    console.log(formatScript(heading, answer, transcript.words, photoNames));
    continue;
  }
  const engine = version.engine_record as EngineNote[];
  const trace = buildTrace(answer, engine, transcript.words);
  const fixes = (answer.word_fixes ?? []).map((fix) => {
    const said = transcript.words.find((word) => word.id === fix.word)?.text.trim() ?? fix.word;
    return `"${said}" -> "${fix.text}"`;
  });
  console.log(formatTrace(heading, trace, fixes));
}
