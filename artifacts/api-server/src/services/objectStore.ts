/**
 * objectStore — Replit Object Storage wrapper for image persistence.
 *
 * Provides typed upload/download/delete operations against the project's
 * default bucket (DEFAULT_OBJECT_STORAGE_BUCKET_ID).
 *
 * Auth is handled automatically via the Replit sidecar token endpoint
 * (http://127.0.0.1:1106) — no credentials to manage.
 */

import { Storage } from "@google-cloud/storage";
import { logger } from "../lib/logger";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const _storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
} as ConstructorParameters<typeof Storage>[0]);

function getBucket() {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) {
    throw new Error(
      "DEFAULT_OBJECT_STORAGE_BUCKET_ID is not set — Object Storage bucket not configured"
    );
  }
  return _storage.bucket(bucketId);
}

/**
 * Upload a raw image buffer to Object Storage.
 * objectName should be a path like "images/{uuid}.jpg".
 */
export async function uploadImageBuffer(
  objectName: string,
  buffer: Buffer,
  mimeType: string
): Promise<void> {
  const bucket = getBucket();
  const file = bucket.file(objectName);
  await file.save(buffer, {
    metadata: { contentType: mimeType },
    resumable: false,
  });
  logger.debug({ objectName, bytes: buffer.length }, "[objectStore] Uploaded");
}

/**
 * Download an image from Object Storage.
 * Returns the raw buffer and its MIME type from stored metadata.
 */
export async function downloadImageBuffer(
  objectName: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const bucket = getBucket();
  const file = bucket.file(objectName);
  const [buffer] = await file.download();
  const [meta] = await file.getMetadata();
  return {
    buffer: buffer as Buffer,
    mimeType: (meta.contentType as string | undefined) ?? "image/jpeg",
  };
}

/**
 * Delete an object from Object Storage.
 * Silently ignores missing objects — safe to call on eviction/cleanup.
 */
export async function deleteObjectByName(objectName: string): Promise<void> {
  try {
    const bucket = getBucket();
    const file = bucket.file(objectName);
    await file.delete({ ignoreNotFound: true } as Parameters<typeof file.delete>[0]);
    logger.debug({ objectName }, "[objectStore] Deleted");
  } catch (err) {
    logger.warn({ err, objectName }, "[objectStore] Delete failed (non-fatal)");
  }
}

/**
 * Health probe — checks bucket accessibility using an object-list operation.
 * Uses getFiles(maxResults:1) which only requires storage.objects.list,
 * a permission the Replit sidecar token grants. bucket.exists() requires
 * storage.buckets.get which is not available to the sidecar service account.
 */
export async function checkObjectStorageHealth(): Promise<{
  ok: boolean;
  bucketId: string;
  error?: string;
}> {
  const bucketId =
    process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"] ?? "(not set)";
  try {
    const bucket = getBucket();
    await bucket.getFiles({ maxResults: 1 });
    return { ok: true, bucketId };
  } catch (err) {
    return {
      ok: false,
      bucketId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Returns true if Object Storage is available (bucket ID is configured).
 */
export function isObjectStorageEnabled(): boolean {
  return Boolean(process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"]);
}
