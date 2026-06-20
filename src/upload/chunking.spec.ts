import {
  CHUNK_SIZE,
  CLOUDFLARE_REQUEST_LIMIT,
  ONE_MB,
  planChunks,
} from './chunking';

// Allowance for tus protocol headers (Upload-Offset, Upload-Metadata, etc.) on
// top of a chunk body. Generous on purpose.
const HEADER_ALLOWANCE = 1 * ONE_MB;

describe('upload chunking', () => {
  it('keeps the chunk size (plus header allowance) under the Cloudflare limit', () => {
    expect(CHUNK_SIZE).toBe(50 * ONE_MB);
    expect(CHUNK_SIZE + HEADER_ALLOWANCE).toBeLessThan(
      CLOUDFLARE_REQUEST_LIMIT,
    );
  });

  it('splits a >100 MB file into requests that are each under 100 MB', () => {
    const total = 250 * ONE_MB; // larger than a single allowed request
    const chunks = planChunks(total);

    // Every individual request body stays under the proxy limit, with margin.
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_SIZE);
      expect(c.length + HEADER_ALLOWANCE).toBeLessThan(
        CLOUDFLARE_REQUEST_LIMIT,
      );
    }

    // The chunks are contiguous and reconstruct the whole file exactly.
    expect(chunks[0].offset).toBe(0);
    const reassembled = chunks.reduce((n, c) => n + c.length, 0);
    expect(reassembled).toBe(total);
    expect(chunks).toHaveLength(Math.ceil(total / CHUNK_SIZE));
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].offset).toBe(
        chunks[i - 1].offset + chunks[i - 1].length,
      );
    }
  });

  it('accepts a multi-GB file (the old per-request size cap is gone)', () => {
    const total = 6 * 1024 * ONE_MB; // 6 GB
    const chunks = planChunks(total);
    expect(chunks.length).toBeGreaterThan(100);
    expect(chunks.every((c) => c.length <= CHUNK_SIZE)).toBe(true);
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(total);
  });

  it('handles a file smaller than one chunk as a single request', () => {
    const chunks = planChunks(3 * ONE_MB);
    expect(chunks).toEqual([{ offset: 0, length: 3 * ONE_MB }]);
  });
});
