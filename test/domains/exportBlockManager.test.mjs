import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findManagedExportBlock,
  findInlineExport,
  addToExportBlock,
  removeFromExportBlock,
} from '../../src/app/exportBlockManager.js';

const FP = '/test/file.ts';

// ---------------------------------------------------------------------------
// findManagedExportBlock
// ---------------------------------------------------------------------------

test('findManagedExportBlock — returns null for empty file', () => {
  assert.equal(findManagedExportBlock(''), null);
});

test('findManagedExportBlock — returns null when no export block exists', () => {
  const text = [
    'const a = 1;',
    'function foo() {}',
  ].join('\n');
  assert.equal(findManagedExportBlock(text), null);
});

test('findManagedExportBlock — detects single-line block', () => {
  const text = [
    'function foo() {}',
    'function bar() {}',
    'export { foo, bar };',
  ].join('\n');
  const block = findManagedExportBlock(text);
  assert.ok(block);
  assert.equal(block.startLine, 2);
  assert.equal(block.endLine, 2);
  assert.deepEqual(block.symbols, ['foo', 'bar']);
});

test('findManagedExportBlock — detects multi-line block', () => {
  const text = [
    'function foo() {}',
    'export {',
    '  foo,',
    '  bar',
    '};',
  ].join('\n');
  const block = findManagedExportBlock(text);
  assert.ok(block);
  assert.equal(block.startLine, 1);
  assert.equal(block.endLine, 4);
  assert.deepEqual(block.symbols, ['foo', 'bar']);
});

test('findManagedExportBlock — skips re-export blocks', () => {
  const text = [
    "export { helper } from './utils';",
    'function local() {}',
    'export { local };',
  ].join('\n');
  const block = findManagedExportBlock(text);
  assert.ok(block);
  assert.equal(block.startLine, 2);
  assert.deepEqual(block.symbols, ['local']);
});

test('findManagedExportBlock — returns LAST non-re-export block', () => {
  const text = [
    'export { first };',
    "export { reexported } from './other';",
    'export { second, third };',
  ].join('\n');
  const block = findManagedExportBlock(text);
  assert.ok(block);
  assert.equal(block.startLine, 2);
  assert.deepEqual(block.symbols, ['second', 'third']);
});

test('findManagedExportBlock — handles alias (keeps alias name)', () => {
  const text = 'export { createThing as makeStuff, plainName };';
  const block = findManagedExportBlock(text);
  assert.ok(block);
  assert.deepEqual(block.symbols, ['makeStuff', 'plainName']);
});

test('findManagedExportBlock — handles export type block', () => {
  const text = 'export type { MyType, OtherType };';
  const block = findManagedExportBlock(text);
  assert.ok(block);
  assert.deepEqual(block.symbols, ['MyType', 'OtherType']);
});

test('findManagedExportBlock — only re-exports means null', () => {
  const text = [
    "export { a } from './a';",
    "export { b } from './b';",
  ].join('\n');
  assert.equal(findManagedExportBlock(text), null);
});

test('findManagedExportBlock — empty export block returns empty symbols', () => {
  const text = 'export { };';
  const block = findManagedExportBlock(text);
  assert.ok(block);
  assert.deepEqual(block.symbols, []);
});

// ---------------------------------------------------------------------------
// findInlineExport
// ---------------------------------------------------------------------------

test('findInlineExport — finds exported function', () => {
  const text = [
    'const x = 1;',
    'export function myFunc() {}',
  ].join('\n');
  assert.equal(findInlineExport(text, 'myFunc'), 1);
});

test('findInlineExport — finds exported async function', () => {
  const text = 'export async function fetchData() {}';
  assert.equal(findInlineExport(text, 'fetchData'), 0);
});

test('findInlineExport — finds exported class', () => {
  const text = 'export class Widget {}';
  assert.equal(findInlineExport(text, 'Widget'), 0);
});

test('findInlineExport — finds exported abstract class', () => {
  const text = 'export abstract class Base {}';
  assert.equal(findInlineExport(text, 'Base'), 0);
});

test('findInlineExport — finds exported const', () => {
  const text = 'export const MAX = 100;';
  assert.equal(findInlineExport(text, 'MAX'), 0);
});

test('findInlineExport — finds exported let', () => {
  const text = 'export let counter = 0;';
  assert.equal(findInlineExport(text, 'counter'), 0);
});

test('findInlineExport — finds exported type alias', () => {
  const text = 'export type Config = { key: string };';
  assert.equal(findInlineExport(text, 'Config'), 0);
});

