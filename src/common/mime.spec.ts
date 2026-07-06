import { mimeForExt } from './mime';

describe('mimeForExt', () => {
  it.each([
    ['md', 'text/markdown; charset=utf-8'],
    ['markdown', 'text/markdown; charset=utf-8'],
    ['txt', 'text/plain; charset=utf-8'],
    ['json', 'application/json; charset=utf-8'],
    ['csv', 'text/csv; charset=utf-8'],
    ['excalidraw', 'application/json; charset=utf-8'],
    ['pdf', 'application/pdf'],
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['svg', 'image/svg+xml'],
    ['bmp', 'image/bmp'],
    ['mp4', 'video/mp4'],
    ['mp3', 'audio/mpeg'],
    [
      'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [
      'xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['xls', 'application/vnd.ms-excel'],
    ['odt', 'application/vnd.oasis.opendocument.text'],
    ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['epub', 'application/epub+zip'],
  ])('maps %s to %s', (ext, mime) => {
    expect(mimeForExt(ext)).toBe(mime);
  });

  it('is case-insensitive', () => {
    expect(mimeForExt('PNG')).toBe('image/png');
    expect(mimeForExt('Md')).toBe('text/markdown; charset=utf-8');
  });

  it('falls back to octet-stream for unknown extensions', () => {
    expect(mimeForExt('exe')).toBe('application/octet-stream');
    expect(mimeForExt('')).toBe('application/octet-stream');
  });
});
