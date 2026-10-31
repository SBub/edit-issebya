import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
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
        return { bytes: answer.ContentLength ?? 0 };
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
