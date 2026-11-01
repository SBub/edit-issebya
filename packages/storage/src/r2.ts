import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { type Storage, assertStorageKey } from "./storage.ts";

export interface R2Config {
  accountId: string;
  bucket: string;
  // "eu" for a bucket created with the EU jurisdiction; empty or unset otherwise.
  jurisdiction?: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Tests only: answers requests in place of the network.
  requestHandler?: S3ClientConfig["requestHandler"];
}

// R2's S3 API endpoint (https://developers.cloudflare.com/r2/api/s3/api/ and
// https://developers.cloudflare.com/r2/reference/data-location/#jurisdictional-restrictions):
// a jurisdictional bucket is reached through `<account>.<jurisdiction>.r2...`.
export function r2Endpoint(accountId: string, jurisdiction?: string): string {
  const region = jurisdiction?.trim();
  return region
    ? `https://${accountId}.${region}.r2.cloudflarestorage.com`
    : `https://${accountId}.r2.cloudflarestorage.com`;
}

function isNotFound(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return error.$metadata.httpStatusCode === 404 || error.name === "NotFound";
  }
  return error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey");
}

// `If-None-Match: *` refused because the key is taken.
function isPreconditionFailed(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return error.$metadata.httpStatusCode === 412 || error.name === "PreconditionFailed";
  }
  return error instanceof Error && error.name === "PreconditionFailed";
}

// S3 quotes ETags (`"<md5>"`); callers get the bare value.
function unquote(etag: string | undefined): string | null {
  if (!etag) return null;
  return etag.replace(/^(W\/)?"(.*)"$/, "$2");
}

// One S3 client per call: callers create the storage per request or per worker
// run, never at module load.
export function r2Storage(config: R2Config): Storage {
  const client = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(config.accountId, config.jurisdiction),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // `<endpoint>/<bucket>/<key>`: one host for every bucket, the form R2's docs use.
    forcePathStyle: true,
    // Otherwise the SDK signs a CRC32 checksum header a browser PUT cannot send.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    ...(config.requestHandler ? { requestHandler: config.requestHandler } : {}),
  });
  const Bucket = config.bucket;

  return {
    signUpload(key, { contentType, expiresInSeconds }) {
      const command = new PutObjectCommand({
        Bucket,
        Key: assertStorageKey(key),
        ContentType: contentType,
      });
      return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    },

    signDownload(key, { expiresInSeconds }) {
      const command = new GetObjectCommand({ Bucket, Key: assertStorageKey(key) });
      return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    },

    async head(key, options) {
      try {
        const answer = await client.send(
          new HeadObjectCommand({ Bucket, Key: assertStorageKey(key) }),
          { abortSignal: options?.signal },
        );
        return { bytes: answer.ContentLength ?? 0, etag: unquote(answer.ETag) };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async get(key) {
      try {
        const answer = await client.send(
          new GetObjectCommand({ Bucket, Key: assertStorageKey(key) }),
        );
        return answer.Body ? await answer.Body.transformToByteArray() : new Uint8Array();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async getFile(key, path, options) {
      let answer;
      try {
        answer = await client.send(new GetObjectCommand({ Bucket, Key: assertStorageKey(key) }), {
          abortSignal: options?.signal,
        });
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
      const part = `${path}.part`;
      try {
        const body = answer.Body instanceof Readable ? answer.Body : Readable.from([]);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller's local path
        await pipeline(body, createWriteStream(part), { signal: options?.signal });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller's local path
        await rename(part, path);
      } catch (error) {
        await rm(part, { force: true });
        throw error;
      }
      return true;
    },

    // One PUT (atomic in R2, at most 5 GiB) with `If-None-Match: *`: R2
    // answers 412 when the key is taken and keeps the stored object.
    async putFileIfAbsent(key, path, options) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller's local path
      const { size } = await stat(path);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key: assertStorageKey(key),
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller's local path
            Body: createReadStream(path),
            ContentLength: size,
            ContentType: options?.contentType,
            IfNoneMatch: "*",
          }),
        );
        return "written";
      } catch (error) {
        if (isPreconditionFailed(error)) return "exists";
        throw error;
      }
    },

    // The same conditional PUT as putFileIfAbsent, with the bytes as the body.
    async putIfAbsent(key, body, options) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key: assertStorageKey(key),
            Body: body,
            ContentType: options?.contentType,
            IfNoneMatch: "*",
          }),
        );
        return "written";
      } catch (error) {
        if (isPreconditionFailed(error)) return "exists";
        throw error;
      }
    },

    async put(key, body, options) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: assertStorageKey(key),
          Body: body,
          ContentType: options?.contentType,
        }),
      );
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: assertStorageKey(key) }));
    },

    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys.sort();
    },
  };
}
