import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// Most domain files follow the create*Domain() factory pattern.
// Some use a use*Domain() hook pattern (React integration layer).
// Orchestration.md requires each domain to expose at minimum: { commands }.
// This guard verifies the contract is present in every domain file.

const DOMAIN_GLOBS = [
  'src/app',
  'src/terminal',
  'src/scaffold',
  'src/project',
  'src/preferences'
];

const DOMAIN_FILE_PATTERN = /Domain\.js$/;

function normalize(filePath) {
  return filePath.replaceAll('\\', '/');
}

function collectDomainFiles() {
  const files = [];
  for (const dir of DOMAIN_GLOBS) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) continue;
    for (const entry of fs.readdirSync(absDir)) {
      if (DOMAIN_FILE_PATTERN.test(entry)) {
        files.push({ absPath: path.join(absDir, entry), repoPath: normalize(path.join(dir, entry)) });
      }
    }
  }
  return files;
}

function run() {
  const domainFiles = collectDomainFiles();

  if (domainFiles.length === 0) {
    console.error('Domain contract guard: no domain files found.');
    process.exit(1);
  }

  const violations = [];

  for (const { absPath, repoPath } of domainFiles) {
    const content = fs.readFileSync(absPath, 'utf8');

    // Must export a create*Domain factory or use*Domain hook
    const hasFactory = /export\s+function\s+create\w+Domain\s*\(/.test(content);
    const hasHook = /export\s+function\s+use\w+Domain\s*\(/.test(content);
    if (!hasFactory && !hasHook) {
      violations.push(`${repoPath}: missing create*Domain() or use*Domain() export`);
      continue;
    }

    // Must expose commands — either inline { commands: { } } or shorthand { commands }
    const hasInlineCommands = /commands\s*:\s*\{/.test(content);
    const hasCommandsVar = /\bconst\s+commands\s*=\s*\{/.test(content);
    if (!hasInlineCommands && !hasCommandsVar) {
      violations.push(`${repoPath}: domain does not expose commands`);
    }
  }

  if (violations.length > 0) {
    console.error('Domain contract guard failed.');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(`Domain contract guard passed (${domainFiles.length} domains).`);
}

run();
