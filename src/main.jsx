import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { EditorSessionProvider } from "./editor/EditorSessionContext";
import CrashBoundary from "./crash/CrashBoundary";
import { installGlobalHandlers, reactRootOptions } from "./crash/errorCapture";
import "./styles/crash.css";

// Crash hooks #1/#2: window handlers catch event-handler/async/Konva/Monaco
// errors; the React 19 root options catch render-phase errors (caught +
// uncaught) with componentStack. Installed before the first render so
// mount-time crashes are captured too.
installGlobalHandlers();

ReactDOM.createRoot(document.getElementById("root"), reactRootOptions).render(
  <React.StrictMode>
    <CrashBoundary>
      <EditorSessionProvider>
        <App />
      </EditorSessionProvider>
    </CrashBoundary>
  </React.StrictMode>,
);
