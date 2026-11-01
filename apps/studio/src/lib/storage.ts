import {
  type Storage,
  e2eStorageRoot,
  fakeStorage,
  isE2EMockStorage,
  keyPrefix,
  r2Storage,
} from "@edit-issebya/storage";

type Env = Record<string, string | undefined>;

// The mock route the fake's signed URLs point at (the browser PUTs there under
// E2E_MOCK_STORAGE=true, in place of R2).
export const MOCK_UPLOAD_URL_BASE = "/studio/api/e2e-storage-mock/";

// The studio's storage, read per call (never at module load): the fake under
// the exact flag, R2 with the studio's own keys, or null when unconfigured. It
// never reads the worker's keys.
export function studioStorage(env: Env = process.env): Storage | null {
  if (isE2EMockStorage(env)) {
    return fakeStorage({ root: e2eStorageRoot(), uploadUrlBase: MOCK_UPLOAD_URL_BASE });
  }
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET?.trim();
  const accessKeyId = env.R2_STUDIO_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_STUDIO_SECRET_ACCESS_KEY?.trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  if (keyPrefix(env) === null) return null;
  return r2Storage({
    accountId,
    bucket,
    jurisdiction: env.R2_JURISDICTION,
    accessKeyId,
    secretAccessKey,
  });
}
