# Bundled Runtime Build Plan — Node.js + Core Language Servers

## Status
- Proposed (2026-04-03)

## References
- ADR-004: Bundled Core Language Servers and Node.js Runtime
- Parent plan: `language-server-management-build-plan.md` (slices 1-7)
- Architecture: `lsp-client-architecture.md` Section 15
- Version pins: `src-tauri/src/lsp/packs/versions.rs`

## Scope

This plan implements ADR-004's full scope: bundle **Node.js LTS**, **Pyright**, and **TypeScript Language Server** into the Litria installer so that language intelligence works on first launch with zero user configuration.

The parent build plan (slices 1-7) was written before ADR-004 added Node.js bundling. Decision D2 in that plan ("Node.js is a stated system requirement") is superseded by this plan. Slices 1-2 from the parent plan are incorporated here with modifications. Slices 3-7 (registry, download infrastructure, install UI, settings panel) remain unchanged and are out of scope.

### What Changes From the Parent Plan
- Node.js is now bundled (not a system requirement)
- Size budget: ~55-65 MB → ~110 MB
- Build pipeline must handle platform-specific native binaries (Node.js)
- Prerequisite flow changes: Node.js found in bundle satisfies the Node prereq
- First-run extraction needed for Node.js (native binary, needs +x on Unix)

### What Does NOT Change
- `ResolvedCommand` enum and resolution layer design (Slice 1)
- Pyright + tsserver bundling as pure JS in resources (Slice 2a)
- Global-first precedence rule
- Transport layer, pack system, session lifecycle, IPC bridge

---

## Size Budget

| Component | Raw Size | Compressed (est.) |
|-----------|----------|-------------------|
| Litria binary + webview | ~12 MB | ~8 MB |
| Pyright | ~28 MB | ~5 MB |
| TS Language Server + compiler | ~23 MB | ~4.5 MB |
| Node.js LTS (per-platform) | ~40 MB | ~15 MB |
| **Total** | **~103 MB** | **~32 MB** |

Installer target: **≤120 MB**. Competitive: VS Code ~150 MB, JetBrains ~500 MB.

Only one platform's Node.js binary ships per installer (Windows build gets win-x64, macOS gets darwin-arm64 + darwin-x64 universal, Linux gets linux-x64).

---

## Slice A: Resolution Layer (Rust Plumbing)

**Goal**: Introduce the `ResolvedCommand` abstraction so spawn and prerequisite detection can work with dynamic paths. No bundled files yet — just the plumbing.

**Why first**: Every subsequent slice depends on this. The existing `LanguagePack.command: &'static str` cannot hold runtime-resolved paths. This slice is pure refactor with zero user-visible change.

**Corresponds to**: Parent plan Slice 1, unchanged.

### A1. `ResolvedCommand` type

Add to `src-tauri/src/lsp/packs/mod.rs`:

```rust
use std::path::PathBuf;

/// How a language server executable was located.
#[derive(Debug, Clone)]
pub(crate) enum ResolutionTier {
    /// Found on system PATH (current behavior).
    Global,
    /// Found in ~/.litria/servers/ (managed install).
    Managed,
    /// Found in Tauri resource directory (shipped with Litria).
    Bundled,
}

/// A fully resolved command ready for spawn.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedCommand {
    /// The executable to run (node path for JS servers, binary path for native).
    pub executable: PathBuf,
    /// Additional args prepended before pack.args (e.g., the JS entry script).
    pub prefix_args: Vec<String>,
    /// How it was found.
    pub tier: ResolutionTier,
}
```

The existing `LanguagePack` struct keeps `command: &'static str` — it still describes *what* to look for on PATH. `ResolvedCommand` describes *what was actually found*.

### A2. `resolve_server()` function

Create `src-tauri/src/lsp/resolver.rs`:

