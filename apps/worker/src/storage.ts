import {
  type Storage,
  e2eStorageRoot,
  fakeStorage,
  isE2EMockStorage,
  r2Storage,
} from "@edit-issebya/storage";

type Env = Record<string, string | undefined>;

// The worker's storage: the folder fake under the exact flag (the same folder
// the studio's mock route writes), else R2 with the worker's own keys.
export function workerStorage(env: Env = process.env): Storage {
  if (isE2EMockStorage(env)) {
    // The worker never signs uploads, so the URL base is unused.
    return fakeStorage({ root: e2eStorageRoot(), uploadUrlBase: "" });
  }
  const values = {
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID?.trim(),
    R2_BUCKET: env.R2_BUCKET?.trim(),
    R2_WORKER_ACCESS_KEY_ID: env.R2_WORKER_ACCESS_KEY_ID?.trim(),
    R2_WORKER_SECRET_ACCESS_KEY: env.R2_WORKER_SECRET_ACCESS_KEY?.trim(),
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`worker: missing ${missing.join(", ")}`);
  return r2Storage({
    accountId: values.R2_ACCOUNT_ID as string,
    bucket: values.R2_BUCKET as string,
    jurisdiction: env.R2_JURISDICTION,
    accessKeyId: values.R2_WORKER_ACCESS_KEY_ID as string,
    secretAccessKey: values.R2_WORKER_SECRET_ACCESS_KEY as string,
  });
}
