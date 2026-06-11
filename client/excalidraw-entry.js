// Bundled with esbuild into public/js/excalidraw-bundle.js
// Exposes a tiny global API used by public/js/app.js to mount an Excalidraw
// editor for `.excalidraw` files and serialize the scene back to JSON.

// Serve fonts/locales from the locally copied assets (offline-friendly).
window.EXCALIDRAW_ASSET_PATH = '/public/vendor/excalidraw/';

import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';

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
  mount(container, initial) {
    const handle = { api: null, root: null };
    const root = createRoot(container);
    handle.root = root;
    root.render(
      React.createElement(Excalidraw, {
        initialData: buildInitialData(initial),
        excalidrawAPI: (api) => {
          handle.api = api;
        },
      }),
    );
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
