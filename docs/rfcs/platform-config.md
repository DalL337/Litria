# RFC: Runtime Platform Configuration System

**Status:** Proposed
**Date:** 2026-03-24
**Relates to:** ADR-011, macOS feedback (`docs/feedback/macos-feedback.md`)

---

## 1. Problem

Litria has zero frontend platform awareness. Every UI element assumes Windows: placeholder paths, modifier key labels, window controls, hidden file filters, terminal shell defaults. macOS testing exposed 6+ issues traceable to this single gap.

---

## 2. Design Overview

Two layers, matching the two execution contexts:

```
┌─────────────────────────────────────────────────┐
│  Rust (main.rs)                                 │
│  ┌───────────────────────────────────────────┐  │
│  │ detect OS (std::env::consts::OS)          │  │
│  │ configure window (decorations, titlebar)  │  │
│  │ expose get_platform_config command        │  │
│  └───────────────────────────────────────────┘  │
│                    │                             │
│                    ▼ Tauri command               │
│  ┌───────────────────────────────────────────┐  │
│  │ Frontend (platformConfig.js)              │  │
│  │ call get_platform_config on mount         │  │
│  │ resolve platformDefaults[os]              │  │
│  │ export usePlatformConfig() hook           │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## 3. Layer 1 — Rust (Pre-Window)

### 3.1 Detection

```rust
// src-tauri/src/platform.rs

pub struct PlatformConfig {
    pub os: String,           // "macos", "windows", "linux"
    pub decorations: bool,    // false on Windows (custom chrome), true on macOS
    pub titlebar_style: Option<String>, // "overlay" on macOS, None on Windows
    pub modifier_key: String, // "⌘" on macOS, "Ctrl" on Windows/Linux
}

pub fn detect_platform() -> PlatformConfig {
    let os = std::env::consts::OS; // "macos", "windows", "linux"
    match os {
        "macos" => PlatformConfig {
            os: "macos".into(),
            decorations: true,
            titlebar_style: Some("overlay".into()),
            modifier_key: "⌘".into(),
        },
        "windows" => PlatformConfig {
            os: "windows".into(),
            decorations: false,
            titlebar_style: None,
            modifier_key: "Ctrl".into(),
        },
        _ => PlatformConfig {
            os: os.into(),
            decorations: false,
            titlebar_style: None,
            modifier_key: "Ctrl".into(),
        },
    }
}
```

### 3.2 Window Configuration

In `main.rs`, before `tauri::Builder`:

```rust
let platform = platform::detect_platform();

// Configure window based on platform
let mut window_builder = WindowBuilder::new(...)
    .decorations(platform.decorations);

if let Some(style) = &platform.titlebar_style {
    // macOS: native traffic lights overlaid on app content
    window_builder = window_builder.title_bar_style(
        tauri::TitleBarStyle::Overlay
    );
}
```

### 3.3 Tauri Command

```rust
#[tauri::command]
pub fn get_platform_config() -> PlatformConfig {
    detect_platform()
}
```

Registered in `main.rs` invoke handler. Called once by frontend on mount.

---

## 4. Layer 2 — Frontend

### 4.1 Platform Defaults

```js
// src/platform/platformDefaults.js

const PLATFORM_DEFAULTS = {
  macos: {
    os: 'macos',
    modifierKey: '⌘',
    modifierKeyCode: 'Meta',
    altKeyLabel: '⌥',
    placeholderPath: '~/Projects/my-project',
    placeholderNewProjectPath: '~/Projects/python-projects',
    hiddenFiles: ['.DS_Store', '._*', '.Spotlight-V100', '.Trashes'],
    preferredShell: '$SHELL',   // resolved by Rust from env
    shellFallbackOrder: ['zsh', 'bash', 'sh'],
    showWindowControls: false,  // use native traffic lights
    shortcutLabels: {
      save: '⌘S',
      undo: '⌘Z',
      redo: '⇧⌘Z',
      find: '⌘F',
      split: '⌘\\',
      palette: '⌘K',
    },
  },

  windows: {
    os: 'windows',
    modifierKey: 'Ctrl',
    modifierKeyCode: 'Control',
    altKeyLabel: 'Alt',
    placeholderPath: 'C:\\Projects\\my-project',
    placeholderNewProjectPath: 'C:\\Projects\\python-projects',
    hiddenFiles: ['Thumbs.db', 'desktop.ini'],
    preferredShell: 'powershell',
    shellFallbackOrder: ['powershell', 'cmd'],
    showWindowControls: true,
    shortcutLabels: {
      save: 'Ctrl+S',
      undo: 'Ctrl+Z',
      redo: 'Ctrl+Y',
      find: 'Ctrl+F',
      split: 'Ctrl+\\',
      palette: 'Ctrl+K',
    },
  },

  linux: {
    os: 'linux',
    modifierKey: 'Ctrl',
    modifierKeyCode: 'Control',
    altKeyLabel: 'Alt',
    placeholderPath: '~/projects/my-project',
    placeholderNewProjectPath: '~/projects/python-projects',
    hiddenFiles: ['.directory'],
    preferredShell: '$SHELL',
    shellFallbackOrder: ['bash', 'zsh', 'sh'],
    showWindowControls: true,
    shortcutLabels: {
      save: 'Ctrl+S',
      undo: 'Ctrl+Z',
      redo: 'Ctrl+Shift+Z',
      find: 'Ctrl+F',
      split: 'Ctrl+\\',
      palette: 'Ctrl+K',
    },
  },
};

