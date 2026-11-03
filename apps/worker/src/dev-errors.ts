import { errorLogPath, formatLastFailures } from "./dev-error-log.ts";

// `yarn dev:studio errors` (through `yarn workspace @edit-issebya/worker
// dev:errors`): the development error log's path and its last failures in
// plain words (app_docs/error-tracking.md).
const path = errorLogPath(process.env);
console.log(`Worker errors: ${path}`);
console.log(formatLastFailures(path));
