/** @jest-environment node */
import { HeadObjectCommand, NotFound, S3Client } from "@aws-sdk/client-s3";
import { createDropZone } from "../dropZone";

jest.mock("server-only", () => ({}));

// Signing is offline, so the real SDK signs with these documented example credentials.
const client = new S3Client({
  region: "ap-southeast-1",
  credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
});
const SHA = "9f2c41d0e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1";
const KEY = "imports/incoming/shop-erp/orders/2026-11-14/5f0c8a2e-1b7d-4c39-9a51-2d3e4f5a6b7c.csv.gz";

describe("drop zone", () => {
  it("presigns a PUT of one object for 15 minutes that signs the size and the SHA-256, and holds no secret (DIM-NFR-03)", async () => {
    const now = new Date("2026-11-14T01:40:00Z");
    const upload = await createDropZone("drop-zone", client).presignUpload(KEY, 18204411, SHA, now);
    const url = new URL(upload.url);

    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.hostname).toContain("drop-zone");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "host", "x-amz-checksum-sha256"]),
    );
    expect(url.searchParams.has("x-amz-checksum-sha256")).toBe(false);
    expect(upload.url).not.toContain("wJalrXUtnFEMI");
    expect(upload).toMatchObject({
      method: "PUT",
      headers: { "Content-Length": "18204411", "x-amz-checksum-sha256": Buffer.from(SHA, "hex").toString("base64") },
      expiresAt: "2026-11-14T01:55:00.000Z",
    });
  });

  it("reads the object's size and its SHA-256 as hex", async () => {
    const send = jest.spyOn(client, "send").mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(HeadObjectCommand);
      expect((command as HeadObjectCommand).input).toEqual({ Bucket: "drop-zone", Key: KEY, ChecksumMode: "ENABLED" });
      return { ContentLength: 18204411, ChecksumSHA256: Buffer.from(SHA, "hex").toString("base64") };
    });

    expect(await createDropZone("drop-zone", client).inspect(KEY)).toEqual({ byteSize: 18204411, sha256: SHA });
    send.mockRestore();
  });

  it("reads no SHA-256 for a multipart checksum, and null for a missing object", async () => {
    const send = jest
      .spyOn(client, "send")
      .mockImplementationOnce(async () => ({ ContentLength: 10, ChecksumSHA256: "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=-2" }))
      .mockImplementationOnce(async () => {
        throw new NotFound({ message: "Not Found", $metadata: {} });
      });
    const dropZone = createDropZone("drop-zone", client);

    expect(await dropZone.inspect(KEY)).toEqual({ byteSize: 10, sha256: null });
    expect(await dropZone.inspect(KEY)).toBeNull();
    send.mockRestore();
  });
});
