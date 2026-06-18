/* Throwaway generator: minimal valid .docx/.xlsx/.odt for preview testing. */
const { zipSync, strToU8 } = require('fflate');
const fs = require('fs');

// ---------- .docx (OOXML WordprocessingML) ----------
const docx = zipSync({
  '[Content_Types].xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  ),
  '_rels/.rels': strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  ),
  'word/document.xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>` +
      `<w:p><w:r><w:t>Hello from test.docx</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>Second paragraph for preview check.</w:t></w:r></w:p>` +
      `</w:body></w:document>`,
  ),
});
fs.writeFileSync('test.docx', docx);

// ---------- .xlsx (OOXML SpreadsheetML) ----------
const xlsx = zipSync({
  '[Content_Types].xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`,
  ),
  '_rels/.rels': strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  ),
  'xl/workbook.xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  ),
  'xl/_rels/workbook.xml.rels': strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`,
  ),
  'xl/worksheets/sheet1.xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>` +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>Alpha</t></is></c><c r="B2"><v>42</v></c></row>` +
      `<row r="3"><c r="A3" t="inlineStr"><is><t>Beta</t></is></c><c r="B3"><v>7</v></c></row>` +
      `</sheetData></worksheet>`,
  ),
});
fs.writeFileSync('test.xlsx', xlsx);

// ---------- .odt (OpenDocument Text) ----------
// mimetype MUST be the first entry and stored uncompressed per ODF spec.
const odt = zipSync(
  {
    mimetype: [
      strToU8('application/vnd.oasis.opendocument.text'),
      { level: 0 },
    ],
    'META-INF/manifest.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">` +
        `<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>` +
        `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
        `</manifest:manifest>`,
    ),
    'content.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<office:document-content ` +
        `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
        `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">` +
        `<office:body><office:text>` +
        `<text:h text:outline-level="1">Test ODT Heading</text:h>` +
        `<text:p>First paragraph of the OpenDocument text file.</text:p>` +
        `<text:p>Second paragraph for preview check.</text:p>` +
        `</office:text></office:body></office:document-content>`,
    ),
  },
  { level: 6 },
);
fs.writeFileSync('test.odt', odt);

console.log('Wrote test.docx, test.xlsx, test.odt');
