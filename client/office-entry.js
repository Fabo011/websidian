/*
 * Client bundle for read-only in-browser viewing of office documents.
 *
 * Exposes `window.OfficeViewer` with renderers for Word (.docx), spreadsheets
 * (.xlsx/.xls/.ods) and OpenDocument text (.odt). Built by esbuild into
 * public/js/office-bundle.js and lazy-loaded by app.js only when needed.
 *
 * Files are fetched from /api/attachment (decrypted server-side) as raw bytes
 * and rendered entirely on the client; nothing is uploaded anywhere.
 */
import { renderAsync as renderDocxAsync } from 'docx-preview';
import { strFromU8, unzipSync } from 'fflate';
import * as XLSX from 'xlsx';

/** Render a .docx Word document into `container`. */
async function renderDocx(container, arrayBuffer) {
  container.innerHTML = '';
  await renderDocxAsync(arrayBuffer, container, undefined, {
    className: 'wo-docx',
    inWrapper: true,
    ignoreWidth: false,
    ignoreHeight: false,
    breakPages: true,
    experimental: true,
  });
}

/** Render a spreadsheet (.xlsx/.xls/.ods) as one HTML table per sheet. */
function renderSpreadsheet(container, arrayBuffer) {
  const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
  container.innerHTML = '';
  wb.SheetNames.forEach((name) => {
    const sheet = wb.Sheets[name];
    const section = document.createElement('section');
    section.className = 'wo-sheet';
    const heading = document.createElement('h3');
    heading.className = 'wo-sheet-title';
    heading.textContent = name;
    section.appendChild(heading);
    const wrap = document.createElement('div');
    wrap.className = 'wo-sheet-table';
    wrap.innerHTML = XLSX.utils.sheet_to_html(sheet, { id: '', editable: false });
    section.appendChild(wrap);
    container.appendChild(section);
  });
}

/** Map common OpenDocument text element names to HTML tags. */
function odtTag(node) {
  const name = node.localName;
  if (name === 'h') {
    const level = parseInt(node.getAttribute('text:outline-level') || '1', 10);
    return 'h' + Math.min(6, Math.max(1, level || 1));
  }
  if (name === 'p') return 'p';
  if (name === 'list') return 'ul';
  if (name === 'list-item') return 'li';
  if (name === 'span') return 'span';
  return null;
}

/** Recursively convert an ODT content node into safe HTML elements. */
function odtToHtml(node, doc) {
  const out = doc.createDocumentFragment();
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      out.appendChild(doc.createTextNode(child.nodeValue));
      return;
    }
    if (child.nodeType !== 1) return;
    const tag = odtTag(child);
    if (tag) {
      const el = doc.createElement(tag);
      el.appendChild(odtToHtml(child, doc));
      out.appendChild(el);
    } else {
      // Unknown wrapper element: keep its text content only.
      out.appendChild(odtToHtml(child, doc));
    }
  });
  return out;
}

/** Render an OpenDocument text (.odt) file as basic, read-only HTML. */
function renderOdt(container, arrayBuffer) {
  const files = unzipSync(new Uint8Array(arrayBuffer));
  const entry = files['content.xml'];
  if (!entry) {
    throw new Error('Invalid ODT file (no content.xml).');
  }
  const xml = strFromU8(entry);
  const parser = new DOMParser();
  const xdoc = parser.parseFromString(xml, 'application/xml');
  const body =
    xdoc.getElementsByTagName('office:text')[0] ||
    xdoc.getElementsByTagName('office:body')[0];
  container.innerHTML = '';
  const article = document.createElement('article');
  article.className = 'wo-odt';
  if (body) {
    article.appendChild(odtToHtml(body, document));
  }
  container.appendChild(article);
}

window.OfficeViewer = { renderDocx, renderSpreadsheet, renderOdt };
