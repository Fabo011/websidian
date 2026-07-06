import {
  buildUploadExcludeMatcher,
  DEFAULT_UPLOAD_EXCLUDE_PATTERNS,
  parseUploadExcludePatterns,
} from './upload-exclude';

describe('parseUploadExcludePatterns', () => {
  it('falls back to the defaults when the env var is unset', () => {
    const patterns = parseUploadExcludePatterns(undefined);
    expect(patterns).toEqual(
      DEFAULT_UPLOAD_EXCLUDE_PATTERNS.split(',').map((s) => s.trim()),
    );
    expect(patterns).toContain('.DS_Store');
    expect(patterns).toContain('._*');
  });

  it('yields an empty list (exclusion disabled) for empty values', () => {
    expect(parseUploadExcludePatterns('')).toEqual([]);
    expect(parseUploadExcludePatterns('  ')).toEqual([]);
  });

  it('trims entries and drops empty ones', () => {
    expect(parseUploadExcludePatterns(' a.txt , , *.tmp ')).toEqual([
      'a.txt',
      '*.tmp',
    ]);
  });
});

describe('buildUploadExcludeMatcher', () => {
  const matcher = buildUploadExcludeMatcher(
    parseUploadExcludePatterns(undefined),
  );

  it('matches OS junk files', () => {
    expect(matcher('.DS_Store')).toBe(true);
    expect(matcher('._resource-fork')).toBe(true);
    expect(matcher('Thumbs.db')).toBe(true);
    expect(matcher('desktop.ini')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matcher('.ds_store')).toBe(true);
    expect(matcher('THUMBS.DB')).toBe(true);
  });

  it('only tests the leaf filename of a path', () => {
    expect(matcher('notes/subfolder/.DS_Store')).toBe(true);
    expect(matcher('.DS_Store/note.md')).toBe(false);
  });

  it('does not match regular files', () => {
    expect(matcher('note.md')).toBe(false);
    expect(matcher('my.DS_Store.md')).toBe(false);
    expect(matcher('folder/_underscore.md')).toBe(false);
  });

  it('anchors patterns (no substring matches)', () => {
    const m = buildUploadExcludeMatcher(['secret']);
    expect(m('secret')).toBe(true);
    expect(m('secret.txt')).toBe(false);
    expect(m('mysecret')).toBe(false);
  });

  it('escapes regex metacharacters in patterns', () => {
    const m = buildUploadExcludeMatcher(['a+b(c).txt']);
    expect(m('a+b(c).txt')).toBe(true);
    expect(m('aab(c).txt')).toBe(false);
  });

  it('supports * as the only wildcard', () => {
    const m = buildUploadExcludeMatcher(['*.tmp']);
    expect(m('x.tmp')).toBe(true);
    expect(m('x.tmpx')).toBe(false);
  });

  it('matches nothing when the pattern list is empty', () => {
    const m = buildUploadExcludeMatcher([]);
    expect(m('.DS_Store')).toBe(false);
  });
});