```rust
/// Resolve a language server executable through the 3-tier fallback chain.
///
/// Priority: Global PATH → Managed directory → Bundled resources.
///
/// Returns None if no tier can satisfy the server requirement.
pub(crate) fn resolve_server(
    pack: &LanguagePack,
    app: &AppHandle,
) -> Option<ResolvedCommand> {
    // Tier 1: Global PATH (existing behavior)
    if let Some(resolved) = probe_global(pack) {
        return Some(resolved);
    }
    // Tier 2: Managed directory (~/.litria/servers/)
    if let Some(resolved) = probe_managed(pack) {
        return Some(resolved);
    }
    // Tier 3: Bundled resources
    if let Some(resolved) = probe_bundled(pack, app) {
        return Some(resolved);
    }
    None
}
```

Each `probe_*` function returns `Option<ResolvedCommand>`.

- `probe_global`: runs existing `probe_prerequisite` logic on `pack.command`. On Windows, uses existing `resolve_cmd_to_node()` from transport.rs. Returns `ResolvedCommand { executable: <node or binary path>, tier: Global }`.
- `probe_managed`: checks `~/.litria/servers/{language_id}/` for the expected entry point. Stub returning `None` in this slice.
- `probe_bundled`: checks `app.path().resource_dir()` for the expected entry point. Stub returning `None` in this slice.

### A3. Resolve bundled Node.js path

Add a parallel resolver for the Node.js runtime itself:

```rust
/// Resolve Node.js through the same 3-tier chain.
/// Used when spawning JS-based language servers.
pub(crate) fn resolve_node(app: &AppHandle) -> Option<PathBuf> {
    // 1. System PATH
    if probe_command_exists("node") {
        return Some(PathBuf::from("node"));
    }
    // 2. Bundled node
    if let Some(path) = bundled_node_path(app) {
        if path.exists() {
            return Some(path);
        }
    }
    None
}
```

This is separate from `resolve_server` because Node.js is a shared runtime, not a per-language server. Both pyright and tsserver need it.

### A4. Update `spawn_server()` signature

Change `spawn_server` in `transport.rs` to accept `ResolvedCommand`:

```rust
pub(crate) fn spawn_server(
    pack: &LanguagePack,
    resolved: &ResolvedCommand,  // NEW — replaces pack.command usage
    project_root: &str,
    app: AppHandle,
    on_message: impl Fn(AppHandle, IncomingMessage) + Send + 'static,
    on_crash: impl FnOnce() + Send + 'static,
) -> Result<LspTransport, String> {
    let mut cmd = Command::new(&resolved.executable);
    // Prepend JS script path (for bundled/managed JS servers)
    for arg in &resolved.prefix_args {
        cmd.arg(arg);
    }
    cmd.args(&pack.args);
    // ... rest unchanged ...
}
```

