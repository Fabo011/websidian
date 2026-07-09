'use strict';

/*
 * Pure, framework-free helpers shared by the browser app and the Jest frontend
 * unit tests. Nothing here touches the DOM, network, or app globals — every
 * dependency (limits, translator, header) is passed in — so the same code that
 * ships to the browser is exercised directly by `test-frontend/*.spec.js`.
 *
 * Dual-mode: attaches to `window.WOUtil` in the browser and to `module.exports`
 * under Node/Jest. Load this BEFORE app.js in the page (see views/app.ejs).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.WOUtil = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Native CSV header. Mirrors Linky's export format (see app.js history).
  const WEBLINKS_HEADER = [
    'linkname',
    'linkdescription',
    'category',
    'link',
    'linkusername',
    'contactname',
    'contactphonenumber',
    'contactemail',
    'notes',
  ];

  // Human-readable byte size, e.g. 360 MB / 1.4 GB.
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return (v >= 10 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  }

  // Validate a selection of { path, size } items against the upload limits.
  // Returns a ready-to-show (translated) error message, or '' when the
  // selection is fine. `limits` = { maxImportTotalBytes, maxImportFiles,
  // maxUploadFileBytes }; `t` is the i18n translator.
  function uploadLimitError(items, limits, t) {
    const totalBytes = items.reduce((n, it) => n + it.size, 0);
    if (totalBytes > limits.maxImportTotalBytes) {
      return t('import_total_too_large', { total: fmtSize(totalBytes) });
    }
    if (items.length > limits.maxImportFiles) {
      return t('too_many_files', { count: items.length.toLocaleString() });
    }
    const big = items.find((it) => it.size > limits.maxUploadFileBytes);
    if (big) {
      return t('file_too_large', { name: big.path.split('/').pop() });
    }
    return '';
  }

  /** Parse RFC 4180-style CSV text into an array of string-cell rows. */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
    // Flush the trailing cell/row unless the file ended on a clean newline.
    if (cell !== '' || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows;
  }

  /** Quote a single CSV cell when it contains a comma, quote or newline. */
  function csvCell(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /** Accept only http(s) URLs; reject javascript:, data:, etc. */
  function sanitizeLinkUrl(value) {
    const s = (value || '').trim();
    if (!s) return '';
    try {
      const u = new URL(s);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return u.href;
      }
    } catch {
      // Allow a bare host like "example.com" by retrying with https://.
      if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) {
        return sanitizeLinkUrl('https://' + s);
      }
    }
    return '';
  }

  /** Serialize link records into Linky-compatible CSV text. */
  function serializeWeblinks(links) {
    const lines = [WEBLINKS_HEADER.join(',')];
    for (const l of links) {
      lines.push(
        [
          l.name,
          l.description,
          l.category,
          l.url,
          l.username,
          l.contactName,
          l.contactPhone,
          l.contactEmail,
          l.notes,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Turn CSV text into link records. Maps by header name so both the native
   * format and a full Linky export (extra columns) are understood. Rows without
   * a usable http(s) URL are skipped.
   */
  function csvToLinks(text) {
    const rows = parseCsv(text);
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const idx = (name) => header.indexOf(name);
    const iName = idx('linkname');
    const iDesc = idx('linkdescription');
    const iUrl = idx('link');
    const iCat = idx('category');
    const iUser = idx('linkusername');
    const iCName = idx('contactname');
    const iCPhone = idx('contactphonenumber');
    const iCEmail = idx('contactemail');
    const iNotes = idx('notes');
    // If the first row is not a recognizable header, treat every row as data
    // with a simple name,url[,description[,category]] layout.
    const hasHeader = iUrl !== -1 || iName !== -1;
    const out = [];
    const start = hasHeader ? 1 : 0;
    for (let r = start; r < rows.length; r++) {
      const cells = rows[r];
      if (!cells.length || cells.every((c) => c.trim() === '')) continue;
      const get = (i, fallback) =>
        (i !== -1 && i < cells.length ? cells[i] : cells[fallback] || '').trim();
      const url = sanitizeLinkUrl(get(iUrl, 1));
      if (!url) continue;
      out.push({
        name: get(iName, 0) || url,
        description: get(iDesc, 2),
        url,
        category: get(iCat, 3),
        username: get(iUser, -1),
        contactName: get(iCName, -1),
        contactPhone: get(iCPhone, -1),
        contactEmail: get(iCEmail, -1),
        notes: get(iNotes, -1),
      });
    }
    return out;
  }

  return {
    WEBLINKS_HEADER,
    fmtSize,
    uploadLimitError,
    parseCsv,
    csvCell,
    sanitizeLinkUrl,
    serializeWeblinks,
    csvToLinks,
  };
});
