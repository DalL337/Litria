# Language Server Registry — Schema Draft

## Status
- Normative per ADR-005 (Accepted 2026-07-07), with one revision from the original draft: a required per-server `version` string (needed by version-stamped install dirs, update detection, and the UI)
- Proposed (original 2026-03-25)

## Design Principles
- A developer should understand the schema in 30 seconds
- Only fields the install pipeline actually reads — no metadata bloat
- Easy for contributors to add a new language (copy a block, fill in URLs)
- Flat structure, no nesting beyond what's necessary

---

## Schema

```json
{
  "version": 1,
  "servers": {
    "<language_id>": {
      "name": "Display name for UI",
      "extensions": [".go", ".mod"],
      "server": "<server_id>",
      "version": "<upstream version string>",
      "command": "<binary_name>",
      "args": ["--stdio"],
      "artifacts": {
        "windows-x64":  { "url": "https://...", "sha256": "abc123" },
        "darwin-x64":   { "url": "https://...", "sha256": "def456" },
        "darwin-arm64":  { "url": "https://...", "sha256": "ghi789" },
        "linux-x64":    { "url": "https://...", "sha256": "jkl012" },
        "linux-arm64":  { "url": "https://...", "sha256": "mno345" }
      }
    }
  }
}
```

### Field Reference

| Field | Required | Purpose |
|-------|----------|---------|
| `version` | yes | Schema version. Bump when breaking changes are made. |
| `servers` | yes | Map of language_id → server definition. |
| `name` | yes | Human-readable name shown in install modal and settings. |
| `extensions` | yes | File extensions that trigger "install server?" modal. |
| `server` | yes | Server identifier (e.g., "gopls", "rust-analyzer"). Used in managed dir path and metadata. |
| `version` | yes | Upstream version string (formats vary: semver, dates, `v`-prefixed — hence string). Names the version-stamped install dir and drives update detection (receipt vs registry diff). Updated together with URL + hash. |
| `command` | yes | Binary name to execute after install. For extracted archives, this is the filename inside the archive. |
| `args` | yes | Command-line args passed at launch. Per-server data, not a convention (e.g., `["--stdio"]` for most, `["serve"]` for gopls) — pin whatever launch args we conformance-test. |
| `artifacts` | yes | Per-platform download entries. Only platforms with entries are supported. |
| `artifacts.*.url` | yes | Direct download URL from official distributor. HTTPS only. |
| `artifacts.*.sha256` | yes | SHA256 hash of the downloaded file. Verified before extraction. |

### What's intentionally NOT in the schema
- **Size field**: Nice for UI but not needed for the pipeline. Can be added later if users want to see download size before installing.
- **Stability/performance scores**: Subjective. Litria is opinionated — we pick one good server per language.
- **Multiple server options per language**: Deferred. Beta ships one server per language. The schema supports adding alternatives later by changing `server` to `servers[]`, but YAGNI for now.
- **Dependencies/prerequisites**: Handled in the Rust pack definition, not the registry. The registry is just "where to get it."

---

## Initial Entries (Beta)

Three languages beyond the bundled Python + TypeScript. All have single-binary releases on GitHub with no runtime dependencies.

### Go — gopls

Official Go language server maintained by the Go team.

- **Distributor**: `github.com/golang/tools` releases (or `go.dev/dl/`)
- **Binary**: Single native binary, no runtime needed
- **Size**: ~30 MB per platform
- **Extensions**: `.go`, `.mod`, `.sum`
- **Prerequisite**: Go runtime (for the user's project, not for gopls itself)

### Rust — rust-analyzer

Official Rust language server, maintained by the rust-analyzer team (now part of rust-lang).

- **Distributor**: `github.com/rust-lang/rust-analyzer` releases
- **Binary**: Single native binary, no runtime needed
- **Size**: ~25-40 MB per platform
- **Extensions**: `.rs`, `.toml` (Cargo.toml only — need to filter)
- **Prerequisite**: Rust toolchain (for the user's project)

### C/C++ — clangd

LLVM's language server for C, C++, and Objective-C.

- **Distributor**: `github.com/clangd/clangd` releases
- **Binary**: Single native binary, no runtime needed
- **Size**: ~30-50 MB per platform (larger due to LLVM components)
- **Extensions**: `.c`, `.h`, `.cpp`, `.hpp`, `.cc`, `.cxx`
- **Prerequisite**: None for clangd itself. User needs a compiler for their project.

---

## How to add a new language

1. Find the server's official GitHub releases page
2. Copy a server block from an existing entry
3. Fill in: name, extensions, server ID, command, args
4. For each platform you want to support:
   - Get the direct download URL for the latest stable release
   - Download the file and compute `sha256sum <file>`
   - Add the URL + hash to `artifacts`
5. Create a matching Rust pack in `src-tauri/src/lsp/packs/` (defines prerequisites, capabilities, env allowlist)
6. Test: open a file with the matching extension → install modal appears → install → diagnostics flow

---

## Example: Complete Go Entry

```json
{
  "version": 1,
  "servers": {
    "go": {
      "name": "Go",
      "extensions": [".go", ".mod"],
      "server": "gopls",
      "version": "v0.17.1",
      "command": "gopls",
      "args": ["serve"],
      "artifacts": {
        "windows-x64": {
          "url": "https://github.com/golang/tools/releases/download/gopls/v0.17.1/gopls-v0.17.1-windows-amd64.zip",
          "sha256": "<compute-at-build-time>"
        },
        "darwin-arm64": {
          "url": "https://github.com/golang/tools/releases/download/gopls/v0.17.1/gopls-v0.17.1-darwin-arm64.tar.gz",
          "sha256": "<compute-at-build-time>"
        },
        "linux-x64": {
          "url": "https://github.com/golang/tools/releases/download/gopls/v0.17.1/gopls-v0.17.1-linux-amd64.tar.gz",
          "sha256": "<compute-at-build-time>"
        }
      }
    }
  }
}
```

---

## Future Extensions (not for beta)

These can be added to the schema later without breaking existing entries:

- `size` per artifact (show download size in UI before user commits)
- `alternatives[]` per language (multiple server options)
- `homepage` URL (link to server docs from settings panel)
- `notes` string (e.g., "Requires Go 1.21+")
- `detect` block (guest-list discovery probes for the reconciler direction — see ADR-005 Scope Notes)
- `scaffold` block (wizard card + deps matrix, fed by template packs — see ADR-005 Scope Notes)
