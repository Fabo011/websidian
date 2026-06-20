import { BadRequestException } from '@nestjs/common';
import { resolve, sep } from 'path';

/**
 * Safely resolve a user-supplied relative path inside a trusted root directory.
 * Rejects absolute paths and any attempt to escape the root via `..`.
 */
export function safeResolve(root: string, relPath = ''): string {
  const rootResolved = resolve(root);
  // Strip leading slashes/backslashes so the path is always treated as relative.
  const cleaned = String(relPath).replace(/^[/\\]+/, '');
  const target = resolve(rootResolved, cleaned);

  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new BadRequestException('Invalid path.');
  }
  return target;
}

/**
 * Sanitize a client-supplied relative path (e.g. a tus `relativePath` upload
 * metadata value) into a safe forward-slash path with no traversal.
 *
 * The client is never trusted: a malicious browser could send `../../etc/passwd`,
 * an absolute path, a Windows drive path, or embed a NUL byte to truncate the
 * name at the filesystem layer. We reject those outright rather than silently
 * "fixing" them, so an attack surfaces as a 400 instead of a surprise write.
 *
 * Rules:
 *  - NUL bytes (`\0`) are rejected.
 *  - Backslashes are normalized to `/` (Windows-style paths).
 *  - Leading slashes are stripped (an absolute path is treated as relative).
 *  - `.` segments are dropped; `..` segments are rejected (no escaping up).
 *  - Drive-letter segments (`C:`) are rejected.
 *  - An empty result (e.g. just `/` or `.`) is rejected.
 *
 * Returns the cleaned relative path. Mirrors the client-side normalize in
 * client/zip-entry.js so both ends agree.
 */
export function sanitizeRelPath(relPath: string): string {
  const raw = String(relPath ?? '');
  if (raw.includes('\0')) {
    throw new BadRequestException('Invalid path: null byte.');
  }
  const segments = raw.replace(/\\/g, '/').replace(/^\/+/, '').split('/');

  const clean: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw new BadRequestException('Invalid path: traversal not allowed.');
    }
    if (/^[a-zA-Z]:$/.test(seg)) {
      throw new BadRequestException('Invalid path: absolute path not allowed.');
    }
    clean.push(seg);
  }

  if (clean.length === 0) {
    throw new BadRequestException('Invalid path: empty.');
  }
  return clean.join('/');
}

/**
 * Combine the destination folder, a file's relative folder path, and its
 * filename into a single safe vault-relative path, rejecting any traversal.
 *
 * Used by the tus upload completion hook to reconstruct the original folder tree
 * from client-supplied metadata. Every segment passes through
 * {@link sanitizeRelPath}, so a malicious `relativePath` of `../../etc` cannot
 * escape the user's vault.
 */
export function resolveUploadPath(
  base: string,
  relativePath: string,
  filename: string,
): string {
  if (!filename || !String(filename).length) {
    throw new BadRequestException('Missing file name.');
  }
  const combined = [base, relativePath, filename]
    .map((p) => (p == null ? '' : String(p)))
    .filter((p) => p.length)
    .join('/');
  return sanitizeRelPath(combined);
}

/** Convert an absolute path back to a forward-slash relative path within root. */
export function toRelative(root: string, absPath: string): string {
  const rootResolved = resolve(root);
  let rel = resolve(absPath).slice(rootResolved.length);
  rel = rel.split(sep).join('/').replace(/^\/+/, '');
  return rel;
}
