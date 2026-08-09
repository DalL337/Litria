import test from 'node:test';
import assert from 'node:assert/strict';

import { getPieceDisplayName } from '../../src/utils/pieceDisplay.js';

test('getPieceDisplayName prefers trimmed label', () => {
  assert.equal(
    getPieceDisplayName({ label: '  Button.jsx  ', filename: 'Group-1/Button.jsx' }),
    'Button.jsx'
  );
});

test('getPieceDisplayName falls back to filename basename', () => {
  assert.equal(
    getPieceDisplayName({ filename: 'Group-1/components/Button.jsx' }),
    'Button.jsx'
  );
});
