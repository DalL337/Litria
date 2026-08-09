# LSP Client Architecture

## Status
Active Design — Pre-Implementation

## Date
2026-02-27

---

## 1. Foundational Philosophy

Litria is the client. The language server is the expert.

Litria does not implement language intelligence. It implements a transport layer that connects Monaco to servers that already do the hard work. Every language-specific behavior — diagnostics, completions, hover, definitions, semantic tokens — comes from the server. Litria's job is to speak the protocol correctly, route messages to the right place, and surface results in the editor.

This principle drives every decision in this document.

**The transport layer is language-agnostic.** It knows about processes, stdio, JSON-RPC framing, and request correlation. It does not know what Python or TypeScript is. Language-specific behavior lives in a pack — a small config and capability declaration that the generic transport layer consumes.

Adding a new language is adding a pack. It is not touching the transport.

---

## 2. What the LSP Client Is and Is Not

### What It Is

- A generic JSON-RPC over stdio transport layer implemented in Rust
- A request/response correlation engine (pending request map per session)
- A notification dispatch system (server → client push messages)
- A pack registry that maps language IDs to server launch configs and capability declarations
- A Tauri event bridge that surfaces server messages to the frontend
- A set of Monaco provider replacements that call through to the server instead of using local heuristics

### What It Is Not

- A language intelligence implementation
- A language server (Litria is the client)
- A replacement for the language servers themselves (pyright, typescript-language-server, etc.)
- An incremental sync engine in MVP (full text sync is sufficient to start)

---

## 3. Architecture Layers

```
Monaco Editor (React)
    │  registers providers (hover, completion, definition, etc.)
    │  providers invoke Tauri commands and await responses
    ▼
LSP Provider Layer  (src/lsp/monacoProviders.js)
    │  language-agnostic provider factory
    │  maps LSP response shapes to Monaco API shapes
    ▼
LSP Client (src/lsp/lspClient.js)
    │  thin Tauri invoke wrappers
    │  event subscriptions for push notifications (publishDiagnostics, etc.)
    ▼
Tauri IPC Bridge
    ▼
Rust LSP Transport  (src-tauri/src/lsp/)
    │  spawns language server process
    │  reads stdout: Content-Length framing → JSON-RPC dispatch
    │  writes stdin: JSON-RPC requests and notifications
    │  pending request map for request/response correlation
    │  notification dispatch → Tauri emit to frontend
    ▼
Language Server Process  (pyright-langserver, typescript-language-server, etc.)
```

---

## 4. The Transport Layer (Rust)

The transport layer lives in `src-tauri/src/lsp/`. It is the only place in the codebase that speaks LSP wire protocol.

### What the Transport Does

- Spawns the server process with stdin and stdout both piped
- Runs an async read loop (via `tauri::async_runtime::spawn`) that owns stdout
- Frames outgoing messages with `Content-Length` headers per the LSP spec
- Reads incoming messages by first reading the `Content-Length` header, then reading exactly that many bytes
- Deserializes each incoming message and routes it:
  - If it has an `id` field and is a response: resolves the matching pending request
  - If it has no `id` or is a notification: dispatches to the registered notification handler
- Manages a `pending_requests` map: `HashMap<u64, oneshot::Sender<Value>>`
- Emits Tauri events for server-pushed notifications so the frontend can react

### What the Transport Does Not Do

