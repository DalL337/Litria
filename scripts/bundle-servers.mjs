#!/usr/bin/env node
// ---------------------------------------------------------------------------
// bundle-servers.mjs — Package pinned LSP servers for Tauri bundling
//
// Downloads pyright + typescript-language-server + typescript into isolated
// npm prefix directories under src-tauri/resources/servers/.  These are
// included in the Tauri app bundle so language intelligence works on first
// launch without requiring `npm install -g`.
//
// Usage:
//   node scripts/bundle-servers.mjs          # bundle all
//   node scripts/bundle-servers.mjs --check  # verify only, no install
//
// Version pins are read from src-tauri/src/lsp/packs/versions.rs (single
// source of truth).  The script is idempotent — it skips servers that are
// already installed at the correct version.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const RESOURCES = join(PROJECT_ROOT, "src-tauri", "resources", "servers");
const VERSIONS_RS = join(
  PROJECT_ROOT,
  "src-tauri",
  "src",
  "lsp",
  "packs",
  "versions.rs",
);

const CHECK_ONLY = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Read version pins from versions.rs
// ---------------------------------------------------------------------------

function readVersionPins() {
  const content = readFileSync(VERSIONS_RS, "utf-8");
  const extract = (name) => {
    const match = content.match(
      new RegExp(`const\\s+${name}:\\s*&str\\s*=\\s*"([^"]+)"`),
    );
    if (!match) {
      console.error(`ERROR: Could not find ${name} in versions.rs`);
      process.exit(1);
    }
    return match[1];
  };

  return {
    pyright: extract("PYRIGHT_VERSION"),
    tsserver: extract("TSSERVER_VERSION"),
    typescript: extract("TYPESCRIPT_VERSION"),
  };
}

// ---------------------------------------------------------------------------
// Check installed version in a prefix directory
// ---------------------------------------------------------------------------

function getInstalledVersion(prefixDir, packageName) {
  const pkgJson = join(prefixDir, "node_modules", packageName, "package.json");
  if (!existsSync(pkgJson)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Install a server into an isolated prefix
// ---------------------------------------------------------------------------

function installServer(name, prefixDir, packages) {
  // Check if all packages are already at the correct version
  const allCurrent = packages.every(({ pkg, version }) => {
    const installed = getInstalledVersion(prefixDir, pkg);
    if (installed === version) {
      console.log(`  ✓ ${pkg}@${version} already installed`);
      return true;
    }
    if (installed) {
      console.log(`  ↑ ${pkg} ${installed} → ${version}`);
    }
    return false;
  });

  if (allCurrent) {
    console.log(`  ${name}: up to date\n`);
    return;
  }

  if (CHECK_ONLY) {
    console.log(`  ${name}: NEEDS UPDATE\n`);
    process.exitCode = 1;
    return;
  }

  // Clean and reinstall
  if (existsSync(prefixDir)) {
    rmSync(prefixDir, { recursive: true, force: true });
  }
  mkdirSync(prefixDir, { recursive: true });

  const pkgSpecs = packages.map(({ pkg, version }) => `${pkg}@${version}`);
  const cmd = `npm install --prefix "${prefixDir}" --no-save --no-audit --no-fund ${pkgSpecs.join(" ")}`;

  console.log(`  Installing: ${pkgSpecs.join(", ")}`);
  try {
    execSync(cmd, { stdio: "pipe", cwd: PROJECT_ROOT });
    console.log(`  ${name}: installed successfully\n`);
  } catch (err) {
    console.error(`  ERROR: ${name} install failed`);
    console.error(err.stderr?.toString() || err.message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Verify expected entry points exist after install
// ---------------------------------------------------------------------------

function verifyEntryPoints(pins) {
  const checks = [
    {
      name: "pyright langserver entry",
      path: join(
        RESOURCES,
        "python",
        "node_modules",
        "pyright",
        "langserver.index.js",
      ),
    },
    {
      name: "typescript-language-server entry",
      path: join(
        RESOURCES,
        "typescript",
        "node_modules",
        "typescript-language-server",
        "lib",
        "cli.mjs",
      ),
    },
    {
      name: "TypeScript compiler (tsc)",
      path: join(
        RESOURCES,
        "typescript",
        "node_modules",
        "typescript",
        "lib",
        "tsc.js",
      ),
    },
  ];

  let ok = true;
  for (const { name, path } of checks) {
    if (existsSync(path)) {
      console.log(`  ✓ ${name}`);
    } else {
      console.error(`  ✗ ${name} — missing: ${path}`);
      ok = false;
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("=== Litria Server Bundler ===\n");

const pins = readVersionPins();
console.log(
  `Version pins (from versions.rs):\n` +
    `  pyright:                    ${pins.pyright}\n` +
    `  typescript-language-server: ${pins.tsserver}\n` +
    `  typescript:                 ${pins.typescript}\n`,
);

console.log("Python (pyright):");
installServer("pyright", join(RESOURCES, "python"), [
  { pkg: "pyright", version: pins.pyright },
]);

console.log("TypeScript (tsserver + compiler):");
installServer("typescript", join(RESOURCES, "typescript"), [
  { pkg: "typescript-language-server", version: pins.tsserver },
  { pkg: "typescript", version: pins.typescript },
]);

if (!CHECK_ONLY) {
  console.log("Verifying entry points:");
  if (!verifyEntryPoints(pins)) {
    console.error("\nEntry point verification failed.");
    process.exitCode = 1;
  } else {
    console.log("\nAll servers bundled successfully.");
  }
}
