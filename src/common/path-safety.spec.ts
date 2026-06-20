import { BadRequestException } from '@nestjs/common';
import { resolveUploadPath, sanitizeRelPath } from './path-safety';

describe('sanitizeRelPath', () => {
  it('passes through a normal nested path', () => {
    expect(sanitizeRelPath('notes/2024/todo.md')).toBe('notes/2024/todo.md');
  });

  it('normalizes backslashes and drops "." segments', () => {
    expect(sanitizeRelPath('notes\\sub\\.\\a.md')).toBe('notes/sub/a.md');
  });

  it('strips leading slashes (treats absolute as relative)', () => {
    expect(sanitizeRelPath('/etc/passwd')).toBe('etc/passwd');
  });

  it('rejects ".." traversal segments', () => {
    expect(() => sanitizeRelPath('../secret')).toThrow(BadRequestException);
    expect(() => sanitizeRelPath('a/../../b')).toThrow(BadRequestException);
  });

  it('rejects Windows drive letters', () => {
    expect(() => sanitizeRelPath('C:/Windows/system32')).toThrow(
      BadRequestException,
    );
  });

  it('rejects NUL bytes', () => {
    expect(() => sanitizeRelPath('a\0b')).toThrow(BadRequestException);
  });

  it('rejects an empty / dot-only path', () => {
    expect(() => sanitizeRelPath('')).toThrow(BadRequestException);
    expect(() => sanitizeRelPath('/')).toThrow(BadRequestException);
    expect(() => sanitizeRelPath('.')).toThrow(BadRequestException);
  });
});

describe('resolveUploadPath (folder structure reconstruction)', () => {
  it('rebuilds the original tree under the destination base', () => {
    expect(resolveUploadPath('Imported', 'vault/daily', 'mon.md')).toBe(
      'Imported/vault/daily/mon.md',
    );
  });

  it('works with an empty base (vault root)', () => {
    expect(resolveUploadPath('', 'sub/dir', 'note.md')).toBe('sub/dir/note.md');
  });

  it('works for a file at the top of the selection (no relativePath)', () => {
    expect(resolveUploadPath('dest', '', 'readme.md')).toBe('dest/readme.md');
  });

  it('rejects a traversal attempt in the relative path', () => {
    expect(() => resolveUploadPath('dest', '../../etc', 'passwd')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a traversal attempt smuggled in the base', () => {
    expect(() => resolveUploadPath('../escape', 'sub', 'f.md')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a missing filename', () => {
    expect(() => resolveUploadPath('dest', 'sub', '')).toThrow(
      BadRequestException,
    );
  });
});
