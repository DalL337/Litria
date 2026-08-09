import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJsTsDefinitions, parseJsTsExports } from '../../src/app/jstsSymbolParser.js';

const FP = '/test/file.ts';

// ---------------------------------------------------------------------------
// parseJsTsDefinitions — non-exported definitions
// ---------------------------------------------------------------------------

test('captures non-exported function declaration', () => {
  const text = 'function helper() { return 1; }';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'helper');
  assert.equal(defs[0].definitionKind, 'function');
  assert.equal(defs[0].exported, false);
  assert.equal(defs[0].exportKind, null);
});

test('captures non-exported async function', () => {
  const text = 'async function fetchData() {}';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'fetchData');
  assert.equal(defs[0].definitionKind, 'function');
  assert.equal(defs[0].exported, false);
});

test('captures non-exported class', () => {
  const text = 'class MyService {\n  run() {}\n}';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'MyService');
  assert.equal(defs[0].definitionKind, 'class');
  assert.equal(defs[0].exported, false);
});

test('captures non-exported const, let, var', () => {
  const text = [
    'const API_KEY = "abc";',
    'let counter = 0;',
    'var legacy = true;',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 3);
  assert.equal(defs[0].name, 'API_KEY');
  assert.equal(defs[0].definitionKind, 'const');
  assert.equal(defs[1].name, 'counter');
  assert.equal(defs[1].definitionKind, 'let');
  assert.equal(defs[2].name, 'legacy');
  assert.equal(defs[2].definitionKind, 'var');
});

test('captures non-exported arrow function assigned to const', () => {
  const text = 'const greet = (name) => `Hello ${name}`;';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'greet');
  assert.equal(defs[0].definitionKind, 'const');
  assert.equal(defs[0].exported, false);
});

test('captures non-exported TS type alias', () => {
  const text = 'type Config = { host: string; port: number };';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'Config');
  assert.equal(defs[0].definitionKind, 'type');
  assert.equal(defs[0].exported, false);
});

test('captures non-exported TS interface', () => {
  const text = 'interface UserProps {\n  name: string;\n}';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'UserProps');
  assert.equal(defs[0].definitionKind, 'interface');
  assert.equal(defs[0].exported, false);
});

test('captures non-exported TS enum', () => {
  const text = 'enum Direction {\n  Up,\n  Down,\n}';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'Direction');
  assert.equal(defs[0].definitionKind, 'enum');
  assert.equal(defs[0].exported, false);
});

// ---------------------------------------------------------------------------
// parseJsTsDefinitions — exported definitions
// ---------------------------------------------------------------------------

test('captures inline-exported function', () => {
  const text = 'export function doWork() {}';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'doWork');
  assert.equal(defs[0].definitionKind, 'function');
  assert.equal(defs[0].exported, true);
  assert.equal(defs[0].exportKind, 'named');
});

test('captures export default function', () => {
  const text = 'export default function Main() {}';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'Main');
  assert.equal(defs[0].exported, true);
  assert.equal(defs[0].exportKind, 'default');
  assert.equal(defs[0].definitionKind, 'function');
});

test('captures export default class', () => {
  const text = 'export default class App {}';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'App');
  assert.equal(defs[0].definitionKind, 'class');
  assert.equal(defs[0].exportKind, 'default');
});

test('captures export const/let/var with correct definitionKind', () => {
  const text = [
    'export const A = 1;',
    'export let B = 2;',
    'export var C = 3;',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 3);
  assert.equal(defs[0].definitionKind, 'const');
  assert.equal(defs[1].definitionKind, 'let');
  assert.equal(defs[2].definitionKind, 'var');
  assert.ok(defs.every((d) => d.exported === true));
  assert.ok(defs.every((d) => d.exportKind === 'named'));
});

test('captures export type alias', () => {
  const text = 'export type Props = { x: number };';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'Props');
  assert.equal(defs[0].definitionKind, 'type');
  assert.equal(defs[0].exportKind, 'type');
});

test('captures export interface', () => {
  const text = 'export interface Handler { run(): void; }';
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'Handler');
  assert.equal(defs[0].definitionKind, 'interface');
  assert.equal(defs[0].exportKind, 'named');
});

// ---------------------------------------------------------------------------
// parseJsTsDefinitions — mixed exported + non-exported
// ---------------------------------------------------------------------------

