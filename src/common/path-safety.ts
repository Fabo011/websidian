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

/** Convert an absolute path back to a forward-slash relative path within root. */
export function toRelative(root: string, absPath: string): string {
  const rootResolved = resolve(root);
  let rel = resolve(absPath).slice(rootResolved.length);
  rel = rel.split(sep).join('/').replace(/^\/+/, '');
  return rel;
}
