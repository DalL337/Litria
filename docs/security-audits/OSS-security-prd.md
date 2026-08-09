# PRD: Build Fingerprinting & Integrity Identifier System

**Product:** Litria  
**Component:** Core Infrastructure  
**Version:** 1.0  
**Status:** Parked — premise depended on the Open Producer License, which has been dropped  
**Stack:** Rust · Tauri v2 · React 19 · Vite  

---

> **⚠ Parked (2026-07-01).** This PRD was designed as the technical enforcement arm of the OPL's "Integrity Identifier" clause. Litria is now **MIT-licensed**, which grants unrestricted use, modification, and redistribution — so the *legal* half of the deterrent no longer exists, and tamper-as-license-violation framing does not apply. The premise is kept here for a possible future revisit. If revived under MIT, it must be re-scoped as a **provenance / diagnostics** aid (identify which build a user is running) with **no enforcement / degraded-mode coercion**. Do not implement as written.

---

## 1. Objective

Embed a build fingerprint into every compiled Litria binary that identifies the exact build (git hash, version, build date). The fingerprint should survive normal distribution and be verifiable at runtime for diagnostics and provenance.

*(Original OPL-era objective — now void: the fingerprint was framed as a legally meaningful Integrity Identifier whose removal degraded the app in a non-obvious way. Under MIT there is no such legal protection.)*

---

## 2. Background

A build fingerprint lets a user or maintainer answer "which build is this?" for bug reports, crash triage, and support — a genuinely useful provenance aid under any license.

