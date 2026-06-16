/* eslint-disable @typescript-eslint/no-var-requires */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function main() {
  await esbuild.build({
    entryPoints: ['client/excalidraw-entry.js'],
    bundle: true,
    format: 'iife',
    outfile: 'public/js/excalidraw-bundle.js',
    minify: true,
    sourcemap: false,
    conditions: ['production'],
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: {
      '.woff2': 'file',
      '.woff': 'file',
      '.ttf': 'file',
    },
    logLevel: 'info',
  });

  // Copy Excalidraw runtime assets (fonts, locales) for offline use.
  const src = path.join(
    'node_modules',
    '@excalidraw',
    'excalidraw',
    'dist',
    'prod',
  );
  const dest = path.join('public', 'vendor', 'excalidraw');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log('Excalidraw bundle + assets ready.');

  // Copy Bootstrap Icons (CSS + fonts) for offline use.
  const biSrc = path.join('node_modules', 'bootstrap-icons', 'font');
  const biDest = path.join('public', 'vendor', 'bootstrap-icons');
  fs.rmSync(biDest, { recursive: true, force: true });
  fs.mkdirSync(biDest, { recursive: true });
  fs.copyFileSync(
    path.join(biSrc, 'bootstrap-icons.min.css'),
    path.join(biDest, 'bootstrap-icons.min.css'),
  );
  fs.cpSync(path.join(biSrc, 'fonts'), path.join(biDest, 'fonts'), {
    recursive: true,
  });
  console.log('Bootstrap Icons assets ready.');

  // Bundle the read-only office document viewer (Word/Excel/ODT).
  await esbuild.build({
    entryPoints: ['client/office-entry.js'],
    bundle: true,
    format: 'iife',
    outfile: 'public/js/office-bundle.js',
    minify: true,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  });
  console.log('Office viewer bundle ready.');

  // Bundle the client-side markdown renderer (markdown-it + highlight.js).
  // With end-to-end encryption the server can't read note contents, so the
  // former server-side render/highlight endpoints now run in the browser.
  await esbuild.build({
    entryPoints: ['client/markdown-entry.js'],
    bundle: true,
    format: 'iife',
    outfile: 'public/js/markdown-bundle.js',
    minify: true,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  });
  console.log('Markdown renderer bundle ready.');

  // Bundle the client-side zip helper (fflate). Import/export must pack and
  // unpack archives in the browser since the server only holds ciphertext.
  await esbuild.build({
    entryPoints: ['client/zip-entry.js'],
    bundle: true,
    format: 'iife',
    outfile: 'public/js/zip-bundle.js',
    minify: true,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  });
  console.log('Zip helper bundle ready.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
