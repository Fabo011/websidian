import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import MarkdownIt from 'markdown-it';
import { extname, join, posix } from 'path';
import { toRelative } from '../common/path-safety';
import { AppConfig } from '../config/configuration';

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

  constructor(private readonly config: ConfigService) {
    this.md = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: true,
      typographer: true,
    });
    // Allow our internal link schemes through markdown-it's URL validator.
    const defaultValidate = this.md.validateLink.bind(this.md);
    this.md.validateLink = (url: string) =>
      url.startsWith('wo-wiki:') ||
      url.startsWith('wo-att:') ||
      defaultValidate(url);
    this.installRenderRules();
  }

  private get dataRoot(): string {
    return this.config.get<AppConfig>('app').dataRoot;
  }

  private userRoot(username: string): string {
    return join(this.dataRoot, username);
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
    const root = this.userRoot(username);
    const files = new Map<string, string>();
    const notesByName = new Map<string, string>();
    const filesByName = new Map<string, string>();
    await this.indexWalk(root, root, files, notesByName, filesByName);
    return { files, notesByName, filesByName };
  }

  private async indexWalk(
    root: string,
    dir: string,
    files: Map<string, string>,
    notesByName: Map<string, string>,
    filesByName: Map<string, string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.indexWalk(root, abs, files, notesByName, filesByName);
      } else if (entry.isFile()) {
        const rel = toRelative(root, abs);
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