test('mixed file: captures both exported and non-exported', () => {
  const text = [
    'const INTERNAL_KEY = "secret";',
    '',
    'function helper() {}',
    '',
    'export function publicApi() {}',
    '',
    'export class Widget {}',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 4);

  const internal = defs.find((d) => d.name === 'INTERNAL_KEY');
  assert.ok(internal);
  assert.equal(internal.exported, false);

  const helperDef = defs.find((d) => d.name === 'helper');
  assert.ok(helperDef);
  assert.equal(helperDef.exported, false);

  const api = defs.find((d) => d.name === 'publicApi');
  assert.ok(api);
  assert.equal(api.exported, true);

  const widget = defs.find((d) => d.name === 'Widget');
  assert.ok(widget);
  assert.equal(widget.exported, true);
});

// ---------------------------------------------------------------------------
// parseJsTsDefinitions — export { } block cross-reference
// ---------------------------------------------------------------------------

test('export block marks matching definitions as exported', () => {
  const text = [
    'function alpha() {}',
    'function beta() {}',
    'const gamma = 42;',
    '',
    'export { alpha, gamma };',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 3);

  const alpha = defs.find((d) => d.name === 'alpha');
  assert.equal(alpha.exported, true);
  assert.equal(alpha.exportKind, 'named');

  const beta = defs.find((d) => d.name === 'beta');
  assert.equal(beta.exported, false);

  const gamma = defs.find((d) => d.name === 'gamma');
  assert.equal(gamma.exported, true);
  assert.equal(gamma.exportKind, 'named');
});

test('export type { } block marks definitions with type exportKind', () => {
  const text = [
    'type Foo = string;',
    'interface Bar { x: number; }',
    '',
    'export type { Foo, Bar };',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  const foo = defs.find((d) => d.name === 'Foo');
  assert.equal(foo.exported, true);
  assert.equal(foo.exportKind, 'type');

  const bar = defs.find((d) => d.name === 'Bar');
  assert.equal(bar.exported, true);
  assert.equal(bar.exportKind, 'type');
});

test('export block with alias — definition marked exported by local name', () => {
  const text = [
    'function createThing() {}',
    '',
    'export { createThing as makeStuff };',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  // createThing is the definition, exported as makeStuff.
  // Pass 2 finds the definition by localName and marks it exported.
  const def = defs.find((d) => d.name === 'createThing');
  assert.ok(def);
  assert.equal(def.exported, true);
  assert.equal(def.definitionKind, 'function');
});

test('export block with alias — alias creates entry when no local definition matches', () => {
  // When the local name doesn't match any definition (e.g. it was imported then re-exported)
  const text = 'export { unknown as aliased };';
  const defs = parseJsTsDefinitions(text, FP);
  // No local definition for 'unknown', so parser adds 'aliased' as export-only
  const entry = defs.find((d) => d.name === 'aliased');
  assert.ok(entry);
  assert.equal(entry.exported, true);
});

// ---------------------------------------------------------------------------
// parseJsTsDefinitions — brace depth: skip nested definitions
// ---------------------------------------------------------------------------

test('skips definitions inside function bodies', () => {
  const text = [
    'function outer() {',
    '  const inner = 5;',
    '  function nested() {}',
    '}',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'outer');
});

test('skips definitions inside class bodies', () => {
  const text = [
    'class Foo {',
    '  const bar = 10;',
    '}',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'Foo');
});

test('handles multi-line arrow function correctly', () => {
  const text = [
    'const handler = () => {',
    '  const temp = 1;',
    '  return temp;',
    '};',
    '',
    'function topLevel() {}',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 2);
  assert.equal(defs[0].name, 'handler');
  assert.equal(defs[1].name, 'topLevel');
});

// ---------------------------------------------------------------------------
// parseJsTsDefinitions — re-exports are NOT local definitions
// ---------------------------------------------------------------------------

test('re-export blocks do not create local definitions', () => {
  const text = [
    'export { Widget } from "./widget";',
    'export { utils } from "../lib";',
    '',
    'function localFunc() {}',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'localFunc');
});

// ---------------------------------------------------------------------------
// parseJsTsDefinitions — block comments and strings
// ---------------------------------------------------------------------------

test('ignores definitions inside block comments', () => {
  const text = [
    '/* function commented() {} */',
    'function real() {}',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'real');
});

test('handles braces inside strings without corrupting depth', () => {
  const text = [
    'const template = "{ not a brace }";',
    'function afterString() {}',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 2);
  assert.equal(defs[0].name, 'template');
  assert.equal(defs[1].name, 'afterString');
});

// ---------------------------------------------------------------------------
// parseJsTsDefinitions — symbolId and line numbers
// ---------------------------------------------------------------------------

test('symbolId format is filePath::name', () => {
  const defs = parseJsTsDefinitions('function foo() {}', FP);
  assert.equal(defs[0].symbolId, `${FP}::foo`);
});

test('line numbers are 1-indexed', () => {
  const text = [
    '',
    '',
    'function onLineThree() {}',
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs[0].line, 3);
});

// ---------------------------------------------------------------------------
// parseJsTsDefinitions — deduplication
// ---------------------------------------------------------------------------

test('deduplicates by symbolId (keeps first occurrence)', () => {
  const text = [
    'function dup() {}',
    'const dup = 5;', // same name at top level — unusual but possible in broken code
  ].join('\n');
  const defs = parseJsTsDefinitions(text, FP);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].definitionKind, 'function'); // first wins
});