On Windows, when `resolved.tier` is `Global`, the existing `resolve_cmd_to_node()` logic still applies (it's now handled inside `probe_global`). For `Bundled`/`Managed` tiers, the executable is already a direct path — no .cmd resolution needed.

### A5. Update `start_session()` call site

In `session.rs`, change `start_session` to call `resolve_server()` before `spawn_server()`:

```rust
pub(crate) fn start_session(...) -> CommandResult<...> {
    let pack = get_pack(language_id).ok_or_else(|| ...)?;

    // NEW: resolve the server executable
    let resolved = resolver::resolve_server(&pack, app)
        .ok_or_else(|| CommandError::not_found(
            &format!("{language_id}.server.not_found"),
            format!("No {} server found (checked PATH, managed, bundled)", language_id),
        ))?;

    let transport = transport::spawn_server(
        &pack,
        &resolved,  // NEW
        project_root,
        app.clone(),
        on_message,
        on_crash,
    )?;
    // ... rest unchanged ...
}
```

### A6. Update `detect_prerequisites` to report resolution tier

Add `resolution_tier` to `LspPrerequisitesPayload`:

```rust
pub(crate) struct LspPrerequisitesPayload {
    pub language_id: String,
    pub all_met: bool,
    pub probes: Vec<PrerequisiteProbeResult>,
    pub resolution_tier: Option<String>,  // NEW: "global" | "managed" | "bundled" | null
}
```

The frontend can display "Using bundled Pyright" vs "Using global Pyright v1.1.408" in the status area.

### Tests
- `resolve_server` returns `None` when no tier has the server
- `resolve_server` returns `Global` when command is on PATH
- `probe_managed` and `probe_bundled` return `None` (stubs)
- `spawn_server` works identically for `Global` resolution (regression)
- `resolve_node` finds system node when available
- `detect_prerequisites` includes `resolution_tier` in response

### Acceptance
- `cargo test` passes
- `cargo clippy` clean
- Existing Python + TS sessions work exactly as before (no user-visible change)
- `lsp_detect_prerequisites` response includes `resolution_tier: "global"`

---

## Slice B: Bundle Core JS Servers (Pyright + tsserver)

**Goal**: Ship pyright + typescript-language-server + typescript compiler as pre-installed npm packages in the Tauri resources directory. Language intelligence works without `npm install -g` — but still requires Node.js (either global or bundled in Slice C).

**Why before Node.js**: The JS servers are pure JavaScript — no platform-specific binaries, no extraction, no permissions issues. This is the simpler half of the bundling problem and delivers immediate value for users who already have Node.js installed.

**Corresponds to**: Parent plan Slice 2, with Node.js bundling deferred to Slice C.

### B1. Server packaging script

Create `scripts/bundle-servers.mjs`:

```javascript
// Downloads pinned versions of pyright + typescript-language-server + typescript
// and installs them into src-tauri/resources/servers/ for Tauri bundling.
//
// Usage: node scripts/bundle-servers.mjs
// Idempotent — safe to re-run. Checks versions before downloading.

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const RESOURCES = join(import.meta.dirname, "..", "src-tauri", "resources", "servers");

// Read pinned versions from versions.rs (single source of truth)
function readVersionPin(name) { /* parse versions.rs for the constant */ }

const PYRIGHT_VERSION = readVersionPin("PYRIGHT_VERSION");
const TSSERVER_VERSION = readVersionPin("TSSERVER_VERSION");
const TYPESCRIPT_VERSION = readVersionPin("TYPESCRIPT_VERSION");

// Install into isolated prefix directories (no global pollution)
function installServer(dir, packages) {
    mkdirSync(dir, { recursive: true });
    execSync(`npm install --prefix "${dir}" ${packages.join(" ")}`, {
        stdio: "inherit",
    });
}

installServer(
    join(RESOURCES, "python"),
    [`pyright@${PYRIGHT_VERSION}`]
);

installServer(
    join(RESOURCES, "typescript"),
    [`typescript-language-server@${TSSERVER_VERSION}`, `typescript@${TYPESCRIPT_VERSION}`]
);
```

Key decisions:
- Uses `npm install --prefix` to create isolated `node_modules/` trees (no global install, no symlinks to manage)
- Parses version pins from `versions.rs` so there's a single source of truth
- Idempotent — checks `package.json` version before re-downloading

### B2. .gitignore + Tauri resource config

Add to `.gitignore`:
```
src-tauri/resources/servers/
```

Add to `tauri.conf.json`:
```json
"bundle": {
    "resources": {
        "resources/servers/**/*": "servers/"
    }
}
```

**Note**: Tauri v2 resource paths are relative to the `src-tauri/` directory in the config, and land in the app's resource directory at runtime.

### B3. Wire `probe_bundled` into resolver

Implement the bundled probe stub from Slice A:

```rust
fn probe_bundled(pack: &LanguagePack, app: &AppHandle) -> Option<ResolvedCommand> {
    let resource_dir = app.path().resource_dir().ok()?;

    let entry_point = match pack.language_id {
        "python" => resource_dir
            .join("servers/python/node_modules/pyright/langserver.index.js"),
        "typescript" => resource_dir
            .join("servers/typescript/node_modules/typescript-language-server/lib/cli.mjs"),
        _ => return None,
    };

    if !entry_point.exists() {
        return None;
    }

    // Resolve Node.js (global or bundled — Slice C adds the bundled path)
    let node = resolver::resolve_node(app)?;

    Some(ResolvedCommand {
        executable: node,
        prefix_args: vec![entry_point.to_string_lossy().into_owned()],
        tier: ResolutionTier::Bundled,
    })
}
```

### B4. Update prerequisite semantics

When a bundled server is found, the prerequisite for the server binary itself should pass even if it's not on global PATH:

- `pyright` prereq: passes if global pyright found OR bundled entry point exists
- `typescript-language-server` prereq: same logic
- `tsc` prereq: passes if bundled typescript includes `tsc.js`
- `node` prereq: still required on PATH (until Slice C bundles it)
- `python` prereq: still required on PATH (user's project dependency)

Update `detect_prerequisites` to run the resolver first and skip probing commands that are satisfied by bundled/managed tiers.

### B5. Build integration

Add `bundle-servers` to the build chain. Two options:

**Option 1 — npm script (recommended for dev)**:
```json
// package.json
"scripts": {
    "bundle-servers": "node scripts/bundle-servers.mjs",
    "prebuild": "npm run bundle-servers",
}
```

**Option 2 — CI only**:
- Dev builds: use global installs (current behavior, fast iteration)
- CI/release builds: run `bundle-servers` before `tauri build`
- Gated by `CI=true` or explicit flag

Recommend Option 2: keep dev builds fast, only bundle for release. The resolver naturally falls back to global when bundled isn't present.

### Tests
- Bundled entry point path resolves correctly from mock resource dir
- `probe_bundled` returns `None` when resource dir is empty
- `probe_bundled` returns `Bundled` when entry point exists and node is available
- `probe_bundled` returns `None` when entry point exists but node is NOT available
- Global install still takes precedence over bundled (resolver order)
- Prerequisite detection passes with bundled server (no global install needed)
- Session starts successfully with bundled server path

### Acceptance
- Release build: fresh machine with Node.js but no `npm install -g pyright` → open `.py` file → diagnostics appear
- `detect_prerequisites` shows `resolution_tier: "bundled"` for pyright and tsserver
- Dev build: no bundled servers present → falls back to global (current behavior, no regression)
- `scripts/bundle-servers.mjs` runs clean, produces expected directory structure
- Bundle size increase: ≤ 55 MB (JS servers only, before Node.js)

---

## Slice C: Bundle Node.js Runtime

**Goal**: Ship a platform-specific Node.js LTS binary so Litria provides language intelligence and scaffold execution with zero external dependencies (except Python runtime for pyright's analysis target).

**Why this is the hardest slice**: Node.js is a native binary. Unlike the pure-JS servers in Slice B, it requires:
- Platform-specific downloads (win-x64, darwin-arm64, darwin-x64, linux-x64)
- Executable permissions on Unix (can't run from read-only resource dir)
- First-run extraction from resources to a writable app-data location
- Hash verification for integrity

### C1. Platform-specific Node.js download script

Extend `scripts/bundle-servers.mjs` (or create `scripts/bundle-node.mjs`):

```javascript
// Downloads the correct Node.js LTS binary for the current build target
// and stages it in src-tauri/resources/node/ for Tauri bundling.

import { execSync } from "child_process";
import { createHash } from "crypto";
import { createReadStream, createWriteStream, mkdirSync } from "fs";
import { pipeline } from "stream/promises";

const NODE_VERSION = readVersionPin("NODE_VERSION");  // from versions.rs

// Platform detection for cross-compilation support
const platform = process.env.TAURI_TARGET_TRIPLE || detectPlatform();

const ARTIFACTS = {
    "x86_64-pc-windows-msvc": {
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
        sha256: "<hash>",        // populated per version
        extract: "zip",
        binary: "node.exe",
    },
    "aarch64-apple-darwin": {
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
        sha256: "<hash>",
        extract: "tar.gz",
        binary: "bin/node",
    },
    "x86_64-apple-darwin": {
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
        sha256: "<hash>",
        extract: "tar.gz",
        binary: "bin/node",
    },
    "x86_64-unknown-linux-gnu": {
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`,
        sha256: "<hash>",
        extract: "tar.xz",
        binary: "bin/node",
    },
};

// 1. Download archive to temp
// 2. Verify SHA256
// 3. Extract node binary + npm to src-tauri/resources/node/
// 4. Verify extracted binary runs: node --version
```

Key decisions:
- Only extracts `node` binary + `npm` (not the full Node.js distribution — skip docs, headers, etc.)
- SHA256 hashes checked into the script (or a companion `node-hashes.json`)
- Uses `TAURI_TARGET_TRIPLE` env var for cross-compilation awareness
- npm ships inside the node distribution — extract `lib/node_modules/npm/` alongside the binary

### C2. Tauri resource config for Node.js

Extend the resource mapping in `tauri.conf.json`:

```json
"bundle": {
    "resources": {
        "resources/servers/**/*": "servers/",
        "resources/node/**/*": "node/"
    }
}
```

Directory structure after bundling:
```
src-tauri/resources/
├── node/
│   ├── node.exe           (Windows) or bin/node (Unix)
│   └── node_modules/
│       └── npm/           (npm CLI)
└── servers/
    ├── python/
    │   └── node_modules/pyright/...
    └── typescript/
        └── node_modules/typescript-language-server/...
        └── node_modules/typescript/...
```

### C3. First-run extraction module

**Why extraction is needed**: On macOS, the app bundle is code-signed and read-only. On Linux, AppImage/Flatpak resources are read-only. The bundled Node.js binary must be copied to a writable location and marked executable.

Create `src-tauri/src/bundled_runtime.rs`:

```rust
use std::path::PathBuf;
use std::fs;
use tauri::AppHandle;

/// Location where extracted bundled runtimes live.
/// Platform-specific:
///   Windows: %LOCALAPPDATA%/com.litria.app/runtimes/
///   macOS:   ~/Library/Application Support/com.litria.app/runtimes/
///   Linux:   ~/.local/share/com.litria.app/runtimes/
fn runtimes_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|p| p.join("runtimes"))
}