test('findInlineExport — finds exported type with generic', () => {
  const text = 'export type Result<T> = { data: T };';
  assert.equal(findInlineExport(text, 'Result'), 0);
});

test('findInlineExport — finds exported interface', () => {
  const text = 'export interface Props { name: string; }';
  assert.equal(findInlineExport(text, 'Props'), 0);
});

test('findInlineExport — finds exported enum', () => {
  const text = 'export enum Status { Active, Inactive }';
  assert.equal(findInlineExport(text, 'Status'), 0);
});

test('findInlineExport — finds export default function', () => {
  const text = 'export default function main() {}';
  assert.equal(findInlineExport(text, 'main'), 0);
});

test('findInlineExport — finds export default async function', () => {
  const text = 'export default async function handler() {}';
  assert.equal(findInlineExport(text, 'handler'), 0);
});

test('findInlineExport — returns -1 when not found', () => {
  const text = 'function notExported() {}';
  assert.equal(findInlineExport(text, 'notExported'), -1);
});

test('findInlineExport — does not match partial name', () => {
  const text = 'export function fooBar() {}';
  assert.equal(findInlineExport(text, 'foo'), -1);
});

test('findInlineExport — handles indented export', () => {
  const text = '  export function indented() {}';
  assert.equal(findInlineExport(text, 'indented'), 0);
});

// ---------------------------------------------------------------------------
// addToExportBlock — no-op cases
// ---------------------------------------------------------------------------

test('addToExportBlock — no-op if symbol is inline-exported', () => {
  const text = 'export function foo() {}';
  const plans = addToExportBlock(text, FP, 'foo');
  assert.deepEqual(plans, []);
});

test('addToExportBlock — no-op if symbol already in managed block', () => {
  const text = [
    'function foo() {}',
    'export { foo };',
  ].join('\n');
  const plans = addToExportBlock(text, FP, 'foo');
  assert.deepEqual(plans, []);
});

// ---------------------------------------------------------------------------
// addToExportBlock — create new block at EOF
// ---------------------------------------------------------------------------

test('addToExportBlock — creates block at EOF when none exists', () => {
  const text = 'function foo() {}\n';
  const plans = addToExportBlock(text, FP, 'foo');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, 'insert');
  assert.equal(plans[0].filePath, FP);
  assert.equal(plans[0].text, 'export { foo };\n');
});

test('addToExportBlock — adds newline prefix when file does not end with newline', () => {
  const text = 'function foo() {}';
  const plans = addToExportBlock(text, FP, 'foo');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, 'insert');
  assert.ok(plans[0].text.startsWith('\n'));
  assert.ok(plans[0].text.includes('export { foo };'));
});

// ---------------------------------------------------------------------------
// addToExportBlock — append to existing single-line block
// ---------------------------------------------------------------------------

test('addToExportBlock — appends to existing single-line block', () => {
  const text = [
    'function foo() {}',
    'function bar() {}',
    'export { foo };',
  ].join('\n');
  const plans = addToExportBlock(text, FP, 'bar');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, 'replace');
  assert.equal(plans[0].line, 2);
  assert.equal(plans[0].text, 'export { foo, bar };\n');
});

// ---------------------------------------------------------------------------
// addToExportBlock — collapse multi-line block
// ---------------------------------------------------------------------------

test('addToExportBlock — collapses multi-line block when appending', () => {
  const text = [
    'function foo() {}',
    'export {',
    '  foo',
    '};',
  ].join('\n');
  const plans = addToExportBlock(text, FP, 'bar');
  // Should remove lines bottom-first, then replace startLine
  assert.ok(plans.length > 1);
  // First ops should be removeLine for endLine down to startLine+1
  const removeOps = plans.filter((p) => p.kind === 'removeLine');
  const replaceOps = plans.filter((p) => p.kind === 'replace');
  assert.equal(removeOps.length, 2); // lines 3 and 2
  assert.equal(replaceOps.length, 1);
  assert.equal(replaceOps[0].line, 1);
  assert.equal(replaceOps[0].text, 'export { foo, bar };\n');
  // removeLine should be bottom-first
  assert.equal(removeOps[0].line, 3);
  assert.equal(removeOps[1].line, 2);
});

// ---------------------------------------------------------------------------
// removeFromExportBlock
// ---------------------------------------------------------------------------

test('removeFromExportBlock — returns empty if no managed block', () => {
  const text = 'function foo() {}';
  const plans = removeFromExportBlock(text, FP, 'foo');
  assert.deepEqual(plans, []);
});

