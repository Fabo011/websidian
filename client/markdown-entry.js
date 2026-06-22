'use strict';

/**
 * Client-side markdown renderer for websidian.
 *
 * This replaces the former server-side `/api/render` and `/api/highlight`
 * endpoints. With end-to-end encryption the server can no longer read note
 * contents, so rendering happens entirely in the browser where the decrypted
 * text and vault key live.
 *
 * It mirrors the previous server behaviour: Obsidian-style wikilinks
 * (`[[note]]`, `![[image.png]]`), task lists, syntax highlighting, and
 * attachment resolution against the vault file index. Attachment `src`/`href`
 * values are produced via a caller-supplied `attachmentSrc(relPath)` callback
 * so the host app can substitute a *decrypted blob URL* (since the raw bytes on
 * the server are ciphertext and cannot be used directly in an <img>/<iframe>).
 *
 * Bundled with esbuild into /public/js/markdown-bundle.js, exposing
 * `window.WOMarkdown`.
 */

const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js/lib/common');
const createDOMPurify = require('dompurify');

const DOMPurify = createDOMPurify(window);

// Allow our internal data attributes and the blob: scheme used for decrypted
// attachment previews to survive sanitization.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const PURIFY_CONFIG = {
  ADD_TAGS: ['iframe'],
  ADD_ATTR: [
    'data-target',
    'data-wo-att',
    'data-task-index',
    'loading',
    'target',
    'allowfullscreen',
  ],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto|tel|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

function extname(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}
function extOf(name) {
  return extname(name).replace(/^\./, '');
}
function basenameNoExt(p) {
  const base = p.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}
function basename(p) {
  return (p.split('/').pop() || '').toLowerCase();
}
function normalizePath(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeMd(text) {
  return String(text).replace(/([\\[\]()])/g, '\\$1');
}

function langForExt(ext) {
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', php: 'php',
    java: 'java', kt: 'kotlin', kts: 'kotlin', go: 'go', rs: 'rust', c: 'c',
    h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
    scala: 'scala', lua: 'lua', pl: 'perl', r: 'r', sql: 'sql', sh: 'bash',
    bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell', bat: 'dos',
    dockerfile: 'dockerfile', gradle: 'gradle', tex: 'latex', html: 'xml',
    htm: 'xml', xml: 'xml', css: 'css', scss: 'scss', sass: 'scss',
    less: 'less', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini',
    ini: 'ini', conf: 'ini', cfg: 'ini', properties: 'ini', md: 'markdown',
    markdown: 'markdown',
  };
  return map[String(ext).toLowerCase()];
}

function highlightToHtml(code, lang) {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch (e) {
      /* fall through */
    }
  }
  try {
    return hljs.highlightAuto(code).value;
  } catch (e) {
    return escapeHtml(code);
  }
}

/**
 * Build a vault file index from the flat list of relative paths the client
 * already holds (the tree is plaintext — only contents are encrypted).
 */
function buildIndex(relPaths) {
  const files = new Map(); // lc path -> actual
  const notesByName = new Map(); // lc note basename -> actual
  const filesByName = new Map(); // lc basename+ext -> actual
  for (const rel of relPaths) {
    files.set(rel.toLowerCase(), rel);
    const baseExt = basename(rel);
    if (!filesByName.has(baseExt)) filesByName.set(baseExt, rel);
    const ext = extOf(rel);
    if (ext === 'md' || ext === 'markdown') {
      const base = basenameNoExt(rel);
      if (!notesByName.has(base)) notesByName.set(base, rel);
    }
  }
  return { files, notesByName, filesByName };
}

function splitTarget(inner) {
  const idx = inner.indexOf('|');
  if (idx >= 0) {
    return { target: inner.slice(0, idx).trim(), alias: inner.slice(idx + 1).trim() };
  }
  return { target: inner.trim() };
}

function preprocessWikilinks(content) {
  let out = content.replace(/!\[\[([^\]\n]+)\]\]/g, (_m, inner) => {
    const { target, alias } = splitTarget(inner);
    return `![${escapeMd(alias != null ? alias : target)}](wo-att:${encodeURIComponent(target)})`;
  });
  out = out.replace(/\[\[([^\]\n]+)\]\]/g, (_m, inner) => {
    const { target, alias } = splitTarget(inner);
    return `[${escapeMd(alias != null ? alias : target)}](wo-wiki:${encodeURIComponent(target)})`;
  });
  return out;
}

