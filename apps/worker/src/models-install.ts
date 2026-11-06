// `yarn workspace @edit-issebya/worker models:install`: downloads the cut-out's
// MODNet model once into WORKER_MODELS_DIR (default ~/.edit-issebya-worker/models)
// and checks it against the pinned size and SHA-256; a model already there
// with that hash is kept. Exits 1 on any failure, the partial file removed.
import { MODNET_MODEL, installModel, modnetModelPath } from "./cutout/modnet-model.ts";

const path = modnetModelPath(process.env);
try {
  const what = await installModel(path);
  console.log(
    `${what === "installed" ? "installed" : "already installed"}: ${path} (SHA-256 ${MODNET_MODEL.sha256.slice(0, 8)})`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