// ---------------------------------------------------------------------------
// parseJsTsExports — backward compatibility
// ---------------------------------------------------------------------------

test('parseJsTsExports returns only exported symbols in legacy shape', () => {
  const text = [
    'function helper() {}',
    'export function doWork() {}',
    'export const VALUE = 42;',
  ].join('\n');
  const symbols = parseJsTsExports(text, FP);
  assert.equal(symbols.length, 2);

  // Should have legacy shape: no definitionKind, no exported field
  for (const sym of symbols) {
    assert.ok(sym.symbolId);
    assert.ok(sym.name);
    assert.ok(sym.exportKind);
    assert.equal(sym.language, 'typescript');
    assert.ok(sym.line);
    assert.ok(sym.meta !== undefined);
    assert.equal(sym.definitionKind, undefined);
    assert.equal(sym.exported, undefined);
  }
});

test('parseJsTsExports handles export default (bare)', () => {
  const text = 'export default 42;';
  const symbols = parseJsTsExports(text, FP);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, 'default');
  assert.equal(symbols[0].exportKind, 'default');
});

test('parseJsTsExports handles export { } block', () => {
  const text = [
    'function a() {}',
    'function b() {}',
    'export { a, b };',
  ].join('\n');
  const symbols = parseJsTsExports(text, FP);
  assert.equal(symbols.length, 2);
  const names = symbols.map((s) => s.name).sort();
  assert.deepEqual(names, ['a', 'b']);
});

test('parseJsTsExports skips re-exports', () => {
  const text = [
    'export { Widget } from "./widget";',
    'export function local() {}',
  ].join('\n');
  const symbols = parseJsTsExports(text, FP);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, 'local');
});

test('parseJsTsExports matches old behavior: export async function', () => {
  const text = 'export async function fetchAll() {}';
  const symbols = parseJsTsExports(text, FP);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, 'fetchAll');
  assert.equal(symbols[0].exportKind, 'named');
});

test('parseJsTsExports matches old behavior: export class', () => {
  const text = 'export class Service {}';
  const symbols = parseJsTsExports(text, FP);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, 'Service');
  assert.equal(symbols[0].exportKind, 'named');
});

test('parseJsTsExports matches old behavior: export type', () => {
  const text = 'export type Config = { x: number };';
  const symbols = parseJsTsExports(text, FP);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, 'Config');
  assert.equal(symbols[0].exportKind, 'type');
});

test('parseJsTsExports matches old behavior: export interface', () => {
  const text = 'export interface Handler { run(): void; }';
  const symbols = parseJsTsExports(text, FP);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, 'Handler');
  assert.equal(symbols[0].exportKind, 'named');
});

test('parseJsTsExports matches old behavior: multi-line export block', () => {
  const text = [
    'export {',
    '  alpha,',
    '  beta,',
    '  gamma',
    '};',
  ].join('\n');
  const symbols = parseJsTsExports(text, FP);
  assert.equal(symbols.length, 3);
  const names = symbols.map((s) => s.name).sort();
  assert.deepEqual(names, ['alpha', 'beta', 'gamma']);
});

test('parseJsTsExports includes export block entries for definitions exported via block', () => {
  const text = [
    'function foo() {}',
    'const bar = 1;',
    'export { foo, bar };',
  ].join('\n');
  const symbols = parseJsTsExports(text, FP);
  assert.equal(symbols.length, 2);
  const names = symbols.map((s) => s.name).sort();
  assert.deepEqual(names, ['bar', 'foo']);
});
