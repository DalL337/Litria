#!/usr/bin/env node
// ---------------------------------------------------------------------------
// bundle-node.mjs — Download and stage a platform-specific Node.js LTS binary
//
// Downloads the pinned Node.js version for the target platform and extracts
// the node binary + npm into src-tauri/resources/node/ for Tauri bundling.
//
// Usage:
//   node scripts/bundle-node.mjs              # download for current platform
//   node scripts/bundle-node.mjs --check      # verify only, no download
//   TAURI_TARGET_TRIPLE=aarch64-apple-darwin node scripts/bundle-node.mjs  # cross-compile
//
// Version pin is read from src-tauri/src/lsp/packs/versions.rs.
// SHA256 hashes are stored in scripts/node-hashes.json.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const RESOURCES = join(PROJECT_ROOT, "src-tauri", "resources", "node");
const VERSIONS_RS = join(PROJECT_ROOT, "src-tauri", "src", "lsp", "packs", "versions.rs");
const HASHES_FILE = join(__dirname, "node-hashes.json");

const CHECK_ONLY = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Platform mapping
// ---------------------------------------------------------------------------

// Map Tauri target triples to Node.js distribution names
const PLATFORM_MAP = {
  "x86_64-pc-windows-msvc": { os: "win", arch: "x64", ext: "zip", binary: "node.exe" },
  "aarch64-apple-darwin":   { os: "darwin", arch: "arm64", ext: "tar.gz", binary: "bin/node" },
  "x86_64-apple-darwin":    { os: "darwin", arch: "x64", ext: "tar.gz", binary: "bin/node" },
  "x86_64-unknown-linux-gnu": { os: "linux", arch: "x64", ext: "tar.xz", binary: "bin/node" },
};

