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

  // ---- Notes: daily notes, templates, calendar -------------------------------

  /**
   * Normalize a user-typed vault folder path: trim, use forward slashes,
   * collapse repeats, drop leading/trailing slashes and any '.'/'..' segments
   * so it can never escape the vault. Returns '' for an empty/invalid path.
   */
  function normalizeVaultPath(input) {
    if (typeof input !== 'string') return '';
    const parts = input
      .replace(/\\/g, '/')
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s && s !== '.' && s !== '..');
    return parts.join('/');
  }

  // Zero-pad a number to 2 digits (local date/time formatting).
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Local calendar day key 'YYYY-MM-DD' for a Date (used as daily-note name). */
  function formatDailyDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /**
   * Substitute the supported template placeholders. `now` defaults to the
   * current time; `title` is the new note's name without extension.
   *   {{date}} -> YYYY-MM-DD   {{time}} -> HH:MM   {{title}} -> note title
   */
  function applyTemplate(text, opts) {
    const o = opts || {};
    const now = o.now instanceof Date ? o.now : new Date();
    const date = formatDailyDate(now);
    const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const title = o.title == null ? '' : String(o.title);
    return String(text == null ? '' : text)
      .replace(/\{\{\s*date\s*\}\}/gi, date)
      .replace(/\{\{\s*time\s*\}\}/gi, time)
      .replace(/\{\{\s*title\s*\}\}/gi, title);
  }

  /**
   * Parse the millisecond mtime out of a vault file's opaque `version` token,
   * whose format is `${Math.round(mtimeMs)}-${size}` (see VaultService). Returns
   * NaN when the token is missing or malformed so callers can skip the file.
   */
  function mtimeFromVersion(version) {
    if (typeof version !== 'string') return NaN;
    const ms = Number(version.split('-')[0]);
    return Number.isFinite(ms) ? ms : NaN;
  }

  /**
   * Bucket vault files by the local day they were last changed. `files` is the
   * `/api/files` payload: `[{ path, version }]`. Returns a Map keyed by
   * 'YYYY-MM-DD' -> array of file paths (sorted), skipping reserved/internal
   * paths and files with an unreadable version. Pure and DOM-free.
   */
  function filesByDay(files, reservedPrefixes) {
    const reserved = reservedPrefixes || [];
    const map = new Map();
    for (const f of files || []) {
      const path = f && f.path;
      if (!path) continue;
      if (reserved.some((p) => path === p || path.startsWith(p + '/'))) continue;
      const ms = mtimeFromVersion(f.version);
      if (!Number.isFinite(ms)) continue;
      const key = formatDailyDate(new Date(ms));
      const arr = map.get(key);
      if (arr) arr.push(path);
      else map.set(key, [path]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }
    return map;
  }

  /**
   * Build a month-grid model for the calendar. `year` is full (e.g. 2026),
   * `month` is 0-based. `counts` maps 'YYYY-MM-DD' -> file count. Weeks start on
   * Monday. Returns { year, month, weeks: [[{ key, day, inMonth, count }]] }
   * with leading/trailing days from adjacent months to fill 6 rows. Pure.
   */
  function buildCalendarModel(year, month, counts) {
    const c = counts || new Map();
    const first = new Date(year, month, 1);
    // JS getDay(): 0=Sun..6=Sat. Shift so Monday=0.
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - lead);
    const weeks = [];
    for (let w = 0; w < 6; w++) {
      const row = [];
      for (let d = 0; d < 7; d++) {
        const cur = new Date(
          start.getFullYear(),
          start.getMonth(),
          start.getDate() + w * 7 + d,
        );
        const key = formatDailyDate(cur);
        const cnt = c.get(key);
        row.push({
          key,
          day: cur.getDate(),
          inMonth: cur.getMonth() === month,
          count: (cnt && (cnt.length != null ? cnt.length : cnt)) || 0,
        });
      }
      weeks.push(row);
    }
    return { year, month, weeks };
  }

  /* ---------------------------------------------------------------------
   * Kanban boards
   *
   * A board is a plain JSON object persisted as a `.kanban` file in the vault:
   *   { version: 1, columns: [ { id, title, cards: [ { id, title, description } ] } ] }
   * The functions below are the whole data model — pure, DOM-free, so the
   * browser renderer (kanban.js) and the Jest tests share the exact same logic.
   * Every mutating helper returns the (same, mutated) board for chaining.
   * ------------------------------------------------------------------------ */

  // Collision-resistant short id (time + randomness). Prefix keeps column vs
  // card ids readable when eyeballing a saved board file.
  function kanbanId(prefix) {
    return (
      (prefix || 'k') +
      '_' +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
    );
  }

  // A fresh board. `titles` seeds the starting columns (already localized by the
  // caller); falls back to a generic To Do / In Progress / Done.
  function kanbanDefaultBoard(titles) {
    const cols = titles && titles.length ? titles : ['To Do', 'In Progress', 'Done'];
    return {
      version: 1,
      columns: cols.map((title) => ({ id: kanbanId('c'), title, cards: [] })),
    };
  }

  // Coerce arbitrary/untrusted content into a valid board. Never throws: bad or
  // empty input yields an empty (but valid) board so the UI always renders.
  function kanbanNormalize(input) {
    let obj = input;
    if (typeof input === 'string') {
      const s = input.trim();
      if (!s) return { version: 1, columns: [] };
      try {
        obj = JSON.parse(s);
      } catch {
        return { version: 1, columns: [] };
      }
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.columns)) {
      return { version: 1, columns: [] };
    }
    const columns = obj.columns
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        id: typeof c.id === 'string' && c.id ? c.id : kanbanId('c'),
        title: typeof c.title === 'string' ? c.title : '',
        cards: Array.isArray(c.cards)
          ? c.cards
              .filter((k) => k && typeof k === 'object')
              .map((k) => ({
                id: typeof k.id === 'string' && k.id ? k.id : kanbanId('k'),
                title: typeof k.title === 'string' ? k.title : '',
                description:
                  typeof k.description === 'string' ? k.description : '',
                // Vault path of a linked note (e.g. "Notes/Spec.md"), an external
                // URL, and an optional due date (YYYY-MM-DD) shown on the calendar.
                link: typeof k.link === 'string' ? k.link : '',
                url: typeof k.url === 'string' ? k.url : '',
                due: typeof k.due === 'string' ? k.due : '',
              }))
          : [],
      }));
    return { version: 1, columns };
  }

  function kanbanSerialize(board) {
    return JSON.stringify(kanbanNormalize(board), null, 2);
  }

  function kanbanColumn(board, colId) {
    return board.columns.find((c) => c.id === colId) || null;
  }

  function kanbanAddColumn(board, title) {
    board.columns.push({ id: kanbanId('c'), title: title || '', cards: [] });
    return board;
  }

  function kanbanRenameColumn(board, colId, title) {
    const col = kanbanColumn(board, colId);
    if (col) col.title = title;
    return board;
  }

  function kanbanRemoveColumn(board, colId) {
    board.columns = board.columns.filter((c) => c.id !== colId);
    return board;
  }

  // Move a column to `toIndex` (clamped). Used by column drag-reordering.
  function kanbanMoveColumn(board, colId, toIndex) {
    const from = board.columns.findIndex((c) => c.id === colId);
    if (from < 0) return board;
    const [col] = board.columns.splice(from, 1);
    const idx = Math.max(0, Math.min(toIndex, board.columns.length));
    board.columns.splice(idx, 0, col);
    return board;
  }

  function kanbanAddCard(board, colId, card) {
    const col = kanbanColumn(board, colId);
    if (!col) return board;
    col.cards.push({
      id: kanbanId('k'),
      title: (card && card.title) || '',
      description: (card && card.description) || '',
      link: (card && card.link) || '',
      url: (card && card.url) || '',
      due: (card && card.due) || '',
    });
    return board;
  }

  function kanbanUpdateCard(board, cardId, patch) {
    for (const col of board.columns) {
      const card = col.cards.find((k) => k.id === cardId);
      if (card) {
        for (const f of ['title', 'description', 'link', 'url', 'due']) {
          if (patch && typeof patch[f] === 'string') card[f] = patch[f];
        }
        return board;
      }
    }
    return board;
  }

  // Every dated card across a board, flattened for the calendar. `boardPath`
  // is echoed back so the calendar can open the owning .kanban file.
  function kanbanDueEntries(board, boardPath) {
    const out = [];
    for (const col of kanbanNormalize(board).columns) {
      for (const card of col.cards) {
        if (card.due) {
          out.push({
            boardPath: boardPath || '',
            due: card.due,
            column: col.title,
            title: card.title,
            cardId: card.id,
          });
        }
      }
    }
    return out;
  }

  function kanbanRemoveCard(board, cardId) {
    for (const col of board.columns) {
      const i = col.cards.findIndex((k) => k.id === cardId);
      if (i >= 0) {
        col.cards.splice(i, 1);
        return board;
      }
    }
    return board;
  }

  // Move a card to `toColId` at `toIndex` (clamped). Drag-and-drop between
  // columns and reordering within a column both funnel through here.
  function kanbanMoveCard(board, cardId, toColId, toIndex) {
    let card = null;
    for (const col of board.columns) {
      const i = col.cards.findIndex((k) => k.id === cardId);
      if (i >= 0) {
        [card] = col.cards.splice(i, 1);
        break;
      }
    }
    if (!card) return board;
    const dest = kanbanColumn(board, toColId);
    if (!dest) return board; // card removed if destination vanished — caller guards
    const idx =
      toIndex == null ? dest.cards.length : Math.max(0, Math.min(toIndex, dest.cards.length));
    dest.cards.splice(idx, 0, card);
    return board;
  }

  return {
    WEBLINKS_HEADER,
    kanbanId,
    kanbanDefaultBoard,
    kanbanNormalize,
    kanbanSerialize,
    kanbanColumn,
    kanbanAddColumn,
    kanbanRenameColumn,
    kanbanRemoveColumn,
    kanbanMoveColumn,
    kanbanAddCard,
    kanbanUpdateCard,
    kanbanRemoveCard,
    kanbanMoveCard,
    kanbanDueEntries,
    fmtSize,
    uploadLimitError,
    parseCsv,
    csvCell,
    sanitizeLinkUrl,
    serializeWeblinks,
    csvToLinks,
    normalizeVaultPath,
    formatDailyDate,
    applyTemplate,
    mtimeFromVersion,
    filesByDay,
    buildCalendarModel,
  };
});
