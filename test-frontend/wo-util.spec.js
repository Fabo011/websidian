'use strict';

const WOUtil = require('../public/js/wo-util');

// A minimal stand-in for the i18n translator: echoes the key and interpolates
// {placeholders} from vars, so assertions can check both which message fired
// and that the right value was passed in.
function fakeT(key, vars) {
  if (!vars) return key;
  // Append the interpolated values so assertions can check the message keyed
  // fired AND that the right value (e.g. the offending filename) was passed.
  return key + ' ' + Object.values(vars).join(' ');
}

describe('fmtSize', () => {
  it('formats bytes below 1 KB as B', () => {
    expect(WOUtil.fmtSize(512)).toBe('512 B');
  });

  it('scales up through KB / MB / GB (one decimal under 10)', () => {
    expect(WOUtil.fmtSize(2 * 1024)).toBe('2.0 KB');
    expect(WOUtil.fmtSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(WOUtil.fmtSize(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });

  it('rounds (no decimal) for values >= 10 in a unit', () => {
    expect(WOUtil.fmtSize(1.4 * 1024 * 1024 * 1024)).toBe('1.4 GB');
    expect(WOUtil.fmtSize(360 * 1024 * 1024)).toBe('360 MB');
  });
});

describe('uploadLimitError', () => {
  const limits = {
    maxImportTotalBytes: 100,
    maxImportFiles: 3,
    maxUploadFileBytes: 50,
  };

  it('returns empty string when the selection is within every limit', () => {
    const items = [
      { path: 'a.txt', size: 10 },
      { path: 'b.txt', size: 10 },
    ];
    expect(WOUtil.uploadLimitError(items, limits, fakeT)).toBe('');
  });

  it('flags a total size over the import cap first', () => {
    const items = [
      { path: 'a', size: 60 },
      { path: 'b', size: 60 },
    ];
    expect(WOUtil.uploadLimitError(items, limits, fakeT)).toContain(
      'import_total_too_large',
    );
  });

  it('flags too many files', () => {
    const items = [
      { path: 'a', size: 1 },
      { path: 'b', size: 1 },
      { path: 'c', size: 1 },
      { path: 'd', size: 1 },
    ];
    expect(WOUtil.uploadLimitError(items, limits, fakeT)).toContain(
      'too_many_files',
    );
  });

  it('flags a single oversized file and names it (the folder-import bug)', () => {
    // Total/count within caps so the per-file size check is what fires.
    const roomy = {
      maxImportTotalBytes: 1e12,
      maxImportFiles: 1000,
      maxUploadFileBytes: 50,
    };
    const items = [
      { path: 'ok.txt', size: 10 },
      { path: 'deep/huge.bin', size: 999 },
    ];
    const msg = WOUtil.uploadLimitError(items, roomy, fakeT);
    expect(msg).toContain('file_too_large');
    expect(msg).toContain('huge.bin'); // basename, not the full path
  });
});

describe('sanitizeLinkUrl', () => {
  it('keeps http(s) URLs', () => {
    expect(WOUtil.sanitizeLinkUrl('https://example.com/x')).toBe(
      'https://example.com/x',
    );
  });

  it('upgrades a bare host to https', () => {
    expect(WOUtil.sanitizeLinkUrl('example.com')).toBe('https://example.com/');
  });

  it('rejects dangerous schemes', () => {
    expect(WOUtil.sanitizeLinkUrl('javascript:alert(1)')).toBe('');
    expect(WOUtil.sanitizeLinkUrl('data:text/html,x')).toBe('');
  });

  it('returns empty for blank input', () => {
    expect(WOUtil.sanitizeLinkUrl('')).toBe('');
    expect(WOUtil.sanitizeLinkUrl('   ')).toBe('');
  });
});

describe('weblinks CSV round-trip', () => {
  const links = [
    {
      name: 'Example',
      description: 'a, with comma',
      url: 'https://example.com/',
      category: 'ref',
      username: 'joe',
      contactName: 'Joe',
      contactPhone: '123',
      contactEmail: 'joe@x.com',
      notes: 'line1\nline2',
    },
  ];

  it('serializes with the Linky header row', () => {
    const csv = WOUtil.serializeWeblinks(links);
    expect(csv.split('\n')[0]).toBe(WOUtil.WEBLINKS_HEADER.join(','));
  });

  it('quotes cells containing commas, quotes or newlines', () => {
    const csv = WOUtil.serializeWeblinks(links);
    expect(csv).toContain('"a, with comma"');
    expect(csv).toContain('"line1\nline2"');
  });

  it('parses back to the original records', () => {
    const csv = WOUtil.serializeWeblinks(links);
    expect(WOUtil.csvToLinks(csv)).toEqual(links);
  });

  it('drops rows without a usable http(s) URL', () => {
    const csv = WOUtil.serializeWeblinks([
      { name: 'bad', url: 'ftp://nope', category: '' },
      { name: 'good', url: 'https://ok.com/', category: '' },
    ]);
    const out = WOUtil.csvToLinks(csv);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://ok.com/');
  });

  it('reads a headerless name,url layout', () => {
    const out = WOUtil.csvToLinks('My Site,https://site.com/\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'My Site',
      url: 'https://site.com/',
    });
  });
});

describe('weblinkCategories', () => {
  it('returns distinct, sorted, non-empty categories', () => {
    const links = [
      { category: 'Work' },
      { category: 'Personal' },
      { category: '' },
      { category: 'Work' },
      { category: '  Finance  ' },
    ];
    expect(WOUtil.weblinkCategories(links)).toEqual([
      'Finance',
      'Personal',
      'Work',
    ]);
  });

  it('de-duplicates case-insensitively, keeping first-seen spelling', () => {
    const links = [{ category: 'News' }, { category: 'news' }];
    expect(WOUtil.weblinkCategories(links)).toEqual(['News']);
  });

  it('tolerates non-array / missing category', () => {
    expect(WOUtil.weblinkCategories(null)).toEqual([]);
    expect(WOUtil.weblinkCategories([{}, { category: null }])).toEqual([]);
  });
});

describe('linksInCategory', () => {
  const links = [
    { url: 'a', category: 'Work' },
    { url: 'b', category: 'personal' },
    { url: 'c', category: 'work' },
    { url: 'd', category: '' },
  ];

  it('returns a copy of all links for empty category', () => {
    const out = WOUtil.linksInCategory(links, '');
    expect(out).toHaveLength(4);
    expect(out).not.toBe(links);
  });

  it('filters case-insensitively by category', () => {
    expect(WOUtil.linksInCategory(links, 'Work').map((l) => l.url)).toEqual([
      'a',
      'c',
    ]);
  });

  it('tolerates non-array input', () => {
    expect(WOUtil.linksInCategory(null, 'x')).toEqual([]);
  });
});

describe('weblinksCsvFilename', () => {
  it('uses weblinks.csv for all links', () => {
    expect(WOUtil.weblinksCsvFilename('')).toBe('weblinks.csv');
    expect(WOUtil.weblinksCsvFilename(null)).toBe('weblinks.csv');
  });

  it('slugs the category into a safe filename', () => {
    expect(WOUtil.weblinksCsvFilename('Work Stuff')).toBe(
      'weblinks-work-stuff.csv',
    );
    expect(WOUtil.weblinksCsvFilename('  Résumé/CV!  ')).toBe(
      'weblinks-r-sum-cv.csv',
    );
  });

  it('falls back to weblinks.csv when the slug is empty', () => {
    expect(WOUtil.weblinksCsvFilename('!!!')).toBe('weblinks.csv');
  });
});

describe('isWeblinksCsvName', () => {
  it('matches exported weblinks CSV names', () => {
    expect(WOUtil.isWeblinksCsvName('weblinks.csv')).toBe(true);
    expect(WOUtil.isWeblinksCsvName('weblinks-work.csv')).toBe(true);
    expect(WOUtil.isWeblinksCsvName('WEBLINKS-Work.CSV')).toBe(true);
    expect(WOUtil.isWeblinksCsvName('chat-images/x/weblinks.csv')).toBe(true);
  });

  it('rejects other names', () => {
    expect(WOUtil.isWeblinksCsvName('links.csv')).toBe(false);
    expect(WOUtil.isWeblinksCsvName('weblinks.txt')).toBe(false);
    expect(WOUtil.isWeblinksCsvName('myweblinks.csv')).toBe(false);
    expect(WOUtil.isWeblinksCsvName('')).toBe(false);
    expect(WOUtil.isWeblinksCsvName(null)).toBe(false);
  });
});

describe('normalizeVaultPath', () => {
  it('trims, collapses slashes and drops leading/trailing slashes', () => {
    expect(WOUtil.normalizeVaultPath('  /Daily//Notes/  ')).toBe('Daily/Notes');
  });

  it('strips . and .. segments so it cannot escape the vault', () => {
    expect(WOUtil.normalizeVaultPath('../../etc/Daily')).toBe('etc/Daily');
    expect(WOUtil.normalizeVaultPath('./Daily/./x')).toBe('Daily/x');
  });

  it('returns empty string for blank or non-string input', () => {
    expect(WOUtil.normalizeVaultPath('   ')).toBe('');
    expect(WOUtil.normalizeVaultPath(null)).toBe('');
  });
});

describe('formatDailyDate', () => {
  it('formats a Date as local YYYY-MM-DD with zero padding', () => {
    expect(WOUtil.formatDailyDate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(WOUtil.formatDailyDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('applyTemplate', () => {
  it('substitutes {{date}}, {{time}} and {{title}} (case/space tolerant)', () => {
    const now = new Date(2026, 6, 9, 8, 4);
    const out = WOUtil.applyTemplate('# {{ TITLE }}\n{{date}} {{time}}', {
      now,
      title: 'My Note',
    });
    expect(out).toBe('# My Note\n2026-07-09 08:04');
  });

  it('leaves unknown placeholders untouched and tolerates empty input', () => {
    expect(WOUtil.applyTemplate('{{foo}}', { title: 'x' })).toBe('{{foo}}');
    expect(WOUtil.applyTemplate(null, {})).toBe('');
  });
});

describe('mtimeFromVersion', () => {
  it('parses the ms timestamp from a "mtime-size" token', () => {
    expect(WOUtil.mtimeFromVersion('1750000000000-42')).toBe(1750000000000);
  });

  it('returns NaN for malformed or missing tokens', () => {
    expect(Number.isNaN(WOUtil.mtimeFromVersion('abc-1'))).toBe(true);
    expect(Number.isNaN(WOUtil.mtimeFromVersion(undefined))).toBe(true);
  });
});

describe('filesByDay', () => {
  it('buckets files by local mtime day and skips reserved/bad entries', () => {
    const ms = new Date(2026, 6, 9, 12, 0).getTime();
    const files = [
      { path: 'a.md', version: ms + '-10' },
      { path: 'sub/b.md', version: ms + '-20' },
      { path: '.websidian/settings.json', version: ms + '-5' },
      { path: 'bad.md', version: 'x-1' },
    ];
    const map = WOUtil.filesByDay(files, ['.websidian']);
    expect(map.get('2026-07-09')).toEqual(['a.md', 'sub/b.md']);
    expect(map.size).toBe(1);
  });
});

describe('buildCalendarModel', () => {
  it('builds a 6x7 Monday-first grid with counts and month membership', () => {
    const counts = new Map([['2026-07-09', 3]]);
    const model = WOUtil.buildCalendarModel(2026, 6, counts);
    expect(model.weeks).toHaveLength(6);
    model.weeks.forEach((w) => expect(w).toHaveLength(7));
    // 1 July 2026 is a Wednesday -> first cell is Monday 29 June (not in month).
    expect(model.weeks[0][0]).toMatchObject({ day: 29, inMonth: false });
    const cell = model.weeks.flat().find((c) => c.key === '2026-07-09');
    expect(cell).toMatchObject({ day: 9, inMonth: true, count: 3 });
  });
});

describe('preserveMarkdownBlankLines', () => {
  const NBSP = ' ';

  it('keeps a single blank line as one paragraph separator (unchanged)', () => {
    expect(WOUtil.preserveMarkdownBlankLines('a\n\nb')).toBe('a\n\nb');
  });

  it('turns each extra blank line into a non-breaking-space paragraph', () => {
    // 5 blank lines between the two texts -> 1 separator + 4 nbsp paragraphs
    const src = 'a\n\n\n\n\n\nb';
    const out = WOUtil.preserveMarkdownBlankLines(src);
    expect(out).toBe(`a\n\n${NBSP}\n\n${NBSP}\n\n${NBSP}\n\n${NBSP}\n\nb`);
  });

  it('leaves blank lines inside fenced code blocks untouched', () => {
    const src = '```\ncode\n\n\n\nmore\n```\n\n\ntext';
    const out = WOUtil.preserveMarkdownBlankLines(src);
    // fence body verbatim; only the run after the fence gets nbsp padding
    expect(out).toBe(`\`\`\`\ncode\n\n\n\nmore\n\`\`\`\n\n${NBSP}\n\ntext`);
  });

  it('normalizes CRLF and handles null input', () => {
    expect(WOUtil.preserveMarkdownBlankLines('a\r\n\r\n\r\nb')).toBe(
      `a\n\n${NBSP}\n\nb`,
    );
    expect(WOUtil.preserveMarkdownBlankLines(null)).toBe('');
  });
});
