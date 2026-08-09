import fs from 'node:fs';
import path from 'node:path';

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function formatMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}ms` : 'n/a';
}

const targetFile = process.argv[2] ?? 'docs/plans/interaction-latency-samples.json';
const absolute = path.resolve(process.cwd(), targetFile);

if (!fs.existsSync(absolute)) {
  console.error(`Latency file not found: ${targetFile}`);
  process.exit(1);
}

const raw = fs.readFileSync(absolute, 'utf8');
let data;
try {
  data = JSON.parse(raw);
} catch (error) {
  console.error(`Invalid JSON in ${targetFile}: ${error.message}`);
  process.exit(1);
}

const samples = Array.isArray(data.samplesMs)
  ? data.samplesMs.filter((value) => Number.isFinite(value) && value >= 0)
  : [];
const threshold = Number.isFinite(data.thresholdMsP95) ? data.thresholdMsP95 : null;

if (!samples.length) {
  console.error('No valid samplesMs values found.');
  process.exit(1);
}

const p95 = percentile(samples, 95);
const min = Math.min(...samples);
const max = Math.max(...samples);
const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;

console.log(`Drag latency samples: ${samples.length}`);
console.log(`min=${formatMs(min)} avg=${formatMs(avg)} p95=${formatMs(p95)} max=${formatMs(max)}`);

if (threshold == null) {
  console.log('No thresholdMsP95 set; skipping pass/fail threshold check.');
  process.exit(0);
}

console.log(`threshold p95=${formatMs(threshold)}`);
if (p95 > threshold) {
  console.error(`FAILED: p95 ${formatMs(p95)} is above threshold ${formatMs(threshold)}.`);
  process.exit(1);
}

console.log('PASS: p95 latency is within threshold.');