function resolveLink(target, ctx, preferNote) {
  if (!ctx) return { relPath: target, exists: false };
  const clean = target.replace(/^\.\//, '').split('#')[0].trim();
  const joinDir = (p) => (ctx.noteDir ? normalizePath(`${ctx.noteDir}/${p}`) : normalizePath(p));
  const candidates = [clean, joinDir(clean)];
  if (!extname(clean)) {
    candidates.push(`${clean}.md`, joinDir(`${clean}.md`));
  }
  for (const cand of candidates) {
    const key = cand.replace(/^\.\//, '').toLowerCase();
    const actual = ctx.index.files.get(key);
    if (actual) return { relPath: actual, exists: true };
  }
  if (preferNote || !extname(clean)) {
    const byName = ctx.index.notesByName.get(basenameNoExt(clean));
    if (byName) return { relPath: byName, exists: true };
  }
  if (extname(clean)) {
    const byFileName = ctx.index.filesByName.get(basename(clean));
    if (byFileName) return { relPath: byFileName, exists: true };
  }
  return { relPath: clean, exists: false };
}

function classifyHref(href, ctx) {
  if (href.startsWith('wo-wiki:')) {
    const target = decodeURIComponent(href.slice('wo-wiki:'.length));
    const resolved = resolveLink(target, ctx, true);
    const ext = extOf(resolved.relPath);
    if (ext && ext !== 'md' && ext !== 'markdown') {
      return { kind: 'att', relPath: resolved.relPath, exists: resolved.exists };
    }
    return { kind: 'wiki', relPath: resolved.relPath, exists: resolved.exists };
  }
  if (href.startsWith('wo-att:')) {
    const target = decodeURIComponent(href.slice('wo-att:'.length));
    const resolved = resolveLink(target, ctx);
    return { kind: 'att', relPath: resolved.relPath, exists: resolved.exists };
  }
  if (!/^[a-z]+:\/\//i.test(href) && !href.startsWith('#') && !href.startsWith('mailto:')) {
    const resolved = resolveLink(href, ctx);
    const ext = extOf(resolved.relPath);
    if (ext === 'md' || ext === 'markdown' || ext === '') {
      return { kind: 'wiki', relPath: resolved.relPath, exists: resolved.exists };
    }
    return { kind: 'att', relPath: resolved.relPath, exists: resolved.exists };
  }
  return null;
}

/**
 * Obsidian-style `==highlight==` support. markdown-it has no native `==mark==`
 * rule, so we register one (a compact port of markdown-it-mark) that turns
 * `==text==` into `<mark>text</mark>`. `<mark>` is in DOMPurify's default
 * allow-list, so it survives sanitization unchanged.
 */
function markPlugin(md) {
  function tokenize(state, silent) {
    const start = state.pos;
    const marker = state.src.charCodeAt(start);
    if (silent) return false;
    if (marker !== 0x3d /* = */) return false;

    const scanned = state.scanDelims(state.pos, true);
    let len = scanned.length;
    const ch = String.fromCharCode(marker);
    if (len < 2) return false;

    let token;
    if (len % 2) {
      token = state.push('text', '', 0);
      token.content = ch;
      len--;
    }

    for (let i = 0; i < len; i += 2) {
      token = state.push('text', '', 0);
      token.content = ch + ch;
      state.delimiters.push({
        marker,
        length: 0,
        jump: i / 2,
        token: state.tokens.length - 1,
        end: -1,
        open: scanned.can_open,
        close: scanned.can_close,
      });
    }

    state.pos += scanned.length;
    return true;
  }

  function postProcess(state, delimiters) {
    const loneMarkers = [];
    const max = delimiters.length;
    for (let i = 0; i < max; i++) {
      const startDelim = delimiters[i];
      if (startDelim.marker !== 0x3d /* = */) continue;
      if (startDelim.end === -1) continue;
      const endDelim = delimiters[startDelim.end];

      let token = state.tokens[startDelim.token];
      token.type = 'mark_open';
      token.tag = 'mark';
      token.nesting = 1;
      token.markup = '==';
      token.content = '';

      token = state.tokens[endDelim.token];
      token.type = 'mark_close';
      token.tag = 'mark';
      token.nesting = -1;
      token.markup = '==';
      token.content = '';

      if (
        state.tokens[endDelim.token - 1].type === 'text' &&
        state.tokens[endDelim.token - 1].content === '='
      ) {
        loneMarkers.push(endDelim.token - 1);
      }
    }

    while (loneMarkers.length) {
      const i = loneMarkers.pop();
      let j = i + 1;
      while (j < state.tokens.length && state.tokens[j].type === 'mark_close') j++;
      j--;
      if (i !== j) {
        const token = state.tokens[j];
        state.tokens[j] = state.tokens[i];
        state.tokens[i] = token;
      }
    }
  }

  md.inline.ruler.before('emphasis', 'mark', tokenize);
  md.inline.ruler2.before('emphasis', 'mark', (state) => {
    const tokensMeta = state.tokens_meta;
    const max = (state.tokens_meta || []).length;
    postProcess(state, state.delimiters);
    for (let curr = 0; curr < max; curr++) {
      if (tokensMeta[curr] && tokensMeta[curr].delimiters) {
        postProcess(state, tokensMeta[curr].delimiters);
      }
    }
  });
}

function createRenderer() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    typographer: true,
    highlight: (code, lang) =>
      `<pre class="hljs"><code>${highlightToHtml(code, lang)}</code></pre>`,
  });

  md.use(markPlugin);

  const defaultValidate = md.validateLink.bind(md);
  md.validateLink = (url) =>
    url.startsWith('wo-wiki:') || url.startsWith('wo-att:') || defaultValidate(url);

  // Attachment src resolved via env.wo.attachmentSrc so the host app can swap
  // in a decrypted blob URL (the bytes on the server are ciphertext).
  const attSrc = (ctx, relPath) =>
    ctx && typeof ctx.attachmentSrc === 'function'
      ? ctx.attachmentSrc(relPath)
      : `/api/attachment?path=${encodeURIComponent(relPath)}`;

  md.renderer.rules.image = function (tokens, idx, _opts, env) {
    const token = tokens[idx];
    const srcIndex = token.attrIndex('src');
    const rawSrc = srcIndex >= 0 ? token.attrs[srcIndex][1] : '';
    const alt = token.content || '';
    let target = rawSrc;
    if (target.startsWith('wo-att:')) target = decodeURIComponent(target.slice(7));
    else if (target.startsWith('wo-wiki:')) target = decodeURIComponent(target.slice(8));
    const ctx = env && env.wo;
    const resolved = resolveLink(target, ctx);
    const ext = extOf(resolved.relPath);
    if (IMAGE_EXTS.has(ext)) {
      return `<img data-wo-att="${escapeHtml(resolved.relPath)}" src="${attSrc(ctx, resolved.relPath)}" alt="${escapeHtml(alt)}" loading="lazy">`;
    }
    if (ext === 'pdf') {
      return `<iframe class="wo-pdf" data-wo-att="${escapeHtml(resolved.relPath)}" src="${attSrc(ctx, resolved.relPath)}" title="${escapeHtml(alt || resolved.relPath)}"></iframe>`;
    }
    if (ext === 'excalidraw') {
      return `<a href="#" class="wo-wikilink" data-target="${escapeHtml(resolved.relPath)}">${escapeHtml(alt || resolved.relPath)}</a>`;
    }
    return `<a class="wo-attachment" data-wo-att="${escapeHtml(resolved.relPath)}" href="${attSrc(ctx, resolved.relPath)}" download>${escapeHtml(alt || resolved.relPath)}</a>`;
  };

  const defaultLinkOpen =
    md.renderer.rules.link_open ||
    function (tokens, idx, options, _env, renderer) {
      return renderer.renderToken(tokens, idx, options);
    };

  md.renderer.rules.link_open = function (tokens, idx, options, env, renderer) {
    const token = tokens[idx];
    const hrefIndex = token.attrIndex('href');
    const href = hrefIndex >= 0 ? token.attrs[hrefIndex][1] : '';
    const ctx = env && env.wo;
    const internal = classifyHref(href, ctx);
    if (internal) {
      if (internal.kind === 'wiki') {
        token.attrs[hrefIndex][1] = '#';
        token.attrSet('class', internal.exists ? 'wo-wikilink' : 'wo-wikilink wo-missing');
        token.attrSet('data-target', internal.relPath);
      } else {
        token.attrs[hrefIndex][1] = attSrc(ctx, internal.relPath);
        token.attrSet('class', 'wo-attachment');
        token.attrSet('data-wo-att', internal.relPath);
        token.attrSet('target', '_blank');
        token.attrSet('rel', 'noopener');
      }
    } else if (/^https?:\/\//i.test(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, idx, options, env, renderer);
  };

  // Interactive task lists with document-order indices.
  md.core.ruler.after('inline', 'wo-task-lists', (state) => {
    const tokens = state.tokens;
    let taskIndex = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== 'inline' || !token.children || !token.children.length) continue;
      if (i < 2 || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const first = token.children[0];
      if (first.type !== 'text') continue;
      const match = /^\[([ xX])\]\s+/.exec(first.content);
      if (!match) continue;
      const checked = match[1].toLowerCase() === 'x';
      first.content = first.content.slice(match[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" class="wo-task" data-task-index="${taskIndex}"${checked ? ' checked' : ''}>`;
      token.children.unshift(box);
      tokens[i - 2].attrJoin('class', 'wo-task-item');
      taskIndex++;
    }
  });

  return md;
}

const md = createRenderer();

/**
 * Render markdown to HTML.
 * @param {string} content - markdown source
 * @param {object} opts - { notePath, files: string[], attachmentSrc(relPath) }
 */
function render(content, opts) {
  opts = opts || {};
  const noteDir = (() => {
    const p = String(opts.notePath || '').replace(/\\/g, '/');
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  })();
  const ctx = {
    index: buildIndex(opts.files || []),
    noteDir,
    attachmentSrc: opts.attachmentSrc,
  };
  const html = md.render(preprocessWikilinks(content), { wo: ctx });
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/** Highlight a whole code/config file as one block. */
function highlightFile(ext, content) {
  const html = `<pre class="hljs code-file"><code>${highlightToHtml(content, langForExt(ext))}</code></pre>`;
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

window.WOMarkdown = { render, highlightFile };