function detectTargetTriple() {
  // TAURI_TARGET_TRIPLE is set by Tauri during cross-compilation
  if (process.env.TAURI_TARGET_TRIPLE) {
    return process.env.TAURI_TARGET_TRIPLE;
  }
  // Detect from current platform
  const { platform, arch } = process;
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  console.error(`ERROR: Unsupported platform: ${platform}-${arch}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Read version pin
// ---------------------------------------------------------------------------

function readNodeVersion() {
  const content = readFileSync(VERSIONS_RS, "utf-8");
  const match = content.match(/const\s+NODE_VERSION:\s*&str\s*=\s*"([^"]+)"/);
  if (!match) {
    console.error("ERROR: Could not find NODE_VERSION in versions.rs");
    process.exit(1);
  }
  return match[1];
}

// ---------------------------------------------------------------------------
// SHA256 hash management
// ---------------------------------------------------------------------------

function loadHashes() {
  if (!existsSync(HASHES_FILE)) return {};
  try {
    return JSON.parse(readFileSync(HASHES_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveHashes(hashes) {
  writeFileSync(HASHES_FILE, JSON.stringify(hashes, null, 2) + "\n");
}

async function computeSha256(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function downloadFile(url, destPath) {
  console.log(`  Downloading: ${url}`);

  // Use Node's built-in fetch (available since Node 18)
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const totalBytes = Number(response.headers.get("content-length") || 0);
  const fileStream = createWriteStream(destPath);
  const reader = response.body.getReader();

  let downloaded = 0;
  let lastProgress = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(Buffer.from(value));
    downloaded += value.byteLength;

    // Progress every 10%
    if (totalBytes > 0) {
      const pct = Math.floor((downloaded / totalBytes) * 100);
      if (pct >= lastProgress + 10) {
        lastProgress = pct;
        process.stdout.write(`  ${pct}%...`);
      }
    }
  }

  fileStream.end();
  await new Promise((resolve) => fileStream.on("finish", resolve));

  if (totalBytes > 0) console.log(" done");
  console.log(`  Downloaded ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

function extractArchive(archivePath, destDir, platformInfo, nodeVersion) {
  mkdirSync(destDir, { recursive: true });
  const archiveName = `node-v${nodeVersion}-${platformInfo.os}-${platformInfo.arch}`;

  if (platformInfo.ext === "zip") {
    // Windows: use PowerShell to extract
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
      { stdio: "pipe" },
    );
    // Move contents from nested directory to dest root
    const nested = join(destDir, archiveName);
    if (existsSync(nested)) {
      execSync(`xcopy /E /Y /Q "${nested}\\*" "${destDir}\\" > nul 2>&1`, { stdio: "pipe", shell: true });
      rmSync(nested, { recursive: true, force: true });
    }
  } else if (platformInfo.ext === "tar.gz") {
    execSync(`tar xzf "${archivePath}" -C "${destDir}" --strip-components=1`, { stdio: "pipe" });
  } else if (platformInfo.ext === "tar.xz") {
    execSync(`tar xJf "${archivePath}" -C "${destDir}" --strip-components=1`, { stdio: "pipe" });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Litria Node.js Bundler ===\n");

  const nodeVersion = readNodeVersion();
  const targetTriple = detectTargetTriple();
  const platformInfo = PLATFORM_MAP[targetTriple];

  if (!platformInfo) {
    console.error(`ERROR: No Node.js mapping for target: ${targetTriple}`);
    process.exit(1);
  }

  console.log(`Node.js version: ${nodeVersion}`);
  console.log(`Target:          ${targetTriple} (${platformInfo.os}-${platformInfo.arch})\n`);

  // Check if already extracted at correct version
  const versionFile = join(RESOURCES, ".node-version");
  if (existsSync(versionFile)) {
    const installed = readFileSync(versionFile, "utf-8").trim();
    const binaryPath = join(RESOURCES, platformInfo.binary);
    if (installed === `${nodeVersion}-${targetTriple}` && existsSync(binaryPath)) {
      console.log(`Node.js ${nodeVersion} already staged for ${targetTriple}`);
      if (CHECK_ONLY) return;
      console.log("Skipping download.\n");
      return;
    }
  }

  if (CHECK_ONLY) {
    console.log("NEEDS UPDATE — Node.js not staged or wrong version");
    process.exitCode = 1;
    return;
  }

  // Construct download URL
  const archiveName = `node-v${nodeVersion}-${platformInfo.os}-${platformInfo.arch}`;
  const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}.${platformInfo.ext}`;

  // Download to temp file
  const tmpDir = join(PROJECT_ROOT, "src-tauri", "resources", ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const archivePath = join(tmpDir, `${archiveName}.${platformInfo.ext}`);

  try {
    await downloadFile(url, archivePath);

    // Compute and verify SHA256
    const sha256 = await computeSha256(archivePath);
    console.log(`  SHA256: ${sha256}`);

    // Check against stored hashes
    const hashes = loadHashes();
    const storedHash = hashes[nodeVersion]?.[targetTriple];
    if (storedHash && storedHash !== sha256) {
      console.error(`\nERROR: SHA256 mismatch!`);
      console.error(`  Expected: ${storedHash}`);
      console.error(`  Got:      ${sha256}`);
      console.error(`  The archive may have been tampered with.`);
      process.exit(1);
    }

    // Store hash if first download
    if (!storedHash) {
      if (!hashes[nodeVersion]) hashes[nodeVersion] = {};
      hashes[nodeVersion][targetTriple] = sha256;
      saveHashes(hashes);
      console.log(`  Hash recorded in node-hashes.json (first download for this platform)`);
    } else {
      console.log(`  Hash verified ✓`);
    }

    // Clean previous extraction (preserve .gitkeep)
    if (existsSync(RESOURCES)) {
      for (const entry of fs.readdirSync(RESOURCES)) {
        if (entry === ".gitkeep") continue;
        rmSync(join(RESOURCES, entry), { recursive: true, force: true });
      }
    }

    // Extract
    console.log(`\nExtracting to ${RESOURCES}...`);
    extractArchive(archivePath, RESOURCES, platformInfo, nodeVersion);

    // Write version marker
    writeFileSync(versionFile, `${nodeVersion}-${targetTriple}\n`);

    // Verify the binary works
    const binaryPath = join(RESOURCES, platformInfo.binary);
    if (!existsSync(binaryPath)) {
      console.error(`\nERROR: Expected binary not found at ${binaryPath}`);
      process.exit(1);
    }

    const versionOutput = execSync(`"${binaryPath}" --version`, { encoding: "utf-8" }).trim();
    console.log(`\nVerification: ${binaryPath} → ${versionOutput}`);

    if (!versionOutput.startsWith(`v${nodeVersion}`)) {
      console.error(`\nERROR: Version mismatch — expected v${nodeVersion}, got ${versionOutput}`);
      process.exit(1);
    }

    // Report size
    const sizeCmd = process.platform === "win32"
      ? `powershell -NoProfile -Command "(Get-ChildItem -Recurse '${RESOURCES}' | Measure-Object -Property Length -Sum).Sum / 1MB"`
      : `du -sm "${RESOURCES}" | cut -f1`;
    const sizeMb = execSync(sizeCmd, { encoding: "utf-8" }).trim();
    console.log(`Extracted size: ${Math.round(parseFloat(sizeMb))} MB`);

    console.log(`\nNode.js ${nodeVersion} staged successfully for ${targetTriple}.`);
  } finally {
    // Clean up temp
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
