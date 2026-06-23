/**
 * Junk-file exclusion for uploads.
 *
 * OS file managers (notably macOS Finder) litter folders with metadata sidecar
 * files — AppleDouble `._*` resource forks, `.DS_Store`, Windows `Thumbs.db`,
 * etc. They carry no value in a knowledge vault but still consume storage and
 * clutter the tree. We reject them at upload time, both client-side (so the user
 * never sees a failed-upload row) and server-side (the authoritative guard for
 * any non-browser client).
 *
 * The set is configurable via the `UPLOAD_EXCLUDE_PATTERNS` env var: a
 * comma-separated list of case-insensitive glob patterns matched against the
 * leaf filename. `*` is the only wildcard. An empty value disables exclusion.
 */

/** Default patterns: the common OS junk no one needs in a vault. */
export const DEFAULT_UPLOAD_EXCLUDE_PATTERNS =
  '._*,.DS_Store,.AppleDouble,.LSOverride,.Spotlight-V100,.Trashes,.fseventsd,.apdisk,Thumbs.db,ehthumbs.db,desktop.ini,.localized';

/**
 * Parse the comma-separated env value into a trimmed pattern list. `undefined`
 * (var unset) falls back to {@link DEFAULT_UPLOAD_EXCLUDE_PATTERNS}; an empty or
 * whitespace-only value yields `[]` (exclusion disabled).
 */
export function parseUploadExcludePatterns(raw: string | undefined): string[] {
  const source = raw === undefined ? DEFAULT_UPLOAD_EXCLUDE_PATTERNS : raw;
  return source
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Compile one glob pattern into an anchored, case-insensitive RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Build a matcher that returns true when the given path's leaf filename matches
 * any of the patterns. The path may include folders; only the final segment is
 * tested.
 */
export function buildUploadExcludeMatcher(
  patterns: string[],
): (filename: string) => boolean {
  const regexps = patterns.map(patternToRegExp);
  return (filename: string): boolean => {
    const leaf = filename.split('/').pop() ?? filename;
    return regexps.some((re) => re.test(leaf));
  };
}