*(Original OPL-era rationale — now void: the fingerprint was positioned as the technical counterpart to the OPL's legally protected Integrity Identifiers, forming a two-layer deterrent against unauthorized derivation and AI clean-room circumvention. MIT deliberately permits derivation and redistribution, so this deterrent premise no longer holds.)*

---

## 3. Scope

**In scope:**
- Compile-time fingerprint generation via `build.rs`
- Fingerprint embedding in the Rust binary as a structural constant
- Runtime integrity verification on application startup
- Tauri command to expose fingerprint to the frontend (read-only)
- Frontend display of build fingerprint in Settings → About
- Verification failure behavior (degraded mode, not silent)

**Out of scope:**
- Network-based license validation
- User-facing DRM or activation flows
- Fingerprinting of Extensions or User Creations
- Obfuscation or binary hardening (future consideration)

---

## 4. Requirements

### 4.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F-01 | Fingerprint is generated at compile time, not runtime | Must Have |
| F-02 | Fingerprint incorporates git commit hash, Litria version, and a build secret seed | Must Have |
| F-03 | Fingerprint is embedded as a `&'static str` constant in the Rust binary | Must Have |
| F-04 | Fingerprint format is human-readable and prefixed with `CM-` | Must Have |
| F-05 | Integrity check runs on every application startup before the main window renders | Must Have |
| F-06 | Integrity check failure puts the application into degraded mode | Must Have |
| F-07 | Degraded mode displays a non-dismissable notice and disables save, export, and build features | Must Have |
| F-08 | Fingerprint is accessible via a Tauri command (`get_build_fingerprint`) | Must Have |
| F-09 | Settings → About panel displays the fingerprint | Must Have |
| F-10 | Fingerprint survives a production build and is not stripped by the Rust compiler | Must Have |
| F-11 | Build secret seed is sourced from a `.env` file excluded from version control | Must Have |
| F-12 | CI builds use an environment variable for the seed, not a committed value | Must Have |

### 4.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NF-01 | Zero performance impact on steady-state runtime — check runs once at startup only |
| NF-02 | No network calls — entirely local and offline-capable |
| NF-03 | Must work identically on Windows, macOS, and Linux |
| NF-04 | Fingerprint must be present in all build profiles: debug, release, and CI |
| NF-05 | Implementation must not introduce any new third-party Rust crates if avoidable |

---

## 5. Technical Specification

### 5.1 Fingerprint Format

```
CM-{git_short_hash}-{semver}-{build_date}-{seed_hash}
```

**Example:**
```
CM-a3f9c12-0.1.0-20260324-x7k2
```

| Segment | Source | Notes |
|---------|--------|-------|
| `CM-` | Static prefix | Always present; absence signals tampering |
| `git_short_hash` | `git rev-parse --short HEAD` at compile time | 7 characters |
| `semver` | `CARGO_PKG_VERSION` env var | From `Cargo.toml` |
| `build_date` | System date at compile time | `YYYYMMDD` format |
| `seed_hash` | First 4 chars of SHA-256 of `CM_BUILD_SEED` env var | Not the seed itself |

### 5.2 File Structure

```
src-tauri/
  build.rs                  # Fingerprint generation — runs at compile time
  src/
    main.rs                 # Calls verify_integrity() before app launches
    integrity.rs            # Fingerprint constant, verification logic, degraded mode flag
    commands/
      build_info.rs         # Tauri command: get_build_fingerprint
```

### 5.3 `build.rs`

Runs at compile time via Cargo. Responsibilities:

- Execute `git rev-parse --short HEAD` and capture output
- Read `CM_BUILD_SEED` from environment (fail build if absent in release profile)
- Compute a 4-character seed hash using SHA-256 of the seed value
- Construct the fingerprint string
- Emit `cargo:rustc-env=CM_BUILD_FINGERPRINT={fingerprint}`
- Emit `cargo:rerun-if-env-changed=CM_BUILD_SEED` to invalidate cache on seed change

In debug builds, if `CM_BUILD_SEED` is absent, substitute `DEV` as the seed hash and emit a compiler warning. Do not fail the build in debug mode.

### 5.4 `integrity.rs`

```rust
// Baked in at compile time — not a runtime lookup
pub const BUILD_FINGERPRINT: &str = env!("CM_BUILD_FINGERPRINT");

pub fn verify_integrity() -> bool {
    // Structural checks — not just string presence
    let fp = BUILD_FINGERPRINT;
    if fp.is_empty() { return false; }
    if !fp.starts_with("CM-") { return false; }
    // Format: CM-{hash}-{semver}-{date}-{seed}
    // semver contains dots (0.1.0), not dashes, so split by '-' yields:
    // ["CM", hash, "0.1.0", date, seed] = 5 segments
    // But if semver ever uses pre-release tags with dashes (e.g. 0.1.0-beta),
    // segment count would grow. Use splitn to anchor from the prefix instead.
    let remainder = &fp[3..]; // strip "CM-"
    let segments: Vec<&str> = remainder.splitn(4, '-').collect();
    // segments: [hash, semver, date, seed]
    if segments.len() < 4 { return false; }
    true
}

pub fn is_degraded() -> bool {
    !verify_integrity()
}
```

The verification logic must reference `BUILD_FINGERPRINT` in a way that prevents the compiler from optimising it out. Use `std::hint::black_box` if needed in release builds.

### 5.5 Startup Sequence (`main.rs`)

```
1. verify_integrity() is called
2. If false → set global degraded mode flag → continue to launch (do not panic)
3. Tauri app launches
4. On window ready → frontend queries degraded mode state via Tauri command
5. If degraded → render DegradedNotice component, disable restricted features
```

Do not panic or crash on integrity failure. Degraded mode is intentional — a crash is easy to route around; a persistently broken application is not.

### 5.6 Tauri Commands

```rust
// commands/build_info.rs

#[tauri::command]
pub fn get_build_fingerprint() -> String {
    crate::integrity::BUILD_FINGERPRINT.to_string()
}

#[tauri::command]
pub fn get_integrity_status() -> bool {
    crate::integrity::verify_integrity()
}
```

Register both commands in `main.rs` via `.invoke_handler()`.

### 5.7 Frontend — Settings → About

Display the fingerprint in the existing Settings drawer under an About section.

```
Build Fingerprint
CM-a3f9c12-0.1.0-20260324-x7k2
```

- Use a monospace token from Litria design tokens
- Include a copy-to-clipboard button using a Lucide `Copy` icon
- No tooltip, no explanation — just the value and the copy action
- Do not display in any user-facing onboarding flow

### 5.8 Degraded Mode UI

When `get_integrity_status()` returns `false`:

- Render a non-dismissable banner at the top of the main window
- Banner text: `"This build of Litria could not be verified. Save, export, and build features are unavailable."`
- Use `AlertTriangle` from Lucide React for the icon
- Disable the following features: project save, file export, production build trigger
- All other features remain functional
- Do not expose the reason for failure to the user

---

## 6. Environment Variables

| Variable | Required In | Description |
|----------|-------------|-------------|
| `CM_BUILD_SEED` | Release + CI | Secret string used to generate seed hash segment. Min 32 characters. |

- Add `CM_BUILD_SEED` to `.gitignore` via `.env`
- Document the variable in `docs/DEVELOPMENT.md` without revealing its value
- CI pipeline must inject `CM_BUILD_SEED` as a secrets environment variable

---

## 7. `.env.example`

Commit this file. Do not commit `.env`.

```
# Required for release builds. Generate a random string of 32+ characters.
# Do not share or commit the actual value.
CM_BUILD_SEED=your-secret-seed-here
```

---

## 8. Acceptance Criteria

| ID | Criteria |
|----|----------|
| AC-01 | `cargo build --release` fails if `CM_BUILD_SEED` is not set |
| AC-02 | `cargo build` (debug) succeeds without `CM_BUILD_SEED` and emits a warning |
| AC-03 | The compiled binary contains the string `CM-` as a static constant verifiable with `strings` |
| AC-04 | Manually corrupting `BUILD_FINGERPRINT` in a test build triggers degraded mode on launch |
| AC-05 | Settings → About displays the fingerprint correctly on Windows and macOS |
| AC-06 | `get_build_fingerprint` Tauri command returns the correct value from the frontend |
| AC-07 | Degraded mode disables save, export, and build — all other features remain usable |
| AC-08 | No new third-party Rust crates are introduced unless unavoidable |
| AC-09 | All four architecture guards pass after implementation |
| AC-10 | `npm run build` produces a release artifact with a valid fingerprint |

---

## 9. Files to Create or Modify

| File | Action | Notes |
|------|--------|-------|
| `src-tauri/build.rs` | Create | Compile-time fingerprint generation |
| `src-tauri/src/integrity.rs` | Create | Constant, verification logic, degraded flag |
| `src-tauri/src/commands/build_info.rs` | Create | Tauri commands |
| `src-tauri/src/main.rs` | Modify | Call `verify_integrity()`, register commands |
| `src-tauri/Cargo.toml` | Modify | Add `sha2` crate if SHA-256 needed in `build.rs` |
| `.env.example` | Create | Documents required env vars without values |
| `.gitignore` | Modify | Ensure `.env` is excluded |
| `docs/DEVELOPMENT.md` | Modify | Document `CM_BUILD_SEED` requirement |
| `src/components/settings/About.jsx` | Create or Modify | Display fingerprint in Settings drawer |
| `src/components/DegradedNotice.jsx` | Create | Non-dismissable degraded mode banner |

---

## 10. Out of Scope / Future Considerations

- Binary obfuscation or packing
- Remote attestation or phone-home verification
- Per-user license keys
- Fingerprinting of community Extensions
- Automated DMCA detection pipeline

---

**END OF DOCUMENT**