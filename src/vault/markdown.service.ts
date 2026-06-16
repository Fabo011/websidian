import { Inject, Injectable } from '@nestjs/common';
import hljs from 'highlight.js';
import MarkdownIt from 'markdown-it';
import { extname, posix } from 'path';
import {
    STORAGE_PROVIDER,
    StorageProvider,
} from '../storage/storage.interface';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

interface VaultIndex {
  /** lowercased relative path -> actual relative path */
  files: Map<string, string>;
  /** lowercased basename without extension -> actual relative path (markdown notes) */
  notesByName: Map<string, string>;
  /** lowercased basename WITH extension -> actual relative path (any file) */
  filesByName: Map<string, string>;
}

interface RenderContext {
  index: VaultIndex;
  noteDir: string;
}

function attachmentUrl(relPath: string): string {
  return `/api/attachment?path=${encodeURIComponent(relPath)}`;
}

@Injectable()
export class MarkdownService {
  private readonly md: MarkdownIt;

  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {
    this.md = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: true,
      typographer: true,
      // Syntax-highlight fenced code blocks with highlight.js. Returns a
      // ready-made <pre><code> so markdown-it does not escape it again.
      highlight: (code: string, lang: string): string => {
        const inner = this.highlightToHtml(code, lang);
        return `<pre class="hljs"><code>${inner}</code></pre>`;
      },
    });
    // Allow our internal link schemes through markdown-it's URL validator.
    const defaultValidate = this.md.validateLink.bind(this.md);
    this.md.validateLink = (url: string) =>
      url.startsWith('wo-wiki:') ||
      url.startsWith('wo-att:') ||
      defaultValidate(url);
    this.installRenderRules();
    this.installTaskLists();
  }

  async render(
    username: string,
    notePath: string,
    content: string,
  ): Promise<string> {
    const index = await this.buildIndex(username);
    const noteDir = posix.dirname(notePath.replace(/\\/g, '/'));
    const ctx: RenderContext = {
      index,
      noteDir: noteDir === '.' ? '' : noteDir,
    };
    const pre = this.preprocessWikilinks(content);
    return this.md.render(pre, { wo: ctx });
  }

  /**
   * Highlight a whole source file as a single code block. Used by the file
   * browser to display code files (.py, .ts, .yaml, …) read-only with the same
   * highlight.js theme as fenced code blocks in markdown.
   */
  highlightFile(ext: string, content: string): string {
    const inner = this.highlightToHtml(content, this.langForExt(ext));
    return `<pre class="hljs code-file"><code>${inner}</code></pre>`;
  }

  /** Highlight code to inner HTML, falling back to escaped plaintext. */
  private highlightToHtml(code: string, lang?: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true })
          .value;
      } catch {
        /* fall through to auto/plain */
      }
    }
    try {
      return hljs.highlightAuto(code).value;
    } catch {
      return this.escapeHtml(code);
    }
  }

  /** Map a file extension to a highlight.js language name. */
  private langForExt(ext: string): string | undefined {
    const map: Record<string, string> = {
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      rb: 'ruby',
      php: 'php',
      java: 'java',
      kt: 'kotlin',
      kts: 'kotlin',
      go: 'go',
      rs: 'rust',
      c: 'c',
      h: 'c',
      cpp: 'cpp',
      cc: 'cpp',
      hpp: 'cpp',
      cs: 'csharp',
      swift: 'swift',
      scala: 'scala',
      lua: 'lua',
      pl: 'perl',
      r: 'r',
      sql: 'sql',
      sh: 'bash',
      bash: 'bash',
      zsh: 'bash',
      fish: 'bash',
      ps1: 'powershell',
      bat: 'dos',
      dockerfile: 'dockerfile',
      gradle: 'gradle',
      tex: 'latex',
      html: 'xml',
      htm: 'xml',
      xml: 'xml',
      css: 'css',
      scss: 'scss',
      sass: 'scss',
      less: 'less',
      json: 'json',
      yml: 'yaml',
      yaml: 'yaml',
      toml: 'ini',
      ini: 'ini',
      conf: 'ini',
      cfg: 'ini',
      properties: 'ini',
      md: 'markdown',
      markdown: 'markdown',
    };
    return map[ext.toLowerCase()];
  }

  /** Replace Obsidian `[[..]]` and `![[..]]` syntax with markdown using custom schemes. */
  private preprocessWikilinks(content: string): string {
    // Embeds: ![[target]] or ![[target|alias]]
    let out = content.replace(/!\[\[([^\]\n]+)\]\]/g, (_m, inner: string) => {
      const { target, alias } = this.splitTarget(inner);
      return `![${this.escapeMd(alias ?? target)}](wo-att:${encodeURIComponent(target)})`;
    });
    // Links: [[target]] or [[target|alias]]
    out = out.replace(/\[\[([^\]\n]+)\]\]/g, (_m, inner: string) => {
      const { target, alias } = this.splitTarget(inner);
      return `[${this.escapeMd(alias ?? target)}](wo-wiki:${encodeURIComponent(target)})`;
    });
    return out;
  }

  private splitTarget(inner: string): { target: string; alias?: string } {
    const idx = inner.indexOf('|');
    if (idx >= 0) {
      return {
        target: inner.slice(0, idx).trim(),
        alias: inner.slice(idx + 1).trim(),
      };
    }
    return { target: inner.trim() };
  }

  private escapeMd(text: string): string {
    return text.replace(/([\\\[\]()])/g, '\\$1');
  }

  private installRenderRules(): void {
    const self = this;

    this.md.renderer.rules.image = function (tokens, idx, _opts, env) {
      const token = tokens[idx];
      const srcIndex = token.attrIndex('src');
      const rawSrc = srcIndex >= 0 ? token.attrs[srcIndex][1] : '';
      const alt = token.content || '';
      // Embeds are pre-rewritten to `wo-att:`/`wo-wiki:`; strip the scheme so
      // the target resolves against the vault index.
      let target = rawSrc;
      if (target.startsWith('wo-att:')) {
        target = decodeURIComponent(target.slice('wo-att:'.length));
      } else if (target.startsWith('wo-wiki:')) {
        target = decodeURIComponent(target.slice('wo-wiki:'.length));
      }
      const resolved = self.resolveLink(target, env?.wo);
      const ext = self.extOf(resolved.relPath);

      if (IMAGE_EXTS.has(ext)) {
        return `<img src="${attachmentUrl(resolved.relPath)}" alt="${self.escapeHtml(alt)}" loading="lazy">`;
      }
      if (ext === 'pdf') {
        return `<iframe class="wo-pdf" src="${attachmentUrl(resolved.relPath)}" title="${self.escapeHtml(alt || resolved.relPath)}"></iframe>`;
      }
      if (ext === 'excalidraw') {
        return `<a href="#" class="wo-wikilink" data-target="${self.escapeHtml(resolved.relPath)}">${self.escapeHtml(alt || resolved.relPath)}</a>`;
      }
      // Unknown embed -> download link
      return `<a class="wo-attachment" href="${attachmentUrl(resolved.relPath)}" download>${self.escapeHtml(alt || resolved.relPath)}</a>`;
    };

    const defaultLinkOpen =
      this.md.renderer.rules.link_open ||
      function (tokens, idx, options, _env, renderer) {
        return renderer.renderToken(tokens, idx, options);
      };

    this.md.renderer.rules.link_open = function (tokens, idx, options, env, renderer) {
      const token = tokens[idx];
      const hrefIndex = token.attrIndex('href');
      const href = hrefIndex >= 0 ? token.attrs[hrefIndex][1] : '';
      const internal = self.classifyHref(href, env?.wo);
      if (internal) {
        if (internal.kind === 'wiki') {
          token.attrs[hrefIndex][1] = '#';
          token.attrSet('class', internal.exists ? 'wo-wikilink' : 'wo-wikilink wo-missing');
          token.attrSet('data-target', internal.relPath);
        } else {
          // attachment link
          token.attrs[hrefIndex][1] = attachmentUrl(internal.relPath);
          token.attrSet('class', 'wo-attachment');
          token.attrSet('target', '_blank');
          token.attrSet('rel', 'noopener');
        }
      } else if (/^https?:\/\//i.test(href)) {
        token.attrSet('target', '_blank');
        token.attrSet('rel', 'noopener noreferrer');
      }
      return defaultLinkOpen(tokens, idx, options, env, renderer);
    };
  }

  /**
   * Render GFM-style task list items (`- [ ]` / `- [x]`) as interactive
   * checkboxes. Each checkbox gets a sequential `data-task-index` (document
   * order) so the client can map a click back to the right source line, toggle
   * it, and persist the change.
   */
  private installTaskLists(): void {
    this.md.core.ruler.after('inline', 'wo-task-lists', (state) => {
      const tokens = state.tokens;
      let taskIndex = 0;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type !== 'inline' || !token.children?.length) {
          continue;
        }
        // Task list items have the shape: list_item_open, paragraph_open, inline.
        if (
          i < 2 ||
          tokens[i - 1].type !== 'paragraph_open' ||
          tokens[i - 2].type !== 'list_item_open'
        ) {
          continue;
        }
        const first = token.children[0];
        if (first.type !== 'text') {
          continue;
        }
        const match = /^\[([ xX])\]\s+/.exec(first.content);
        if (!match) {
          continue;
        }
        const checked = match[1].toLowerCase() === 'x';
        // Drop the `[ ] ` marker from the visible text.
        first.content = first.content.slice(match[0].length);
        // Prepend a checkbox input.
        const box = new state.Token('html_inline', '', 0);
        box.content =
          `<input type="checkbox" class="wo-task" ` +
          `data-task-index="${taskIndex}"${checked ? ' checked' : ''}>`;
        token.children.unshift(box);
        // Tag the list item so the bullet can be hidden via CSS.
        tokens[i - 2].attrJoin('class', 'wo-task-item');
        taskIndex++;
      }
    });
  }

  private classifyHref(
    href: string,
    ctx?: RenderContext,
  ): { kind: 'wiki' | 'att'; relPath: string; exists: boolean } | null {
    if (href.startsWith('wo-wiki:')) {
      const target = decodeURIComponent(href.slice('wo-wiki:'.length));
      const resolved = this.resolveLink(target, ctx, true);
      const ext = this.extOf(resolved.relPath);
      if (ext && ext !== 'md' && ext !== 'markdown') {
        return { kind: 'att', relPath: resolved.relPath, exists: resolved.exists };
      }
      return { kind: 'wiki', relPath: resolved.relPath, exists: resolved.exists };
    }
    if (href.startsWith('wo-att:')) {
      const target = decodeURIComponent(href.slice('wo-att:'.length));
      const resolved = this.resolveLink(target, ctx);
      return { kind: 'att', relPath: resolved.relPath, exists: resolved.exists };
    }
    // plain relative links/images written as standard markdown
    if (!/^[a-z]+:\/\//i.test(href) && !href.startsWith('#') && !href.startsWith('mailto:')) {
      const resolved = this.resolveLink(href, ctx);
      const ext = this.extOf(resolved.relPath);
      if (ext === 'md' || ext === 'markdown' || ext === '') {
        return { kind: 'wiki', relPath: resolved.relPath, exists: resolved.exists };
      }
      return { kind: 'att', relPath: resolved.relPath, exists: resolved.exists };
    }
    return null;
  }

  /** Resolve a (possibly extension-less) link target to an actual vault-relative path. */
  private resolveLink(
    target: string,
    ctx?: RenderContext,
    preferNote = false,
  ): { relPath: string; exists: boolean } {
    if (!ctx) {
      return { relPath: target, exists: false };
    }
    const clean = target.replace(/^\.\//, '').split('#')[0].trim();
    const candidates: string[] = [];
    const joinDir = (p: string) =>
      ctx.noteDir ? posix.normalize(`${ctx.noteDir}/${p}`) : posix.normalize(p);

    candidates.push(clean, joinDir(clean));
    if (!extname(clean)) {
      candidates.push(`${clean}.md`, joinDir(`${clean}.md`));
    }

    for (const cand of candidates) {
      const key = cand.replace(/^\.\//, '').toLowerCase();
      const actual = ctx.index.files.get(key);
      if (actual) {
        return { relPath: actual, exists: true };
      }
    }

    if (preferNote || !extname(clean)) {
      const base = posix.basename(clean, extname(clean)).toLowerCase();
      const byName = ctx.index.notesByName.get(base);
      if (byName) {
        return { relPath: byName, exists: true };
      }
    }

    // Attachment basename match: Obsidian resolves `![[image.png]]` to that
    // file wherever it lives in the vault, not just next to the note.
    if (extname(clean)) {
      const baseWithExt = posix.basename(clean).toLowerCase();
      const byFileName = ctx.index.filesByName.get(baseWithExt);
      if (byFileName) {
        return { relPath: byFileName, exists: true };
      }
    }

    // unresolved: keep a best-guess relative path
    return { relPath: clean, exists: false };
  }

  private extOf(name: string): string {
    return extname(name).replace(/^\./, '').toLowerCase();
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private async buildIndex(username: string): Promise<VaultIndex> {
    const files = new Map<string, string>();
    const notesByName = new Map<string, string>();
    const filesByName = new Map<string, string>();
    await this.indexWalk(username, '', files, notesByName, filesByName);
    return { files, notesByName, filesByName };
  }

  private async indexWalk(
    username: string,
    relDir: string,
    files: Map<string, string>,
    notesByName: Map<string, string>,
    filesByName: Map<string, string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await this.storage.list(username, relDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.type === 'dir') {
        await this.indexWalk(username, rel, files, notesByName, filesByName);
      } else {
        files.set(rel.toLowerCase(), rel);
        const baseWithExt = posix.basename(rel).toLowerCase();
        if (!filesByName.has(baseWithExt)) {
          filesByName.set(baseWithExt, rel);
        }
        const ext = this.extOf(entry.name);
        if (ext === 'md' || ext === 'markdown') {
          const base = posix.basename(rel, extname(rel)).toLowerCase();
          if (!notesByName.has(base)) {
            notesByName.set(base, rel);
          }
        }
      }
    }
  }
}