- Does not interpret message content (that is the pack or provider layer's concern)
- Does not implement any language-specific logic
- Does not retry failed requests (caller responsibility)
- Does not implement incremental document sync (full text in MVP)

### Wire Protocol

LSP uses JSON-RPC 2.0 over a raw byte stream with Content-Length framing:

```
Content-Length: <byte-count>\r\n
\r\n
<JSON payload of exactly byte-count bytes>
```

The reader must:
1. Read bytes until `\r\n\r\n` is found (end of headers)
2. Parse the `Content-Length` value from the header block
3. Read exactly that many bytes as the message body
4. Deserialize as JSON-RPC

An off-by-one or missing `\r\n` desynchronizes the stream permanently. The framer must be unit tested before being wired to a live process.

### JSON-RPC Envelope Types

```rust
// Outgoing request
struct LspRequest {
    jsonrpc: &'static str,  // always "2.0"
    id: u64,
    method: String,
    params: Value,
}

// Outgoing notification (no id, no response expected)
struct LspNotification {
    jsonrpc: &'static str,
    method: String,
    params: Value,
}

// Incoming: can be response or notification
// Discriminate by presence of `id` field
```

### Session Lifecycle

```
spawn process
    → send initialize request (with client capabilities from pack)
    → await initialize response
    → send initialized notification
    → session is ready: begin accepting provider requests and document sync

(while active)
    → textDocument/didOpen on file open
    → textDocument/didChange on every content change (full text)
    → textDocument/didClose on file close
    → respond to hover/completion/definition/signatureHelp requests
    → receive and dispatch publishDiagnostics notifications

shutdown
    → send shutdown request
    → await shutdown response
    → send exit notification
    → kill process if it does not exit within 3 seconds
```

### Async Runtime

**Do not add tokio to Cargo.toml.** Tauri v2 already includes tokio internally and re-exports it:

```rust
tauri::async_runtime::spawn(async move { /* message read loop */ });
```

Use `tokio::sync::oneshot` for request/response correlation:
```rust
let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
pending_requests.lock().unwrap().insert(request_id, tx);
// ... send request ...
let response = rx.await?;
```

---

## 5. The Language Pack

A language pack is a configuration struct. It contains everything the transport layer needs to spawn and speak to a specific language server. It contains no transport logic.

### Pack Contract (Rust)

```rust
struct LanguagePack {
    // Identity
    language_id: &'static str,          // "python", "typescript", "javascript"

    // Prerequisites check
    prerequisites: Vec<Prerequisite>,    // what to probe before spawning

    // Launch
    command: &'static str,              // "pyright-langserver"
    args: Vec<&'static str>,            // ["--stdio"]
    cwd_policy: CwdPolicy,              // ProjectRoot | Fixed(path)
    env_allowlist: Vec<&'static str>,   // keys to pass through from environment

    // LSP handshake
    client_capabilities: Value,         // JSON sent in initialize request
    initialization_options: Value,      // server-specific options in initialize

    // Quirks
    startup_timeout_ms: u64,           // default 10_000
    document_sync_kind: SyncKind,      // Full (MVP), Incremental (later)

    // Error namespace
    error_prefix: &'static str,        // "python_lsp", "typescript_lsp"
}
```

### Python Pack (Reference Implementation)

```rust
LanguagePack {
    language_id: "python",
    prerequisites: vec![
        Prerequisite::Command("python", "--version"),
        Prerequisite::Command("node", "--version"),
        Prerequisite::Command("pyright-langserver", "--version"),
    ],
    command: "pyright-langserver",
    args: vec!["--stdio"],
    cwd_policy: CwdPolicy::ProjectRoot,
    client_capabilities: pyright_client_capabilities(),   // see note below
    initialization_options: json!({}),
    startup_timeout_ms: 10_000,
    document_sync_kind: SyncKind::Full,
    error_prefix: "python_lsp",
}
```

**Note on pyright client capabilities**: pyright validates the `initialize` request and silently misbehaves if the capabilities object is malformed. The capabilities struct must include at minimum:
- `textDocument.publishDiagnostics`
- `textDocument.hover` with contentFormat
- `textDocument.completion` with completionItem capabilities
- `workspace.configuration`

Derive from the [LSP spec capabilities object](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) and trim aggressively. Do not send capabilities the pack does not implement.

### TypeScript/JavaScript Pack

```rust
LanguagePack {
    language_id: "typescript",          // also handles "javascript"
    prerequisites: vec![
        Prerequisite::Command("node", "--version"),
        Prerequisite::Command("typescript-language-server", "--version"),
        Prerequisite::Command("tsc", "--version"),   // typescript package itself
    ],
    command: "typescript-language-server",
    args: vec!["--stdio"],
    cwd_policy: CwdPolicy::ProjectRoot,
    client_capabilities: tsserver_client_capabilities(),
    initialization_options: json!({
        "preferences": {
            "includeInlayParameterNameHints": "all",
            "includeInlayFunctionLikeReturnTypeHints": true,
        }
    }),
    startup_timeout_ms: 15_000,         // tsserver initializes slower than pyright
    document_sync_kind: SyncKind::Full,
    error_prefix: "typescript_lsp",
}
```

---

## 6. Notification Handling

Server-pushed notifications (no request ID, no response expected) are dispatched by method name. The transport layer calls registered notification handlers after deserializing.

### Core Notifications to Handle

| Method | Direction | Action |
|---|---|---|
| `textDocument/publishDiagnostics` | server → client | emit `lsp:diagnostics` Tauri event with uri + diagnostics |
| `window/logMessage` | server → client | log to console, surface to debug panel eventually |
| `window/showMessage` | server → client | surface as in-editor notification |
| `$/progress` | server → client | no-op in MVP, wire up later for index progress |

### Diagnostic Push Flow

```
Server emits textDocument/publishDiagnostics
    → transport dispatch recognizes notification (no id field)
    → calls notification handler for "textDocument/publishDiagnostics"
    → handler calls tauri::AppHandle::emit("lsp:diagnostics", payload)
    → frontend lspClient.js receives event
    → languageSupportDomain updates diagnostic state
    → EditorMonaco.jsx calls setModelMarkers with new diagnostics
```

This replaces the current debounced `pythonLspValidateDocument` poll entirely.

---

## 7. Provider Request Flow

Hover, completion, definition, and signature help are request/response. The Monaco provider sends a request and awaits the server's reply.

### General Flow

```
User triggers hover (mouse position held)
    → Monaco calls provideHover(model, position)
    → provider invokes Tauri: lsp_request({ method: "textDocument/hover", params })
    → Rust: assign request ID, insert oneshot sender into pending_requests
    → Rust: serialize and write request to server stdin
    → Rust read loop receives response with matching ID
    → Rust: remove sender from pending_requests, send response through oneshot
    → Tauri command resolves and returns JSON to frontend
    → provider maps LSP Hover → Monaco Hover and returns
```

### Providers to Implement

| LSP Method | Monaco Registration | Replaces |
|---|---|---|
| `textDocument/hover` | `registerHoverProvider` | local symbol lookup in pythonLocalIntelligence.js |
| `textDocument/completion` | `registerCompletionItemProvider` | local keyword + symbol completion |
| `textDocument/definition` | `registerDefinitionProvider` | local single-file definition lookup |
| `textDocument/signatureHelp` | `registerSignatureHelpProvider` | local parameter parsing |
| `textDocument/documentSymbol` | `registerDocumentSymbolProvider` | local parsePythonSymbols |

`pythonLocalIntelligence.js` providers remain registered as a fallback path and are called when no LSP session is active for the file's language.

---

## 8. Document Synchronization

The server must be kept in sync with the editor content. This is a requirement for all provider requests to return accurate results.

### Document Sync Events

| Editor event | LSP notification | Timing |
|---|---|---|
| File opened in editor | `textDocument/didOpen` | Immediately on tab activation |
| Content changed | `textDocument/didChange` (full text) | On every change, debounced 150ms |
| File closed (tab closed) | `textDocument/didClose` | Immediately on tab close |
| File saved | `textDocument/didSave` | On save (optional in MVP) |

**Full text sync**: Send the entire file content on every change. This is simpler and sufficient for MVP. Incremental sync (sending only the diff) is a follow-on optimization.

**Version tracking**: Each `didChange` must increment a version counter per document URI. The version in `didOpen` starts at 1. The server uses this to detect out-of-order updates.

---

## 9. File Structure

### Rust (src-tauri/src/)

```
src-tauri/src/
├── lsp/
│   ├── mod.rs              # module root, re-exports public interface
│   ├── transport.rs        # generic: process spawn, stdio read loop, framing, dispatch
│   ├── session.rs          # session state, pending request map, lifecycle management
│   ├── types.rs            # JSON-RPC envelopes, common LSP types (Position, Range, etc.)
│   └── packs/
│       ├── mod.rs          # pack registry, pack lookup by language_id
│       ├── python.rs       # Python pack config + client capabilities
│       └── typescript.rs   # TypeScript/JS pack config + client capabilities
├── commands.rs             # Tauri commands (now language-agnostic, delegate to lsp/)
└── python_lsp_*/           # RETIRED: migrated to lsp/ modules
```

**Migration**: `python_lsp_session_manager.rs`, `python_lsp_types.rs`, and `python_lsp_ipc_bridge.rs` are retired and replaced by `lsp/`. The `validate_document` CLI path is removed entirely — diagnostics come from the server push path.

### Frontend (src/)

```
src/
├── lsp/
│   ├── lspClient.js        # Tauri invoke wrappers (language-agnostic)
│   ├── monacoProviders.js  # provider factory: takes session context, registers providers
│   └── packs/
│       ├── python.js       # Python pack: prerequisites UI, launch config, error codes
│       └── typescript.js   # TypeScript/JS pack
├── app/
│   ├── languageSupportDomain.js   # refactored: generic over packs, not Python-specific
│   └── useLspLifecycle.js         # replaces usePythonLspLifecycle.js
└── editor/
    └── pythonLocalIntelligence.js # KEPT as fallback when no LSP session active
```

---

## 10. Tauri Command Interface

The language-agnostic Tauri commands replace the Python-specific commands. All commands take a `languageId` parameter so the same command handles any pack.

| Command | Parameters | Returns |
|---|---|---|
| `lsp_detect_prerequisites` | `{ languageId }` | `{ prerequisites: [...probe results] }` |
| `lsp_start_session` | `{ languageId, projectId, projectRoot }` | `{ sessionId, ready }` |
| `lsp_stop_session` | `{ languageId, projectId, sessionId }` | `{ sessionId }` |
| `lsp_teardown_all` | — | `{ count }` |
| `lsp_request` | `{ sessionId, method, params }` | `{ result }` |
| `lsp_notify` | `{ sessionId, method, params }` | — |

`lsp_request` is the generic round-trip. All provider calls (hover, completion, definition, etc.) go through it. The frontend does not need a separate command per LSP method.

`lsp_notify` is fire-and-forget. Document sync events (didOpen, didChange, didClose) go through it.

### Tauri Events (server → frontend)

| Event | Payload |
|---|---|
| `lsp:diagnostics` | `{ sessionId, uri, diagnostics: [...] }` |
| `lsp:session-started` | `{ sessionId, languageId, projectId }` |
| `lsp:session-ended` | `{ sessionId, languageId, projectId }` |
| `lsp:error` | `{ sessionId, languageId, category, code, message }` |
| `lsp:log` | `{ sessionId, type, message }` |

---

## 11. JS/TS-Specific Considerations

When the TypeScript/JavaScript pack activates, Monaco's built-in TypeScript worker must be disabled for the project's files to prevent conflicting diagnostics.

```javascript
// Called when typescript-language-server session becomes active
function disableMonacoBuiltinTs() {
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  })
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  })
}

// Called when session ends / falls back
function restoreMonacoBuiltinTs() {
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  })
  // same for javascriptDefaults
}
```

This is the only place where JS/TS differs meaningfully from Python at the provider registration layer. The transport layer is identical.

---

## 12. Error Handling

### Server Crash During Session

If the read loop task detects the server process has exited unexpectedly:
1. Drain any pending requests with an error response
2. Emit `lsp:error` event with `category: "crash"`
3. Update session state to `Error`
4. Do not auto-restart in MVP — surface the error and let the user trigger re-activation

### Initialize Timeout

If the server does not respond to `initialize` within `startup_timeout_ms`:
1. Kill the process
2. Return error from `lsp_start_session` command
3. Error code: `{prefix}.start.timeout`

### Request Timeout

Provider requests (hover, completion, etc.) should have a timeout of ~5 seconds. If the server does not respond:
1. Remove from pending map
2. Return null result to the provider (Monaco treats null as "no result")
3. Do not surface an error to the user for individual provider timeouts

### Prerequisite Failure

If prerequisites are missing, the pack is not activated. Surface the missing prerequisite with install instructions. The error message must include the exact command the user needs to run.

---

## 13. Implementation Sequence

### Phase 1: Python (Reference Implementation)

Goal: Replace the current CLI-based validation with a real LSP client for Python. All diagnostics come from pyright-langserver push notifications. Basic providers (hover, completion, definition, signatureHelp) are server-backed.

Slice 1A — Transport foundation:
- Implement Content-Length framer (with unit tests)
- Implement `lsp/transport.rs`: process spawn, piped stdio, async read loop
- Implement `lsp/session.rs`: pending request map, request/response correlation
- Implement `initialize`/`initialized` handshake
- Implement `lsp_start_session` and `lsp_stop_session` commands

Slice 1B — Document sync + diagnostics push:
- Implement `textDocument/didOpen`, `didChange`, `didClose` via `lsp_notify`
- Implement `publishDiagnostics` notification handler → `lsp:diagnostics` Tauri event
- Frontend: subscribe to `lsp:diagnostics`, update markers
- Remove `validate_document` CLI path

Slice 1C — Provider requests:
- Implement `lsp_request` generic command
- Frontend: replace hover, completion, definition, signatureHelp providers in `pythonLocalIntelligence.js` with server-backed versions
- Keep local providers as no-session fallback

Slice 1D — Hardening:
- Request timeout handling
- Server crash detection and error surfacing
- Session state consistency on project switch
- Manual parity pass

### Phase 2: TypeScript/JavaScript

Goal: Reuse Phase 1 transport entirely. Add the TypeScript pack, disable Monaco built-in TS worker, wire up providers.

- Add `lsp/packs/typescript.rs` with tsserver capabilities
- Add `src/lsp/packs/typescript.js`
- Implement `disableMonacoBuiltinTs` / `restoreMonacoBuiltinTs` on session lifecycle
- Wire prerequisites detection for `typescript-language-server` + `tsc`
- Same provider wiring as Python — transport handles it

### Phase 3+: Additional Languages

Each additional language is a new pack file (Rust + JS). No transport changes.

| Language | Server | Est. pack effort |
|---|---|---|
| Rust | `rust-analyzer` | ~1 day |
| Go | `gopls` | ~1 day |
| C/C++ | `clangd` | ~1 day |
| CSS/HTML | `vscode-css-languageserver` | ~1 day |

---

## 14. Dependency Stability and Version Management

Every layer of the stack that Litria depends on can ship a breaking change. The strategy is explicit pinning at every layer. Nothing moves unless Litria decides it moves.

### Layer 1: Rust Toolchain

A `rust-toolchain.toml` file in the repo root pins the exact compiler version used for all builds — local dev, CI, and release:

```toml
[toolchain]
channel = "1.85.0"
```

Every developer and every build environment uses this version regardless of what rustup has installed. The version is updated deliberately, tested, and committed — not pulled automatically when Rust ships a new stable.

### Layer 2: Rust Dependencies

`Cargo.lock` must be committed. This pins every transitive Rust dependency to an exact version. Builds are reproducible. Dependencies are updated explicitly via `cargo update -p <crate>` when a change is intentional — not silently by a fresh `cargo build` on a new machine.

### Layer 3: JS/npm Dependencies

`package-lock.json` must be committed. `npm ci` is used in CI and release builds — not `npm install`. Same principle as `Cargo.lock`: nothing updates unless the update is deliberate.

### Layer 4: Language Server Versions

This is the layer unique to the LSP client. When Litria installs a language server it must pin to a known-good version — not `latest`. The version is a constant in the pack config.

**Python pack:**

```rust
const PYRIGHT_VERSION: &str = "1.1.411";
// install command: npm install -g pyright@1.1.411
```

**TypeScript pack:**

```rust
const TSSERVER_VERSION: &str = "5.3.0";
const TYPESCRIPT_VERSION: &str = "5.9.3";
// install command: npm install -g typescript-language-server@5.3.0 typescript@5.9.3
```

When a new language server version is released, it is tested against Litria's transport implementation. If it passes, the constant is bumped in a Litria release. Users who already have the server installed are not affected until they explicitly update or reinstall.

### Dev / Stable Channel Model

| Channel | Rust toolchain | Language server versions | Audience |
|---|---|---|---|
| Stable | pinned, release-tested | pinned constants in pack config | all users |
| Dev | latest stable or beta | latest, opt-in | contributors, testers |

Dev channel builds loosen the pins deliberately. Problems surface in dev before they reach stable users. Most users never interact with dev channel.

### Prerequisite Resolution Order

When a user is missing a language server, Litria installs the pinned version — not whatever npm would resolve to as latest. This means:

1. User opens a `.py` file
2. Litria detects `pyright-langserver` missing, Node present
3. Litria runs: `npm install -g pyright@1.1.411` — exact version, not `pyright`
4. The version Litria installs is the version Litria has been tested against

If a user already has a different version installed globally, Litria detects the version on PATH and warns if it falls outside a tested range. It does not forcibly replace the user's global install.

### Version Pin File

The authoritative list of pinned language server versions lives in a single location — `src-tauri/src/lsp/packs/versions.rs` — so there is one place to update and one place to audit:

```rust
pub const PYRIGHT_VERSION: &str           = "1.1.411";
pub const TSSERVER_VERSION: &str          = "5.3.0";
pub const TYPESCRIPT_VERSION: &str        = "5.9.3";
```

Each Litria release commit includes the version pins that were tested for that release. The git history is the audit trail.

---

## 15. Prerequisites and Installation Strategy

### Distribution Model

Litria bundles Node.js LTS, Pyright, and TypeScript Language Server inside the installer. No external dependencies are required for Python and JS/TS language intelligence. Users do not need to install Node.js, run `npm install`, or configure PATH.

**Bundled components** (shipped in Tauri `resources/`):
- **Node.js 24.14.0 LTS** — platform-specific binary, extracted to app-data on first launch
- **Pyright** — Python language server (pure JS, runs on bundled Node)
- **TypeScript Language Server + TypeScript compiler** — JS/TS language server (pure JS, runs on bundled Node)

**Not bundled** (user's responsibility):
- **Python 3.8+** — required by Pyright to analyze the user's Python projects. Pyright needs to see the user's Python environment (virtualenvs, conda, etc.), not a bundled one.

Version pins are tracked in `src-tauri/src/lsp/packs/versions.rs`. See ADR-004 for the bundling rationale and `bundled-runtime-build-plan.md` for implementation details.

### 3-Tier Resolution Chain

When Litria needs a language server, the resolver (`lsp/resolver.rs`) checks three locations in order:

```text
User opens a file in a supported language
    ↓
Litria runs 3-tier resolution (Rust, via resolver.rs)
    ↓
1. Global PATH — server installed by user?
    YES → use global (power user override)
    NO  ↓
2. Managed directory (~/.litria/servers/) — installed via Litria UI?
    YES → use managed
    NO  ↓
3. Bundled resources — shipped with Litria installer?
    YES → use bundled
    NO  → surface error (should not happen in release builds)
```

Global installs always take precedence. A developer who maintains their own pyright or tsserver version is never overridden.

### Node.js Resolution

Node.js follows the same tier logic via `resolve_node()`:

1. **Global PATH** — if `node --version` reports ≥ 18, use it
2. **Extracted bundled node** — at `{app_data_dir}/runtimes/node/node.exe` (or `bin/node` on Unix)

On first launch, `bundled_runtime::ensure_node_extracted()` copies the bundled Node.js from the read-only resource directory to a writable app-data location (needed for macOS code-signing and Unix executable permissions). Extraction is idempotent — a `.node-version` marker tracks the extracted version.

### Prerequisite Detection

Each language pack declares prerequisites with a `satisfied_by_bundle` flag:

| Prerequisite | `satisfied_by_bundle` | Notes |
|---|---|---|
| Python ≥ 3.8 | `false` | User's project dependency |
| Node.js ≥ 18 | `true` | Shipped in `resources/node/` |
| pyright | `true` | Shipped in `resources/servers/python/` |
| typescript-language-server | `true` | Shipped in `resources/servers/typescript/` |
| tsc (TypeScript compiler) | `true` | Shipped in `resources/servers/typescript/` |

When the resolver finds the server at a bundled or managed tier, prerequisites marked `satisfied_by_bundle` pass automatically without a PATH probe.

The `lsp_detect_prerequisites` command returns a `resolution_tier` field ("global", "managed", "bundled", or null) so the frontend can display the server source in the status area.

### Build Pipeline

- **Dev builds** (`npm run tauri dev`): No bundling. Uses global PATH installs. Fast iteration.
- **Release builds**: `npm run bundle` stages Node.js + servers into `src-tauri/resources/`, then `npx tauri build` packages them into the installer.
- Version pins in `versions.rs` are the single source of truth — the bundle scripts read them directly.

### Installer Size

| Component | Raw | In Installer (compressed) |
|---|---|---|
| Node.js 24.14.0 | ~103 MB | ~15 MB |
| Pyright + TS Server | ~59 MB | ~10 MB |
| Litria binary + frontend | ~22 MB | ~10 MB |
| **Total** | **~162 MB raw** | **~35 MB NSIS** |

Well under competitive benchmarks (VS Code ~150 MB, JetBrains ~500 MB).

---

## 16. Relationship to Existing Plans

| Document | Relationship |
|---|---|
| `docs/plans/python-lsp-conformance-checklist.md` | Phase 1 must satisfy the existing contract gates. Lifecycle, error, and UX contracts are unchanged. Only the transport internals change. |
| `docs/plans/language-support-manager-prd.md` | The pack model in this document is the reference implementation for the installable pack concept described in the PRD. |
| `docs/plans/node-system-design.md` | LanguageSupportManager gates node system capability. That contract is unchanged — pack status vocabulary remains the same. |
| `docs/rust-module-ownership.md` | `lsp/` is a new top-level module. Ownership rules apply. Commands in `commands.rs` delegate to `lsp/` — they do not implement logic. |

---

## 17. Open Questions

- **Semantic tokens**: Server-pushed after `textDocument/semanticTokens/full` request. More complex than other providers. Defer to after Phase 1 core is stable.
- **Workspace folders**: Should `initialize` declare the project root as a workspace folder? Pyright benefits from this for multi-file type resolution. Likely yes — add to Python pack capabilities.
- **tsconfig.json detection**: Should the TypeScript pack scan for `tsconfig.json` before activating, or activate and let tsserver discover it? Activating unconditionally is simpler for MVP.
- **Multiple open projects**: Session map is keyed by `projectId`. If Litria ever supports multiple projects open simultaneously, each project gets its own session. No structural change needed.
- **Inlay hints**: TypeScript inlay hints (parameter names, return types) are a `textDocument/inlayHint` request. High value for TS users. Not in MVP scope but the transport handles it without changes.
- **Session-per-file vs session-per-project**: Current design is one session per project (all files in a project share one server connection). This is the correct model for pyright and tsserver — they both expect project-level context. Do not change this.
