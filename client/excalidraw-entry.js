// Bundled with esbuild into public/js/excalidraw-bundle.js
// Exposes a tiny global API used by public/js/app.js to mount an Excalidraw
// editor for `.excalidraw` files and serialize the scene back to JSON.

// Serve fonts/locales from the locally copied assets (offline-friendly).
window.EXCALIDRAW_ASSET_PATH = '/public/vendor/excalidraw/';

import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw';
// @excalidraw/excalidraw >=0.17 ships no separate index.css — its styles are
// inlined in the JS bundle and injected at runtime, so no CSS import is needed.
import React from 'react';
import { createRoot } from 'react-dom/client';

// Cheap fingerprint of the drawing's *content* (not selection/scroll/zoom).
// Excalidraw bumps an element's `version` on every real edit, so summing them
// (plus a per-element +1 so add/remove also moves the number) lets onChange
// ignore pure viewport/selection churn that would otherwise spam autosave.
function sceneSig(elements) {
  if (!Array.isArray(elements)) return 0;
  let n = 0;
  for (const el of elements) {
    if (el && el.isDeleted) continue;
    n += (el && el.version ? el.version : 0) + 1;
  }
  return n;
}

function buildInitialData(initial) {
  if (!initial) {
    return undefined;
  }
  const appState = { ...(initial.appState || {}) };
  // collaborators must be a Map; drop the serialized form to avoid errors.
  delete appState.collaborators;
  return {
    elements: initial.elements || [],
    appState,
    files: initial.files || {},
  };
}

window.ExcalidrawEditor = {
  mount(container, initial, opts = {}) {
    const handle = {
      api: null,
      root: null,
      sig: sceneSig(initial && initial.elements),
      ready: false,
    };
    const root = createRoot(container);
    handle.root = root;
    root.render(
      React.createElement(Excalidraw, {
        initialData: buildInitialData(initial),
        excalidrawAPI: (api) => {
          handle.api = api;
        },
        onChange: (elements) => {
          const sig = sceneSig(elements);
          if (sig === handle.sig) return; // selection/scroll only → ignore
          handle.sig = sig;
          // Skip the initial render churn so opening a drawing never marks it
          // dirty; only real edits after mount fire the callback.
          if (handle.ready && typeof opts.onChange === 'function') {
            opts.onChange();
          }
        },
      }),
    );
    setTimeout(() => {
      handle.ready = true;
    }, 800);
    return handle;
  },

  serialize(handle) {
    if (!handle || !handle.api) {
      return '{}';
    }
    return serializeAsJSON(
      handle.api.getSceneElements(),
      handle.api.getAppState(),
      handle.api.getFiles(),
      'local',
    );
  },

  unmount(handle) {
    if (handle && handle.root) {
      handle.root.unmount();
    }
  },
};