/// Extracted node binary path.
pub(crate) fn extracted_node_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = runtimes_dir(app)?;
    let binary = if cfg!(windows) { "node.exe" } else { "bin/node" };
    Some(dir.join("node").join(binary))
}

/// Ensure the bundled Node.js binary is extracted and ready.
///
/// Idempotent: skips extraction if the correct version is already present.
/// Called at app startup (non-blocking — spawned on background thread).
pub(crate) fn ensure_node_extracted(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?;
    let dest_dir = runtimes_dir(app)
        .ok_or("Cannot determine app data directory")?
        .join("node");

    let version_file = dest_dir.join(".node-version");
    let expected_version = super::lsp::packs::versions::NODE_VERSION;

    // Skip if already extracted at correct version
    if version_file.exists() {
        let installed = fs::read_to_string(&version_file).unwrap_or_default();
        if installed.trim() == expected_version {
            let node_path = extracted_node_path(app)
                .ok_or("Cannot determine node path")?;
            if node_path.exists() {
                return Ok(node_path);
            }
        }
    }

    // Extract from resources
    let source = if cfg!(windows) {
        resource_dir.join("node")
    } else {
        resource_dir.join("node")
    };

    if !source.exists() {
        return Err("Bundled Node.js not found in resources".into());
    }

    // Clean previous extraction
    if dest_dir.exists() {
        fs::remove_dir_all(&dest_dir)
            .map_err(|e| format!("cleanup: {e}"))?;
    }

    // Copy tree
    copy_dir_recursive(&source, &dest_dir)?;

    // Set executable permission on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let node_path = dest_dir.join("bin/node");
        if node_path.exists() {
            let mut perms = fs::metadata(&node_path)
                .map_err(|e| format!("metadata: {e}"))?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&node_path, perms)
                .map_err(|e| format!("chmod: {e}"))?;
        }
    }

    // Write version marker
    fs::write(&version_file, expected_version)
        .map_err(|e| format!("version marker: {e}"))?;

    extracted_node_path(app)
        .ok_or("Cannot determine node path after extraction".into())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("readdir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("copy {} → {}: {e}", src_path.display(), dst_path.display()))?;
        }
    }
    Ok(())
}
```

### C4. Wire bundled Node.js into `resolve_node()`

Update `resolver.rs`:

```rust
pub(crate) fn resolve_node(app: &AppHandle) -> Option<PathBuf> {
    // 1. System PATH (global takes precedence)
    if probe_command_exists("node") {
        // Verify version >= 18
        if let Some(version) = probe_node_version_from_path() {
            if version.major >= 18 {
                return Some(PathBuf::from("node"));
            }
        }
    }
    // 2. Extracted bundled node
    if let Some(path) = bundled_runtime::extracted_node_path(app) {
        if path.exists() {
            return Some(path);
        }
    }
    None
}
```

### C5. Startup extraction trigger

In `lib.rs` (Tauri setup), spawn extraction on a background thread during app startup:

```rust
app.setup(|app| {
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        match bundled_runtime::ensure_node_extracted(&handle) {
            Ok(path) => log::info!("Bundled Node.js ready at {}", path.display()),
            Err(e) => log::warn!("Bundled Node.js extraction failed: {e}"),
        }
    });
    Ok(())
});
```

Extraction is non-blocking. If an LSP session starts before extraction completes, it falls back to global Node.js. If neither is available, the prerequisite check fails with a clear error.

### C6. Update `detect_prerequisites` for bundled Node.js

When the `node` prerequisite is probed:
1. Check global PATH first (existing behavior)
2. If not found or wrong version: check extracted bundled node
3. If bundled node available: prerequisite passes, note source as "bundled"

This means the "Install Node.js from nodejs.org" message only appears when BOTH global and bundled are missing — which shouldn't happen in release builds.

### C7. npm resolution for scaffold runner

The New Project scaffold runner needs `npm` (for `npm install`, `npm create`, etc.). Bundled npm lives alongside the bundled node:

```
runtimes/node/
├── node.exe (or bin/node)
└── node_modules/
    └── npm/
        └── bin/
            └── npm-cli.js
