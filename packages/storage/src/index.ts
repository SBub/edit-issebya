export {
  type Storage,
  assertStorageKey,
  isDownloadName,
  isStorageKey,
  keyPrefix,
} from "./storage.ts";
export { type R2Config, r2Endpoint, r2Storage } from "./r2.ts";
export { e2eStorageRoot, fakeStorage, isE2EMockStorage } from "./fake.ts";
