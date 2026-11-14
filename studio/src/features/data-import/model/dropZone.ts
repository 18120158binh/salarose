import "server-only";
import { HeadObjectCommand, NotFound, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// The S3 drop zone of data import. Shops never get AWS credentials: they upload through a
// presigned PUT for one object (DIM-NFR-03). Studio signs with the credentials of its own runtime,
// found by the SDK's default chain.

export const UPLOAD_URL_SECONDS = 15 * 60;
const CHECKSUM_HEADER = "x-amz-checksum-sha256";

export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** Headers the PUT must send as given. S3 refuses a body whose SHA-256 differs. */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StoredObject {
  byteSize: number;
  /** Lowercase hex, or null when S3 holds no SHA-256 for the object. */
  sha256: string | null;
}

export interface DropZone {
  presignUpload(fileKey: string, byteSize: number, sha256: string, now: Date): Promise<PresignedUpload>;
  /** The stored object's size and SHA-256, or null when there is no object. */
  inspect(fileKey: string): Promise<StoredObject | null>;
  put(fileKey: string, body: Buffer, sha256: string): Promise<void>;
}

/** The bucket from `IMPORTS_BUCKET`, or null when it is unset. */
export function dropZoneBucket(env: Record<string, string | undefined>): string | null {
  return env.IMPORTS_BUCKET?.trim() || null;
}

export function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

function base64ToHex(value: string): string | null {
  // A multipart object's checksum ends in `-<parts>`: it is not the file's SHA-256.
  if (!/^[A-Za-z0-9+/]+=*$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 ? bytes.toString("hex") : null;
}

export function createDropZone(bucket: string, client: S3Client = new S3Client({})): DropZone {
  return {
    async presignUpload(fileKey, byteSize, sha256, now) {
      const checksum = hexToBase64(sha256);
      const command = new PutObjectCommand({ Bucket: bucket, Key: fileKey, ContentLength: byteSize, ChecksumSHA256: checksum });
      const url = await getSignedUrl(client, command, {
        expiresIn: UPLOAD_URL_SECONDS,
        signingDate: now,
        // Signed headers, not query parameters: the PUT must carry the checksum, so S3 checks it.
        unhoistableHeaders: new Set([CHECKSUM_HEADER]),
        signableHeaders: new Set(["content-length", CHECKSUM_HEADER]),
      });
      return {
        url,
        method: "PUT",
        headers: { "Content-Length": String(byteSize), [CHECKSUM_HEADER]: checksum },
        expiresAt: new Date(now.getTime() + UPLOAD_URL_SECONDS * 1000).toISOString(),
      };
    },
    async inspect(fileKey) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: fileKey, ChecksumMode: "ENABLED" }));
        return {
          byteSize: head.ContentLength ?? -1,
          sha256: head.ChecksumSHA256 ? base64ToHex(head.ChecksumSHA256) : null,
        };
      } catch (error) {
        if (error instanceof NotFound || (error as { name?: unknown }).name === "NotFound") return null;
        throw error;
      }
    },
    async put(fileKey, body, sha256) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fileKey,
          Body: body,
          ContentLength: body.byteLength,
          ChecksumSHA256: hexToBase64(sha256),
        }),
      );
    },
  };
}
