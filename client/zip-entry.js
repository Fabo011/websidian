'use strict';

/**
 * Tiny client-side zip helper for web-obsidian, backed by fflate.
 *
 * With end-to-end encryption the server only ever holds ciphertext, so it can
 * neither unpack an imported .zip nor build a meaningful export archive. Those
 * operations now happen in the browser:
 *
 *  - Import: a dropped/selected .zip is expanded here into individual files,
 *    which are then encrypted and uploaded one by one.
 *  - Export: each vault file is fetched, decrypted, and zipped here into a
 *    plaintext archive the user can read anywhere.
 *
 * Bundled with esbuild into /public/js/zip-bundle.js, exposing `window.WOZip`.
 */

const { unzipSync, zipSync, strFromU8 } = require('fflate');

/**
 * Expand a zip archive.
 * @param {ArrayBuffer|Uint8Array} data - the raw .zip bytes
 * @returns {Array<{path: string, bytes: Uint8Array}>} files (directories skipped)
 */
function unzip(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = unzipSync(bytes);
  const out = [];
  for (const name of Object.keys(entries)) {
    const normalized = name.replace(/\\/g, '/');
    // Skip directory entries and path-traversal attempts.
    if (normalized.endsWith('/')) continue;
    if (normalized.split('/').some((seg) => seg === '..')) continue;
    out.push({ path: normalized, bytes: entries[name] });
  }
  return out;
}

/**
 * Build a zip archive from a map of path -> bytes.
 * @param {Record<string, Uint8Array>} files
 * @returns {Uint8Array} the zip bytes
 */
function zip(files) {
  return zipSync(files, { level: 6 });
}

window.WOZip = { unzip, zip, strFromU8 };