```

Expose a `resolve_npm()` function that returns the path to the npm CLI script, using the same resolution chain as `resolve_node()`.

### Tests
- `ensure_node_extracted` creates correct directory structure
- `ensure_node_extracted` is idempotent (re-run doesn't re-extract at same version)
- `ensure_node_extracted` re-extracts when version changes
- `extracted_node_path` returns correct platform-specific path
- `resolve_node` prefers global over bundled
- `resolve_node` falls back to bundled when global missing
- Unix permissions set correctly after extraction (Unix-only test)
- `resolve_npm` returns valid path when bundled node is extracted

### Acceptance
- Release build on clean machine (no Node.js installed): Litria starts, extraction runs in background, opening `.py` file → Pyright starts using bundled Node → diagnostics appear
- Machine with Node.js 20 installed: Litria uses global Node.js, bundled is ignored
- Machine with Node.js 16 installed: Litria uses bundled Node.js (global version too old)
- `scripts/bundle-node.mjs` downloads correct platform binary, verifies hash
- Installer size ≤ 120 MB

---

## Slice D: Build Pipeline + CI Integration

**Goal**: Automate the full bundling flow so release builds are reproducible and CI produces correct installers for all platforms.

**Why last**: Slices A-C can be developed and tested locally (manually running scripts, manually placing files). This slice makes it automated and CI-ready.

### D1. Unified bundle script

Create `scripts/bundle-all.mjs` that orchestrates both:

```javascript
// Entry point for release build preparation.
// 1. Bundle Node.js for current target platform
// 2. Bundle core language servers (pyright + tsserver)
// 3. Verify all expected files exist
// 4. Print manifest for build log

