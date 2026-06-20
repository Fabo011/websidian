/**
 * Canonical chunk-size constants for the resumable upload path, shared by the
 * docs/tests and mirrored by the browser uploader (client/upload-entry.js,
 * `CHUNK_SIZE`). Keep the two in sync.
 *
 * The deployment sits behind a Cloudflare Zero Trust proxy that rejects any HTTP
 * request body over 100 MB. tus sends one chunk per PATCH, so the chunk size
 * (plus a small allowance for protocol headers) must stay safely under that.
 */
export const ONE_MB = 1024 * 1024;

/** Hard ceiling enforced by the Cloudflare proxy on a single request body. */
export const CLOUDFLARE_REQUEST_LIMIT = 100 * ONE_MB;

/** tus chunk size: one chunk per request, well under the proxy limit. */
export const CHUNK_SIZE = 50 * ONE_MB;

/** A single planned chunk: where it starts and how many bytes it carries. */
export interface ChunkPlan {
  offset: number;
  length: number;
}

/**
 * Split a file of `totalBytes` into sequential chunks of at most `chunkSize`.
 * Returns one {@link ChunkPlan} per request tus would make. There is no upper
 * bound on the number of chunks — a multi-GB file simply yields more of them,
 * which is exactly how the old single-request size cap is removed.
 */
export function planChunks(
  totalBytes: number,
  chunkSize: number = CHUNK_SIZE,
): ChunkPlan[] {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) {
    throw new Error('totalBytes must be a non-negative number.');
  }
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error('chunkSize must be a positive number.');
  }
  const chunks: ChunkPlan[] = [];
  for (let offset = 0; offset < totalBytes; offset += chunkSize) {
    chunks.push({
      offset,
      length: Math.min(chunkSize, totalBytes - offset),
    });
  }
  return chunks;
}
