import { NestExpressApplication } from '@nestjs/platform-express';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import type { IncomingMessage, ServerResponse } from 'http';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AUTH_COOKIE } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { resolveUploadPath } from '../common/path-safety';
import { VaultService } from '../vault/vault.service';

// tus endpoint path. Kept off `/api` on purpose so the per-user API rate limiter
// (which would otherwise throttle a burst of 50 MB chunk PATCHes) does not apply.
const TUS_PATH = '/files';

// Per-file ceiling enforced by the tus server itself (rejects an over-size
// upload at creation). Mirrors the multer cap the old /import path used.
const MAX_UPLOAD_FILE_MB = Math.max(
  1,
  Number(process.env.MAX_UPLOAD_FILE_MB) || 2048,
);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_FILE_MB * 1024 * 1024;

// Where tus assembles incomplete uploads. Each chunk PATCH appends to the file
// here; on completion we stream it into the user's vault and delete the temp.
const TUS_TMP_DIR =
  process.env.TUS_TMP_DIR?.trim() || join(tmpdir(), 'websidian-tus');

// tus protocol headers that must survive the Cloudflare proxy / CORS. Advertised
// by the tus server and also added to the Nest CORS config in main.ts.
export const TUS_HEADERS = [
  'Tus-Resumable',
  'Upload-Length',
  'Upload-Offset',
  'Upload-Metadata',
  'Upload-Defer-Length',
  'Upload-Concat',
  'Location',
];

/** Read a single cookie value out of a raw Cookie header. */
function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** Request decorated by onIncomingRequest with the authenticated username. */
type TusRequest = IncomingMessage & { woUsername?: string };

/**
 * Stand up the tus resumable-upload server and mount it on the raw Express
 * instance at {@link TUS_PATH}.
 *
 * Uploads are end-to-end encrypted in the browser before the first chunk, so the
 * bytes tus assembles here are already opaque ciphertext. On completion we read
 * the `relativePath` metadata, sanitize it, and stream the file into the user's
 * vault via {@link VaultService.writeStreamAtPath} (which enforces the storage
 * quota and per-user isolation, for both the local and S3 backends).
 */
export function setupTus(app: NestExpressApplication): void {
  const auth = app.get(AuthService, { strict: false });
  const vault = app.get(VaultService, { strict: false });

  const datastore = new FileStore({ directory: TUS_TMP_DIR });

  const server = new Server({
    path: TUS_PATH,
    datastore,
    maxSize: MAX_UPLOAD_BYTES,
    // Same-origin requests carry the auth cookie automatically; advertise the
    // tus headers (Nest's enableCors handles exposing them back to the browser).
    allowedHeaders: TUS_HEADERS,

    // Authenticate every tus request from the auth cookie (httpOnly JWT). A bad
    // or missing token aborts the request with 401 before any bytes are stored.
    onIncomingRequest: async (req: TusRequest, _res, _uploadId) => {
      const token = readCookie(req, AUTH_COOKIE);
      if (!token) {
        throw Object.assign(new Error('Not authenticated.'), {
          status_code: 401,
          body: 'Not authenticated.',
        });
      }
      try {
        const payload = auth.verifyToken(token);
        if (payload.purpose !== 'auth' || !payload.username) {
          throw new Error('bad purpose');
        }
        req.woUsername = payload.username;
      } catch {
        throw Object.assign(new Error('Session expired or invalid.'), {
          status_code: 401,
          body: 'Session expired or invalid.',
        });
      }
    },

    // After the final chunk: move the assembled ciphertext into the vault under
    // its sanitized relative path, then delete the tus temp files.
    onUploadFinish: async (req: TusRequest, res, upload) => {
      const username = req.woUsername;
      if (!username) {
        throw Object.assign(new Error('Not authenticated.'), {
          status_code: 401,
        });
      }

      const meta = upload.metadata || {};
      // relativePath preserves the original folder tree (path minus filename);
      // filename is the leaf. Combine with the destination base, then sanitize
      // the whole thing — the client path is never trusted.
      let safeRel: string;
      try {
        safeRel = resolveUploadPath(
          meta.base || '',
          meta.relativePath || '',
          meta.filename || '',
        );
      } catch {
        throw Object.assign(new Error('Invalid file path metadata.'), {
          status_code: 400,
        });
      }

      const tmpFile = join(TUS_TMP_DIR, upload.id);
      try {
        await vault.writeStreamAtPath(
          username,
          safeRel,
          createReadStream(tmpFile),
          upload.size ?? 0,
        );
      } finally {
        // Remove the assembled file and its sidecar metadata regardless of
        // outcome so the temp dir does not grow unbounded.
        await unlink(tmpFile).catch(() => {});
        await unlink(`${tmpFile}.json`).catch(() => {});
      }
      return res;
    },
  });

  const expressInstance = app.getHttpAdapter().getInstance();
  const handler = (req: IncomingMessage, res: ServerResponse) =>
    server.handle(req, res);
  // Mount the tus server for the collection endpoint and every per-upload URL
  // (/files/{id}). A RegExp is used instead of a string wildcard because Express
  // 5's path-to-regexp rejects a bare `/files/*`. Raw Express instance keeps the
  // body unparsed.
  expressInstance.all(/^\/files(?:\/.*)?$/, handler);
}
