# Linux Build Onboarding — UX/UI Polish Plan

## Problem

Debian-based Linux distros (Ubuntu, Linux Mint, Pop!_OS) ship outdated
Node.js packages through the system package manager. Users who try to
install a modern Node version via NodeSource or apt encounter `dpkg`
conflicts because the new packages try to overwrite files owned by the
distro's bundled `libnode-dev`.

This is not a Litria bug — it is a structural issue in the
Debian → Ubuntu → Mint/Pop packaging chain. Each layer inherits packages
from the layer above and none coordinate upgrades for fast-moving tools
like Node.js.

### Affected distros (confirmed or expected)

| Distro | Base | Conflict likely? |
|--------|------|-----------------|
| Linux Mint (all versions) | Ubuntu → Debian | Yes |
| Pop!_OS | Ubuntu → Debian | Yes |
| Ubuntu (direct) | Debian | Yes |
| Debian (direct) | — | Yes |
| Fedora / RHEL | Independent | Less likely (dnf handles replacements better) |
| Arch / Manjaro | Independent (rolling) | No (always ships latest) |
| NixOS | Independent | No (isolated dependency trees) |

### Root cause

Debian's package policy prioritizes stability over currency. System
Node.js packages can be years behind upstream. Third-party repos
(NodeSource) provide modern versions but create file ownership conflicts
with the distro packages. `dpkg` refuses to overwrite files owned by
another package without `--force-overwrite`, which can break dependency
chains.

### The proven workaround

Use **nvm** (Node Version Manager) to install Node.js in userspace,
completely bypassing the system package manager:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install --lts
```

Similarly, Rust should be installed via **rustup**, not the distro package.

---

## What We Need to Build

### 1. Prerequisite checker script (`scripts/check-prereqs.sh`)

A shell script that runs before build and gives clear, distro-aware
guidance. Target output:

```
Litria Build Prerequisites
==============================
OS:       Linux Mint 22.1 (Ubuntu 24.04 base)
Arch:     x86_64

[OK]  Rust 1.78.0 (via rustup)
[OK]  cargo installed
[FAIL] Node.js — found system Node 12.22.9, need 18+
       -> Your distro ships an outdated Node.js.
       -> Install via nvm instead:
          curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
          nvm install --lts
[OK]  npm 10.2.0
[OK]  webkit2gtk-4.1-dev
[FAIL] libxdo-dev not found
       -> sudo apt install libxdo-dev
[OK]  librsvg2-dev

2 issues found. Fix them and re-run this script.
```

**Requirements:**
- Detect distro family (Debian-based, Fedora-based, Arch-based)
- Check Node version AND installation method (system vs nvm)
- Check Rust version AND installation method (system vs rustup)
- Check required system libraries
- Provide copy-pasteable fix commands specific to the detected distro
- Exit with non-zero status if anything fails
- Colorized output for terminal readability

### 2. Build-from-source documentation

A `docs/building-from-source.md` or `BUILDING.md` at repo root that covers:

- **Prerequisites by distro family** — not just a generic list, but
  explicit "if you're on Mint/Ubuntu, do this first" sections
- **Why nvm and rustup** — brief explanation so users understand they
  should NOT use `sudo apt install nodejs`
- **The check-prereqs script** — run it first, fix what it flags
- **Common errors** — the dpkg conflict, webkit2gtk version mismatches,
  missing system libs
- **FAQ** — "why can't I just use my distro's Node?" gets a one-paragraph
  answer

### 3. In-app download/status UX (future — ties into LSP management)

When Litria downloads LSP servers at runtime (pyright,
typescript-language-server), those come from npm. UI considerations:

- Show what's being downloaded and from where
- Show version being installed (pin exact versions, not ranges)
- Integrity verification (checksums) — ties into the build
  fingerprinting PRD
- Clear error messaging if npm/Node isn't available or is too old
- Consider bundling LSP binaries instead of npm-installing at runtime
  to remove the Node dependency for end users entirely

### 4. AppImage / Flatpak / .deb as primary distribution

For non-developer users, compiling should never be necessary:

- **AppImage** — single file, runs anywhere, no dependencies
- **.deb** — for users comfortable with apt (bundles everything needed)
- **Flatpak** — sandboxed, distro-agnostic, auto-updates
- Tauri v2 generates all three via `tauri build`
- Document these as the **recommended** installation method; building
  from source is for contributors only

---

## UX/UI Polish Considerations

### Error messaging philosophy

- Never show raw dpkg/npm errors to users
- Translate system errors into actionable guidance
- Detect the user's distro and tailor suggestions
- Link to relevant docs section for deeper explanation

### First-run experience on Linux

- If LSP servers need downloading and Node isn't available, show a
  friendly message explaining what's needed — not a stack trace
- Consider detecting nvm vs system Node and warning if system Node
  is ancient
- Platform config system can detect OS/distro at runtime for
  conditional UX

### Documentation tone

- Don't blame the distro or the user
- Acknowledge the problem is systemic (Debian packaging model vs
  fast-moving JS ecosystem)
- Provide the fix, explain why it works, move on

---

## Priority

| Item | Priority | Depends on |
|------|----------|------------|
| Build-from-source docs | High | Nothing — can write now |
| check-prereqs.sh script | High | Nothing — can write now |
| AppImage/Flatpak/deb builds | High | Tauri build pipeline |
| LSP download UX improvements | Medium | LSP management slices 2-7 |
| Bundled LSP binaries | Low | Research feasibility first |

---

## Related

- [Linux parity checklist](../testing/linux-parity-checklist.md)
- [Platform config system](../plans/) — slices A-F implemented
- [LSP management build plan](../plans/) — slices 2-7 not started
- [OSS security PRD](../security-audits/OSS-security-prd.md) — build fingerprinting
- [macOS feedback log](../../) — similar cross-platform concerns
