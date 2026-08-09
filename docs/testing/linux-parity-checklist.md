# Linux Parity Test Checklist

Quick validation checklist for confirming Litria works on Linux.
Items are ranked by priority — complete **Required** items first, then move
to **Nice to Have** if time allows.

---

## Environment Setup

### System Dependencies (Tauri v2 on Ubuntu / Pop!_OS)

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf
```

### Toolchain

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Node 18+ (nvm recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install --lts
```

### Clone and Run

```bash
git clone https://github.com/DalL337/litria.git
cd litria
npm install
npm run tauri dev
```

> First build compiles the Rust backend and may take several minutes.

---

## Required

These items confirm the app is fundamentally functional on Linux. A failure
here is a blocker.

### 1. App Launches

| #  | Check | Pass? |
|----|-------|-------|
| 1  | `npm run tauri dev` completes without errors | |
| 2  | App window appears (not blank white or crashed) | |
| 3  | Launcher modal is visible on first open | |

### 2. Window Management

| #  | Check | Pass? |
|----|-------|-------|
| 4  | Custom title bar renders (Litria uses `decorations: false`) | |
| 5  | Window can be moved by dragging the title bar | |
| 6  | Minimize, maximize, and close buttons work | |
| 7  | Window can be resized by dragging edges | |

### 3. Core UI

| #  | Check | Pass? |
|----|-------|-------|
| 8  | File scaffold tree loads when opening or creating a project | |
| 9  | Canvas renders and shows puzzle pieces for files | |
| 10 | Clicking a piece opens the Monaco editor with syntax highlighting | |
| 11 | Terminal panel opens and runs commands (should detect your shell, not default to `sh`) | |

### 4. Editor Basics

| #  | Check | Pass? |
|----|-------|-------|
| 12 | Can type in the editor without lag or visual glitches | |
| 13 | Editor tabs open and close correctly | |
| 14 | Scrolling works in both editor and scaffold tree | |

### 5. Clean Shutdown

| #  | Check | Pass? |
|----|-------|-------|
| 15 | Closing the window exits the app | |
| 16 | No lingering process after close (`ps aux \| grep litria` returns nothing) | |

---

## Nice to Have

These confirm deeper feature parity and polish. Report what you can, but
don't worry if you can't get to all of them.

### 6. Canvas Interaction

| #  | Check | Pass? |
|----|-------|-------|
| 17 | Pieces can be dragged to new positions | |
| 18 | Pieces can be grouped and collapsed | |
| 19 | Canvas pans with middle-click or scroll (should not activate unexpectedly) | |
| 20 | Zoom in/out works (Ctrl+scroll) | |

### 7. Theme and Styling

| #  | Check | Pass? |
|----|-------|-------|
| 21 | Glass theme looks correct (no missing colors, transparent gaps, or unstyled elements) | |
| 22 | Fonts render cleanly (no tofu characters or fallback fonts in editor) | |
| 23 | Icons and SVGs display properly | |

### 8. LSP — Language Intelligence

> Requires: `npm install -g pyright typescript typescript-language-server`
> and Python 3.8+ on PATH.

| #  | Check | Pass? |
|----|-------|-------|
| 24 | Open a `.py` file — hover shows type info | |
| 25 | Open a `.py` file — completions appear when typing | |
| 26 | Open a `.ts` file — hover shows type info | |
| 27 | Open a `.ts` file — completions appear when typing | |
| 28 | Status bar shows LSP connection status | |

### 9. Tiling Window Manager (Pop!_OS auto-tiling)

| #  | Check | Pass? |
|----|-------|-------|
| 29 | App tiles correctly to half-screen with keyboard shortcut | |
| 30 | App tiles correctly via drag-to-edge (may not work with custom title bar) | |
| 31 | UI remains usable when tiled to half-height (top drawer may eat vertical space) | |

### 10. Misc Platform Checks

| #  | Check | Pass? |
|----|-------|-------|
| 32 | No hidden/system files (like `.DS_Store`) appear in the scaffold tree | |
| 33 | File paths display with forward slashes, no Windows-style backslashes | |
| 34 | Creating a new file in scaffold works and appears on canvas | |

---

## Reporting Results

Copy this file, fill in the **Pass?** columns with one of:

- **Y** — works as expected
- **N** — broken (please describe what happened)
- **P** — partial (works but with issues worth noting)
- **S** — skipped

For any **N** or **P**, a short description and/or screenshot is very helpful.
Include your distro, kernel version (`uname -r`), and desktop environment.

---

## Known Risks on Linux

These are things we expect _might_ behave differently:

- **Custom title bar**: Litria sets `decorations: false` in Tauri config. Window
  controls render inside the app. Drag-to-tile with the mouse may not work
  under COSMIC / Pop tiling — keyboard shortcuts should still work.
- **Vertical space**: The top drawer is 300px. In a half-height tile this
  may feel cramped.
- **WebKitGTK rendering**: Linux uses WebKitGTK instead of Windows WebView2.
  Minor visual differences in font rendering or scrollbar style are expected
  and not bugs unless they break usability.
