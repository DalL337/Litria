#!/usr/bin/env node
// ---------------------------------------------------------------------------
// bundle-conpty.mjs — Stage Microsoft's ConPTY redistributable for Windows
//
// Why: Windows 10's in-box console host (conhost.exe) has a frame-delivery
// bug that cuts interactive CLI prompts off mid-escape-sequence — the prompt
// never renders, the CLI waits forever on invisible UI, and the embedded
// terminal looks frozen (diagnosed 2026-07-07 via the repro harness in
// src-tauri/tests/interactive_pty_repro.rs; trigger case: `npm create vite`
// → create-vite's clack "Which linter to use?" prompt).
//
// Fix: portable-pty prefers a sideloaded conpty.dll + OpenConsole.exe over
// kernel32 when they sit next to the executable (portable-pty 0.9.0,
// src/win/psuedocon.rs). VS Code and JetBrains ship the same pair for the
// same reason. This script downloads Microsoft's first-party redistributable
// (NuGet: Microsoft.Windows.Console.ConPTY, MIT-licensed, built from
// microsoft/terminal) at a pinned version and stages the win-x64 pair into
// src-tauri/resources/conpty/. tauri.conf.json maps them to the bundle root
// so they land beside litria.exe at install time.
//
// Usage:
//   node scripts/bundle-conpty.mjs          # download + stage
//   node scripts/bundle-conpty.mjs --check  # verify only, no download
//
// The script is idempotent — it skips work when the staged VERSION matches.
// It also mirrors the pair into src-tauri/target/debug/ (when present) so
// dev builds get the fixed console host too.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const STAGE_DIR = join(PROJECT_ROOT, "src-tauri", "resources", "conpty");
const TMP_DIR = join(PROJECT_ROOT, "src-tauri", "resources", ".tmp", "conpty");
const DEBUG_DIR = join(PROJECT_ROOT, "src-tauri", "target", "debug");

// Pinned redistributable version (https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY)
const CONPTY_VERSION = "1.24.260512001";
const NUPKG_URL = `https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/${CONPTY_VERSION}/microsoft.windows.console.conpty.${CONPTY_VERSION}.nupkg`;

// Paths inside the nupkg (a zip) for the x64 pair.
const IN_PKG = {
  "conpty.dll": "runtimes/win-x64/native/conpty.dll",
  "OpenConsole.exe": "build/native/runtimes/x64/OpenConsole.exe",
};

const CHECK_ONLY = process.argv.includes("--check");
const VERSION_FILE = join(STAGE_DIR, "VERSION");

function stagedVersion() {
  try {
    return readFileSync(VERSION_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

function isStaged() {
  return (
    stagedVersion() === CONPTY_VERSION &&
    Object.keys(IN_PKG).every((name) => existsSync(join(STAGE_DIR, name)))
  );
}

function extract(nupkgPath) {
  // bsdtar (Windows 10+ tar.exe, macOS tar) reads zip archives directly.
  // GNU tar (typical Linux) does not — fall back to unzip there.
  const entries = Object.values(IN_PKG).join(" ");
  try {
    execSync(`tar -xf "${nupkgPath}" ${entries}`, { cwd: TMP_DIR, stdio: "pipe" });
    return;
  } catch {
    execSync(`unzip -o "${nupkgPath}" ${entries}`, { cwd: TMP_DIR, stdio: "pipe" });
  }
}

function mirrorToDebugDir() {
  if (!existsSync(DEBUG_DIR)) return;
  for (const name of Object.keys(IN_PKG)) {
    copyFileSync(join(STAGE_DIR, name), join(DEBUG_DIR, name));
  }
  console.log(`  ✓ mirrored into target/debug/ for dev builds`);
}

console.log("=== Litria ConPTY Bundler ===\n");
console.log(`Pinned redistributable: Microsoft.Windows.Console.ConPTY ${CONPTY_VERSION} (MIT)\n`);

if (isStaged()) {
  console.log("  ✓ conpty.dll + OpenConsole.exe already staged at pinned version");
  if (!CHECK_ONLY) mirrorToDebugDir();
  process.exit(0);
}

if (CHECK_ONLY) {
  console.log(
    `  ✗ NEEDS STAGING (found: ${stagedVersion() ?? "nothing"}, want: ${CONPTY_VERSION})`,
  );
  process.exit(1);
}

rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(STAGE_DIR, { recursive: true });

const nupkgPath = join(TMP_DIR, "conpty.nupkg");
console.log(`  Downloading ${NUPKG_URL}`);
execSync(`curl -sSfL -o "${nupkgPath}" "${NUPKG_URL}"`, { stdio: "pipe" });

console.log("  Extracting win-x64 conpty.dll + OpenConsole.exe");
extract(nupkgPath);

for (const [name, pkgPath] of Object.entries(IN_PKG)) {
  const src = join(TMP_DIR, ...pkgPath.split("/"));
  if (!existsSync(src)) {
    console.error(`  ✗ expected ${pkgPath} inside the nupkg — layout changed?`);
    process.exit(1);
  }
  copyFileSync(src, join(STAGE_DIR, name));
  console.log(`  ✓ staged ${name}`);
}

writeFileSync(VERSION_FILE, `${CONPTY_VERSION}\n`);
writeFileSync(
  join(STAGE_DIR, "PROVENANCE.txt"),
  `Microsoft.Windows.Console.ConPTY ${CONPTY_VERSION}\n` +
    `Source: ${NUPKG_URL}\n` +
    `License: MIT (Microsoft, built from https://github.com/microsoft/terminal)\n` +
    `Staged by scripts/bundle-conpty.mjs — do not edit by hand.\n`,
);

rmSync(TMP_DIR, { recursive: true, force: true });
mirrorToDebugDir();

console.log("\nConPTY redistributable staged successfully.");