test('removeFromExportBlock — returns empty if symbol not in block', () => {
  const text = 'export { foo };';
  const plans = removeFromExportBlock(text, FP, 'bar');
  assert.deepEqual(plans, []);
});

test('removeFromExportBlock — removes entire block when last symbol removed', () => {
  const text = [
    'function foo() {}',
    'export { foo };',
  ].join('\n');
  const plans = removeFromExportBlock(text, FP, 'foo');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, 'removeLine');
  assert.equal(plans[0].line, 1);
});

test('removeFromExportBlock — removes entire multi-line block when last symbol removed', () => {
  const text = [
    'function foo() {}',
    'export {',
    '  foo',
    '};',
  ].join('\n');
  const plans = removeFromExportBlock(text, FP, 'foo');
  // Should remove lines bottom-first: 3, 2, 1
  assert.equal(plans.length, 3);
  assert.equal(plans[0].kind, 'removeLine');
  assert.equal(plans[0].line, 3);
  assert.equal(plans[1].line, 2);
  assert.equal(plans[2].line, 1);
});

test('removeFromExportBlock — rewrites block without removed symbol (single-line)', () => {
  const text = 'export { foo, bar, baz };';
  const plans = removeFromExportBlock(text, FP, 'bar');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, 'replace');
  assert.equal(plans[0].line, 0);
  assert.equal(plans[0].text, 'export { foo, baz };\n');
});

test('removeFromExportBlock — collapses multi-line to single-line after removal', () => {
  const text = [
    'export {',
    '  alpha,',
    '  beta,',
    '  gamma',
    '};',
  ].join('\n');
  const plans = removeFromExportBlock(text, FP, 'beta');
  const removeOps = plans.filter((p) => p.kind === 'removeLine');
  const replaceOps = plans.filter((p) => p.kind === 'replace');
  assert.ok(removeOps.length > 0);
  assert.equal(replaceOps.length, 1);
  assert.equal(replaceOps[0].text, 'export { alpha, gamma };\n');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('addToExportBlock — works with empty file', () => {
  const plans = addToExportBlock('', FP, 'foo');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, 'insert');
  assert.ok(plans[0].text.includes('export { foo };'));
});

test('addToExportBlock — ignores re-export blocks and creates new', () => {
  const text = "export { helper } from './utils';\nfunction local() {}";
  const plans = addToExportBlock(text, FP, 'local');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, 'insert');
  assert.ok(plans[0].text.includes('export { local };'));
});

test('removeFromExportBlock — does not touch re-export blocks', () => {
  const text = [
    "export { helper } from './utils';",
    'export { local };',
  ].join('\n');
  // Remove from managed block, not the re-export
  const plans = removeFromExportBlock(text, FP, 'helper');
  // 'helper' is in the re-export, not the managed block
  assert.deepEqual(plans, []);
});

test('findManagedExportBlock — handles block with trailing comma', () => {
  const text = 'export { foo, bar, };';
  const block = findManagedExportBlock(text);
  assert.ok(block);
  assert.deepEqual(block.symbols, ['foo', 'bar']);
});

test('addToExportBlock — handles file with only comments', () => {
  const text = '// just a comment\n';
  const plans = addToExportBlock(text, FP, 'foo');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, 'insert');
});

test('round-trip: add then remove returns to empty block removal', () => {
  const text = 'function foo() {}\n';
  // Add foo
  const addPlans = addToExportBlock(text, FP, 'foo');
  assert.equal(addPlans.length, 1);
  assert.ok(addPlans[0].text.includes('export { foo };'));

  // Simulate the text after adding
  const afterAdd = text + 'export { foo };\n';
  // Remove foo
  const removePlans = removeFromExportBlock(afterAdd, FP, 'foo');
  assert.ok(removePlans.length > 0);
  assert.equal(removePlans[0].kind, 'removeLine');
});

test('addToExportBlock — multiple sequential adds build up the block', () => {
  const text0 = 'function a() {}\nfunction b() {}\nfunction c() {}\n';

  // Add a
  const p1 = addToExportBlock(text0, FP, 'a');
  assert.ok(p1[0].text.includes('export { a };'));

  // Simulate text after adding a
  const text1 = text0 + 'export { a };\n';
  const p2 = addToExportBlock(text1, FP, 'b');
  assert.ok(p2[0].text.includes('export { a, b };'));

  // Simulate text after adding b
  const text2 = text0 + 'export { a, b };\n';
  const p3 = addToExportBlock(text2, FP, 'c');
  assert.ok(p3[0].text.includes('export { a, b, c };'));
});