import { bundleNode } from "./bundle-node.mjs";
import { bundleServers } from "./bundle-servers.mjs";

await bundleNode();
await bundleServers();
verifyManifest();
```

### D2. npm script integration

```json
// package.json
"scripts": {
    "bundle": "node scripts/bundle-all.mjs",
    "bundle:servers": "node scripts/bundle-servers.mjs",
    "bundle:node": "node scripts/bundle-node.mjs",
    "build:release": "npm run bundle && npm run build"
}
```

**Dev builds**: `npm run dev` — no bundling, uses global installs (fast).
**Release builds**: `npm run build:release` — full bundling (slower, complete).

### D3. CI matrix

```yaml
# .github/workflows/release.yml (pseudocode)
strategy:
  matrix:
    include:
      - os: windows-latest
        target: x86_64-pc-windows-msvc
      - os: macos-latest
        target: aarch64-apple-darwin
      - os: macos-latest
        target: x86_64-apple-darwin
      - os: ubuntu-latest
        target: x86_64-unknown-linux-gnu

steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: "24" }
  - run: npm ci
  - run: npm run bundle
    env:
      TAURI_TARGET_TRIPLE: ${{ matrix.target }}
  - run: npx tauri build --target ${{ matrix.target }}
  - name: Verify bundle contents
    run: node scripts/verify-bundle.mjs
