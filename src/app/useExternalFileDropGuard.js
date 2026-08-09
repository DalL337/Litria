import { useEffect } from 'react';

/**
 * Block the webview's default handling of EXTERNAL file drags (an Explorer
 * file dropped on the window would otherwise navigate the webview to it).
 *
 * Needed because tauri.conf.json sets `dragDropEnabled: false`: Tauri's
 * native drag-drop interception is what normally eats OS file drops, but on
 * Windows/WebView2 that same interception swallows the page's OWN HTML5
 * drag events (dragover never reaches JS, everything shows the no-drop
 * cursor) — which broke the ADR-017 tab→pane drag. Litria uses no native
 * file-drop events, so the interception is pure cost.
 *
 * The `Files` type filter keeps internal drags (tab mime) untouched: they
 * keep accurate drop-target feedback from their own handlers.
 */
export function useExternalFileDropGuard() {
  useEffect(() => {
    const isExternalFileDrag = (event) => {
      const types = event.dataTransfer?.types;
      return types ? Array.from(types).includes('Files') : false;
    };
    const onDragOver = (event) => {
      if (isExternalFileDrag(event)) event.preventDefault();
    };
    const onDrop = (event) => {
      if (isExternalFileDrag(event)) event.preventDefault();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}