export default PLATFORM_DEFAULTS;
```

### 4.2 Hook

```js
// src/platform/usePlatformConfig.js

import { createContext, useContext } from 'react';
import PLATFORM_DEFAULTS from './platformDefaults';

export const PlatformContext = createContext(PLATFORM_DEFAULTS.windows);

export function usePlatformConfig() {
  return useContext(PlatformContext);
}
```

### 4.3 Initialization (App.jsx)

```js
import { PlatformContext } from './platform/usePlatformConfig';
import PLATFORM_DEFAULTS from './platform/platformDefaults';
import { invoke } from '@tauri-apps/api/core';

// On mount, before first render of platform-sensitive UI:
const [platformConfig, setPlatformConfig] = useState(PLATFORM_DEFAULTS.windows);

useEffect(() => {
  invoke('get_platform_config').then(config => {
    const defaults = PLATFORM_DEFAULTS[config.os] || PLATFORM_DEFAULTS.windows;
    setPlatformConfig(defaults);
  });
}, []);

// In JSX:
<PlatformContext.Provider value={platformConfig}>
  {/* app content */}
</PlatformContext.Provider>
```

### 4.4 Usage in Components

```js
// Any component:
const { placeholderPath, showWindowControls, shortcutLabels } = usePlatformConfig();

// LaunchScreen.jsx
<input placeholder={placeholderPath} />

// MenuBar.jsx
{showWindowControls && <WindowControls />}

// DropdownMenuItem
<DropdownMenuShortcut>{shortcutLabels.save}</DropdownMenuShortcut>
```

---

## 5. Scaffold Hidden File Filter

The `hiddenFiles` array feeds into the scaffold tree builder. Currently the scaffold filters `litria.project.json` — extend the filter to include platform-specific entries:

```js
const { hiddenFiles } = usePlatformConfig();

function shouldHideFile(filename) {
  return hiddenFiles.some(pattern => {
    if (pattern.endsWith('*')) {
      return filename.startsWith(pattern.slice(0, -1));
    }
    return filename === pattern;
  });
}
```

This handles both exact matches (`.DS_Store`) and prefix patterns (`._*`).

---

## 6. Terminal Shell Resolution

The Rust terminal policy already branches on `#[cfg(target_os)]` for the shell allowlist. The enhancement is **preference order**:

1. Read `$SHELL` env var (user's configured shell)
2. If `$SHELL` is in the allowlist, use it
3. Otherwise, fall through the platform's `shellFallbackOrder`

This is a Rust-side change in `terminal_policy.rs`, informed by the platform config but not dependent on the frontend layer.

---

## 7. macOS Window Chrome

The most impactful platform-specific change. On macOS:

- `decorations: true` — native window frame with traffic lights
- `titlebar_style: "overlay"` — traffic lights float over app content
- Custom `WindowControls` component hidden (`showWindowControls: false`)
- Top padding added to account for native titlebar overlay height (~28px)
- Native macOS menu bar used alongside Litria's custom menu bar, OR Litria's custom menu bar rendered below the native titlebar area

This resolves feedback #2 (maximize crash) and #9 (double menubar) together.

---

## 8. What This System Does NOT Cover

- Compile-time Rust branching (`#[cfg(target_os)]`) — stays as-is for backend-only concerns
- Keyboard shortcut *registration* — this system provides labels, not keybinding logic
- File path separator normalization — already handled by `normalizePath` utilities
- Platform-specific build artifacts — covered by ADR-010

---

## 9. File Structure

```
src-tauri/src/
  platform.rs              — PlatformConfig struct + detect_platform()
  main.rs                  — window config from platform, register command

src/platform/
  platformDefaults.js      — OS → UI behavior mapping
  usePlatformConfig.js     — React context + hook
```

Two new Rust files, two new JS files, plus integration points in `main.rs` and `App.jsx`.
