import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_MATERIALS,
  resolveMaterialId,
  parametersForMaterial,
  listDeclaredTokens,
  tokenExistsInDefaults
} from '../../src/theme/materialParams.js';

// The contract's whole value is that it cannot drift from the real token set.
test('every declared parameter token exists in the theme token defaults', () => {
  for (const token of listDeclaredTokens()) {
    assert.ok(tokenExistsInDefaults(token), `${token} is not a real theme token`);
  }
});

test('every material yields a well-formed parameter list', () => {
  for (const material of NODE_MATERIALS) {
    const params = parametersForMaterial(material.id);
    assert.ok(params.length > 0, `${material.id} exposes no parameters`);
    for (const param of params) {
      assert.ok(param.label?.length > 0, `${param.token}: label required`);
      if (param.type === 'range') {
        assert.ok(param.min < param.max, `${param.token}: bad range`);
        assert.ok(param.step > 0, `${param.token}: bad step`);
        assert.ok(Number.isInteger(param.decimals), `${param.token}: decimals required`);
      } else if (param.type === 'choice') {
        assert.ok(Array.isArray(param.options) && param.options.length >= 2, `${param.token}: choice needs options`);
      } else {
        assert.fail(`${param.token}: unknown type ${param.type}`);
      }
    }
  }
});

test('glass exposes glass knobs; matte does not (and vice versa)', () => {
  const glassTokens = parametersForMaterial('glass').map((p) => p.token);
  const matteTokens = parametersForMaterial('matte').map((p) => p.token);
  assert.ok(glassTokens.includes('glassBlurRadius'));
  assert.ok(!matteTokens.includes('glassBlurRadius'));
  assert.ok(matteTokens.includes('matteBorderWidth'));
  assert.ok(!glassTokens.includes('matteBorderWidth'));
  // Shared node parameters appear for every material.
  for (const tokens of [glassTokens, matteTokens]) {
    assert.ok(tokens.includes('nodeCornerRadius'));
    assert.ok(tokens.includes('nodeLedStyle'));
  }
});

test('resolveMaterialId mirrors the renderer coercion (unknown -> glass)', () => {
  assert.equal(resolveMaterialId({ nodeMaterial: 'matte' }), 'matte');
  assert.equal(resolveMaterialId({ nodeMaterial: 'glass' }), 'glass');
  assert.equal(resolveMaterialId({ nodeMaterial: 'chrome' }), 'glass');
  assert.equal(resolveMaterialId({}), 'glass');
  assert.equal(resolveMaterialId(null), 'glass');
});

test('an unknown material still gets the shared parameters', () => {
  const params = parametersForMaterial('future-material');
  assert.ok(params.some((p) => p.token === 'nodeCornerRadius'));
});
