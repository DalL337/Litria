# Language Support MVP + Manager PRD

## Status
- Proposed

## Date
- 2026-02-22

## Purpose
Lock the final MVP language support scope for Litria and define a provisional design for a post-MVP Language Support Manager that installs and manages language support packs (LSPs, frameworks, and add-ons).

## 1. MVP Final Language Support (Locked)

### 1.1 Supported Languages
- JavaScript
- TypeScript
- Python
- JSON (config artifacts, schemas, formatting/validation)

### 1.2 MVP Scaffold Targets
- JavaScript: `Node.js` baseline scaffold
- TypeScript: `Node.js + TypeScript` baseline scaffold
- Python: `Python Service` baseline scaffold
- JSON: `Config Bundle` baseline scaffold

### 1.3 MVP Add-on Policy
- Add-ons are disabled for MVP scaffolding.
- Framework variants outside the above list are out of scope for MVP.

### 1.4 Non-MVP (Deferred)
- Additional languages (Go, Rust, Java, C#, etc.)
- Additional framework templates per language
- Optional scaffold add-ons (db/cache/test/docker presets)

## 2. Product Direction After MVP

Use a hybrid model:
- Bundle core support for MVP languages out of the box.
- Add a plug-and-play Language Support Manager for non-MVP language packs and future framework/add-on packs.

This avoids shipping every language/LSP binary in the base install while still allowing one-click expansion.

## 3. Language Support Manager (Provisional Design)

## 3.1 User Story
User opens Language Support settings, selects a language support pack, optionally selects framework templates and add-ons, and installs the pack. Litria handles download, verification, install, updates, and runtime wiring.

## 3.2 Responsibilities
- Catalog and discover available language support packs.
- Install/uninstall/update packs.
- Resolve OS/architecture-specific artifacts.
- Verify package integrity (checksums, signatures where available).
- Track installed versions and filesystem paths.
- Expose install/update state and actionable errors to UI.

## 3.3 Pack Model
Each pack entry includes:
- `packId`
- `languageId`
- `displayName`
- `version`
- `lsp`:
  - `serverId`
  - `launch` (command, args, env contract)
  - `artifacts` (per `os/arch`)
- `frameworks[]` (optional templates enabled by this pack)
- `addons[]` (optional scaffold add-ons enabled by this pack)
- `dependencies[]` (pack-to-pack or runtime prerequisites)
- `checksums` and optional `signature`

## 3.4 Install Lifecycle
1. User selects pack + optional framework/add-on bundle.
2. Manager resolves dependency graph and platform artifact.
3. Download to temp location.
4. Verify checksum/signature.
5. Extract/install into managed directory.
6. Register metadata (installed version, paths, capabilities).
7. Activate support in editor/scaffold catalogs.
8. Emit completion event and refresh UI.

On failure:
- Roll back partial install.
- Keep previous active version if present.
- Return typed error with retry guidance.

## 3.5 Update Lifecycle
- Detect available updates from catalog.
- Support `update one` and `update all`.
- Download + verify before swapping active version.
- Use atomic switch to avoid broken runtime states.

## 3.6 Uninstall Lifecycle
- Remove pack metadata and binaries.
- Prevent uninstall of currently required core packs unless user confirms replacement.
- Clean stale artifacts with safe garbage collection.

## 3.7 Security and Integrity Requirements
- HTTPS-only package endpoints.
- Mandatory checksum validation for every artifact.
- Signature verification when available.
- No execution of unverified binaries.
- No elevation requirement for default install path (per-user writable directory).

## 3.8 OS/Architecture Handling
- Artifact matrix keyed by `windows|macos|linux` and `x64|arm64`.
- Deterministic selection based on runtime platform.
- Friendly error if platform artifact is unavailable.

## 3.9 UX Requirements
- Clear states: `Not Installed`, `Installing`, `Installed`, `Update Available`, `Error`.
- Progress and step details (download/verify/extract/register).
- Retry and copyable diagnostics for failures.
- Ability to view installed version and active executable path.

## 3.10 Language Pack Integration Contract (Required for All Installable Languages)

This contract defines the required runtime and UX behavior every installable language pack must follow.  
Python implementation is the first reference path and future language packs must conform to this same model.

### 3.10.1 Canonical State Model
- `Not Installed`
- `Installing`
- `Installed`
- `Update Available`
- `Error`

State names and transitions must be consistent across languages so users can learn one model.

### 3.10.2 Runtime Capability Contract
Every pack must declare:
- executable/runtime prerequisites
- OS/arch artifact support matrix
- launch command and args
- environment contract (allowlisted keys)
- minimum health/ready signal for activation

Manager must verify prerequisites before activation and return actionable errors when unmet.

### 3.10.3 Lifecycle Contract
For each language pack:
1. detect/install/update/uninstall operations use typed statuses
2. activation happens only after verification + registration succeed
3. rollback preserves previous known-good active version on failure
4. project switch/close must cleanly detach language runtime listeners/sessions

### 3.10.4 Error Contract
Each failure must return:
- `category` (shared app category set)
- `code` (language-pack-specific code)
- `message` (user-actionable, copyable)
- optional `retryHint`

No silent failure paths are allowed for install/activation/deactivation operations.

### 3.10.5 UX Consistency Contract
Each pack must provide:
- the same status vocabulary and status badge semantics
- clear next-step guidance when manual action is required
- copyable diagnostics and retry action where safe
- visible active version and runtime path details

### 3.10.6 Conformance Rule
Before enabling a new installable language in the manager:
- pass contract conformance checklist
- pass lifecycle + error-path tests
- provide manual parity evidence with the same install/activate/edit/diagnostic flow shape used by Python reference.

## 4. Domain/Ownership Proposal

## 4.1 `ScaffoldDomain`
- Owns scaffold catalog exposure (languages/frameworks/add-ons currently available to create-project flow).
- Consumes capabilities from Language Support Manager.

## 4.2 `ProjectDomain`
- Owns project creation/apply side effects only.
- Applies scaffold plans using already-available support capabilities.

## 4.3 Proposed `LanguageSupportDomain` (new)
- Owns pack catalog, install state machine, and selectors for availability.
- Delegates IO/network/process concerns to infrastructure adapters.

## 4.4 Infrastructure Adapter Boundary
- Download adapter
- Verification adapter
- Archive extraction adapter
- Filesystem adapter
- Process launch capability adapter

## 5. Suggested APIs (Initial)

Commands:
- `listCatalog()`
- `listInstalled()`
- `installPack({ packId, frameworkIds, addonIds })`
- `updatePack({ packId })`
- `uninstallPack({ packId })`
- `retryLastFailed({ operationId })`

Selectors:
- `getPackStatus(packId)`
- `getSupportedLanguages()`
- `getAvailableFrameworks(languageId)`
- `getAvailableAddons(languageId, frameworkId)`

Events:
- `onInstallProgress`
- `onInstallCompleted`
- `onInstallFailed`
- `onCatalogUpdated`

## 6. Delivery Phases

Phase 1:
- Keep MVP bundled support only (JS/TS/Python/JSON).
- No external downloads.

Phase 2:
- Introduce Language Support Manager with install/update/uninstall for one non-MVP language pilot.

Phase 3:
- Expand catalog and enable framework/add-on bundles per language pack.

## 7. Acceptance Criteria
- MVP language support remains fixed to JS/TS/Python/JSON.
- Non-MVP language support is installable through manager workflow.
- Install/update/uninstall operations are verifiable, rollback-safe, and visible in UI.
- Scaffold options are derived from installed/available support packs, not hardcoded sprawl.
- Python implementation establishes the reference integration contract for future installable language packs.
- Future language packs cannot ship unless they pass the shared language pack integration contract.