```

### D4. Hash manifest

Create `scripts/node-hashes.json`:

```json
{
    "24.14.0": {
        "x86_64-pc-windows-msvc": {
            "url": "https://nodejs.org/dist/v24.14.0/node-v24.14.0-win-x64.zip",
            "sha256": "abc123..."
        },
        "aarch64-apple-darwin": { "...": "..." },
        "x86_64-apple-darwin": { "...": "..." },
        "x86_64-unknown-linux-gnu": { "...": "..." }
    }
}
```

Hashes are updated when `NODE_VERSION` in `versions.rs` is bumped. The bundle script reads this file and rejects downloads with mismatched hashes.

### D5. Bundle verification script

Create `scripts/verify-bundle.mjs`:
- Checks all expected files exist in `src-tauri/resources/`
- Verifies Node.js binary is the correct version (`node --version`)
- Verifies server entry points are present
- Prints total bundle size
- Exits non-zero if anything is missing (CI gate)

### D6. .gitignore finalization

```
# Bundled runtimes (downloaded during release build, not committed)
src-tauri/resources/servers/
src-tauri/resources/node/
```

### Tests
- `bundle-all.mjs` produces expected directory structure
- `verify-bundle.mjs` passes after successful bundling
- `verify-bundle.mjs` fails when files are missing
- Hash mismatch aborts download with clear error
- Cross-compilation target override via `TAURI_TARGET_TRIPLE` works

### Acceptance
- `npm run build:release` on any platform produces a working installer with bundled Node + servers
- CI builds for all 4 targets succeed
- `verify-bundle.mjs` gates CI — broken bundles don't ship
- Dev workflow unchanged (`npm run dev` still fast, no bundling)

---

## Slice E: Architecture Doc Reconciliation + Cleanup

**Goal**: Update all documentation to reflect the new bundled reality. Remove stale references to "user must install Node.js" and "npm install -g" as requirements.

### E1. Update `lsp-client-architecture.md` Section 15

Current Section 15 says:
> "Language servers are not bundled inside the Litria binary."
> "Node.js — external. User is responsible for installing it."

Replace with the new reality: bundled by default, global overrides bundled.

Update the Prerequisites Decision Tree:

```text
User opens a file in a supported language
    ↓
Litria runs prerequisite detection + 3-tier resolution
    ↓
Node.js found (global or bundled)?
    NO  → (should not happen in release builds) surface error
    YES ↓
Language server resolved (global → managed → bundled)?
    YES → start session, show resolution tier in status
    NO  → (should not happen in release builds) surface error
