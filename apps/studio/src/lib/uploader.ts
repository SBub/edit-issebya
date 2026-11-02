import AwsS3, { type AwsBody } from "@uppy/aws-s3";
import Uppy from "@uppy/core";
import { MAX_UPLOAD_BYTES, PART_SIZE_BYTES, UPLOAD_ENDPOINT, reelIdOfKey } from "./upload";

// The browser side of the resumable upload: a headless Uppy (no Uppy UI) with
// the AwsS3 plugin in Companion mode, pointed at the studio's own routes
// (app/api/uploads/s3/multipart). Every upload is multipart, 10 MiB parts,
// each PUT straight to its own signed storage URL; a failed part request is
// retried on its own (Uppy retries a network error or a 5xx three times with
// backoff). Created per upload inside the component, never at module load.

type UploadMeta = { bytes: number };

export type UploadOutcome =
  { status: "finished"; reelId: string } | { status: "cancelled" } | { status: "failed" };

export interface Uploader {
  // Resolves when the upload finishes, fails or is cancelled.
  start(file: File, resume?: { key: string; uploadId: string }): Promise<UploadOutcome>;
  // Aborts the upload: storage drops the parts, the reel becomes failed.
  cancel(): void;
  close(): void;
}

export function createUploader(handlers: {
  onProgress(percent: number): void;
  // The multipart upload exists: what a reload needs to resume it.
  onCreated(upload: { reelId: string; key: string; uploadId: string }): void;
}): Uploader {
  const uppy = new Uppy<UploadMeta, AwsBody>({
    autoProceed: false,
    restrictions: { maxNumberOfFiles: 1, maxFileSize: MAX_UPLOAD_BYTES },
  });
  uppy.use(AwsS3<UploadMeta, AwsBody>, {
    companionEndpoint: UPLOAD_ENDPOINT,
    shouldUseMultipart: true,
    getChunkSize: () => PART_SIZE_BYTES,
    // The create request carries the file's size; name and type travel anyway.
    allowedMetaFields: ["bytes"],
    limit: 1,
  });
  let cancelled = false;

  return {
    async start(file, resume) {
      cancelled = false;
      const id = uppy.addFile({
        name: file.name,
        type: file.type,
        data: file,
        meta: { bytes: file.size },
      });
      if (resume) {
        // A file with this state is resumed: the plugin lists the stored
        // parts and sends only the rest.
        uppy.setFileState(id, { s3Multipart: { key: resume.key, uploadId: resume.uploadId } });
      }
      let reported = Boolean(resume);
      const onState = () => {
        if (reported) return;
        const state = uppy.getFile(id)?.s3Multipart;
        const reelId = state ? reelIdOfKey(state.key) : null;
        if (!state || !reelId) return;
        reported = true;
        handlers.onCreated({ reelId, key: state.key, uploadId: state.uploadId });
      };
      uppy.on("state-update", onState);
      uppy.on("progress", handlers.onProgress);
      try {
        const result = await uppy.upload();
        if (cancelled) return { status: "cancelled" };
        const done = result?.successful?.[0];
        const key = done?.response?.body?.key;
        const reelId = typeof key === "string" ? reelIdOfKey(key) : null;
        if (!reelId) return { status: "failed" };
        // Uppy throttles total progress at 500 ms (trailing), so its own 100
        // can arrive after upload() resolves, when this handler is already
        // gone and the page has gone to the reel. Report it here instead.
        handlers.onProgress(100);
        return { status: "finished", reelId };
      } catch {
        return cancelled ? { status: "cancelled" } : { status: "failed" };
      } finally {
        uppy.off("state-update", onState);
        uppy.off("progress", handlers.onProgress);
        if (uppy.getFile(id)) uppy.removeFile(id);
      }
    },

    cancel() {
      cancelled = true;
      uppy.cancelAll();
    },

    close() {
      uppy.destroy();
    },
  };
}
