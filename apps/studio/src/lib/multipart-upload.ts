import AwsS3 from "@uppy/aws-s3";
import Uppy from "@uppy/core";
import { PART_BYTES, retryDelayMs } from "./upload";
import { type UploadResume, writeResume } from "./upload-resume";

// Browser only: imported from UploadForm, and every Uppy instance is created
// inside startUpload (on submit), never at module load or during render.

export interface SignableRequest {
  method: string;
  key: string;
  uploadId?: string;
  partNumber?: number;
}

export type SignAnswer =
  { status: "signed"; url: string; headers?: Record<string, string> } | { status: string };

class SignedOutError extends Error {
  constructor() {
    super("signed out");
    this.name = "SignedOutError";
  }
}

export interface StartUploadOptions {
  file: File;
  target: { reelId: string; key: string };
  // The upload id of an earlier, unfinished upload of this same file.
  resumeUploadId?: string;
  sign: (request: SignableRequest) => Promise<SignAnswer>;
  store: Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
  onProgress: (percent: number) => void;
  onRetrying: () => void;
  onFailed: () => void;
  onSignedOut: () => void;
  onDone: () => void;
}

export interface RunningUpload {
  cancel: () => void;
  // The multipart upload id once storage handed one out.
  uploadId: () => string | undefined;
}

/**
 * Sends the file to storage as an S3 multipart upload of fixed 10 MiB parts,
 * every request signed by the studio. A failure waits (retryDelayMs) and
 * retries: Uppy lists the parts storage already holds and sends only the rest.
 * Each finished part refreshes the resume record, so a reload can continue.
 */
export function startUpload(options: StartUploadOptions): RunningUpload {
  const { file, target, store } = options;
  let uploadId = options.resumeUploadId;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const uppy = new Uppy({ autoProceed: false });
  uppy.use(AwsS3, {
    shouldUseMultipart: true,
    getChunkSize: () => PART_BYTES,
    limit: 1,
    generateObjectKey: () => target.key,
    async signRequest(request) {
      // Abort runs on the server (abortUpload), never from the browser.
      if (request.method === "DELETE") throw new Error("abort runs on the server");
      const answer = await options.sign({
        method: request.method,
        key: request.key,
        uploadId: "uploadId" in request ? request.uploadId : undefined,
        partNumber: "partNumber" in request ? request.partNumber : undefined,
      });
      if (answer.status === "signed-out") throw new SignedOutError();
      if (!("url" in answer)) throw new Error(`request not signed: ${answer.status}`);
      return { url: answer.url, headers: answer.headers };
    },
  });

  const fileId = uppy.addFile({ name: file.name, type: file.type, data: file, source: "local" });
  if (uploadId) {
    // Uppy resumes a file that carries this state: it lists the parts first.
    uppy.setFileState(fileId, { s3Multipart: { uploadId, key: target.key } });
  }

  function retryNow() {
    if (stopped || retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    uppy.retryUpload(fileId).catch(() => undefined);
  }

  uppy.on("upload-progress", (_file, progress) => {
    if (stopped || !progress.bytesTotal) return;
    options.onProgress(Math.floor(((progress.bytesUploaded ?? 0) / progress.bytesTotal) * 100));
  });

  uppy.on("s3-multipart:part-uploaded", () => {
    if (stopped) return;
    attempt = 0;
    const state = uppy.getFile(fileId)?.s3Multipart;
    if (!state) return;
    uploadId = state.uploadId;
    const record: UploadResume = {
      reelId: target.reelId,
      key: target.key,
      uploadId: state.uploadId,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
    };
    writeResume(store, record);
  });

  uppy.on("upload-error", (_file, error) => {
    if (stopped) return;
    if (error instanceof SignedOutError || error?.name === "SignedOutError") {
      options.onSignedOut();
      return;
    }
    const delay = retryDelayMs(attempt);
    if (delay === null) {
      // The record stays, so picking the file again later resumes.
      options.onFailed();
      return;
    }
    attempt += 1;
    options.onRetrying();
    retryTimer = setTimeout(retryNow, delay);
  });

  uppy.on("upload-success", () => {
    if (stopped) return;
    options.onDone();
  });

  // Back online: retry at once instead of waiting out the backoff.
  window.addEventListener("online", retryNow);

  uppy.upload().catch(() => undefined);

  return {
    cancel() {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      window.removeEventListener("online", retryNow);
      uppy.destroy();
    },
    uploadId: () => uploadId ?? uppy.getFile(fileId)?.s3Multipart?.uploadId,
  };
}