```

### E2. Update parent build plan

In `language-server-management-build-plan.md`:
- Mark decision D2 as superseded by this plan
- Update size budget table to include Node.js
- Note that Slice 1 and Slice 2 are implemented by this plan's Slices A-C

### E3. Update README / system requirements

- Remove "Node.js 18+" from system requirements (for release builds)
- Add note: "Litria bundles Node.js and core language servers. Power users can override with global installs."
- Keep "Python 3.8+" as a system requirement (needed by Pyright for analysis, not bundleable)

### E4. Update `versions.rs` header comment

Add bundling context to the version bump instructions:

```rust
// When bumping a version:
//   1. Update the constant here.
//   2. Update docs/plans/lsp/lsp-client-architecture.md Section 14.
//   3. If bumping NODE_VERSION: update scripts/node-hashes.json with new SHA256s.
//   4. Run scripts/verify-bundle.mjs to confirm bundle integrity.
//   5. Verify behaviour with a manual parity pass before shipping.
```

### Acceptance
- All documentation references to "install Node.js" are updated or removed
- No stale "npm install -g" instructions remain in user-facing docs
- Architecture doc accurately describes the 3-tier resolution model

---

## Delivery Sequence

```
Slice A: Resolution Layer         ~2-3 sessions
    Pure Rust refactor. No external deps. No user-visible change.
    ↓
Slice B: Bundle JS Servers        ~2 sessions
    Packaging script + Tauri resources + probe_bundled.
    Delivers: zero-config Python + TS (if user has Node.js).
    ↓
Slice C: Bundle Node.js           ~3-4 sessions
    Platform binaries + extraction + resolve_node.
    Delivers: fully zero-config (no Node.js install needed).
    ↓
Slice D: Build Pipeline + CI      ~2 sessions
    Automation, hashes, CI matrix, verification.
    Delivers: reproducible release builds on all platforms.
    ↓
Slice E: Doc Reconciliation       ~1 session
    Update architecture docs, README, version bump instructions.
```

**Total estimate**: ~10-12 sessions.

Slices A and B together deliver the most immediate user value (zero-config for anyone with Node.js). Slice C removes the last external dependency. Slice D makes it shippable. Slice E ties up the paper trail.

---

## Decisions

### BD1: Global-first precedence
Global installs always take priority over bundled. Power users who maintain their own toolchain are not overridden. This is inherited from ADR-004 and the parent build plan.

### BD2: Extraction to app-data (not in-place execution)
Bundled Node.js is extracted from the read-only resource directory to a writable app-data location on first run. This handles macOS code-signing, Linux AppImage, and Unix executable permissions uniformly.

### BD3: Dev builds skip bundling
`npm run dev` does not trigger bundling. Developers use global installs for fast iteration. Bundling only runs for `npm run build:release`. The resolver's fallback chain makes this seamless — no code changes needed between dev and release.

### BD4: Version marker for re-extraction
A `.node-version` file in the extracted directory tracks which version is present. On Litria update (new bundled Node version), extraction re-runs automatically. No manual cleanup needed.

### BD5: npm bundles with Node.js
npm is part of the Node.js distribution and is extracted alongside the node binary. This supports the scaffold runner (New Project modal) without a separate npm bundling step.

### BD6: Python runtime is NOT bundled
Python is a system requirement for Pyright's analysis target (it needs to resolve the user's Python environment, virtualenvs, conda, etc.). Bundling a Python interpreter would not help — Pyright needs to see the user's Python, not ours. This is explicitly out of scope.

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Extraction fails (disk full, permissions) | Graceful fallback to global. Clear error with app-data path for manual inspection. |
| macOS code-signing rejects extracted binary | Extracted to user-writable app-data, outside the signed bundle. Verified in macOS testing. |
| Node.js version drift across platforms | SHA256 hashes in `node-hashes.json` verified at download time. CI verifies all platforms. |
| Installer size exceeds 120 MB | Monitor per-slice. Node.js compresses well (~15 MB). JS servers compress to ~10 MB. Budget has margin. |
| Extraction race with LSP session start | Session start calls `resolve_node()` which checks extracted path. If not ready, falls back to global. If neither available, prerequisite fails gracefully — user sees "Setting up..." then retry. |
| Global Node.js has breaking change | Version gate (≥18) in `resolve_node`. Bundled provides a known-good fallback. |
| `npm install --prefix` behavior changes | Lock npm version via Node.js version pin. Both ship together. |
