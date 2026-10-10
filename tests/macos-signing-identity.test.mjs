import { expect, test } from 'vitest';
import { electronBuilderCSCName } from '../scripts/macos-signing-identity.mjs';

test('electron-builder receives a Developer ID Application name without its certificate-type prefix', () => {
  expect(electronBuilderCSCName('Developer ID Application: Senqisi (Wuhan) Technology Co., Ltd. (T6NSNA8LDZ)'))
    .toBe('Senqisi (Wuhan) Technology Co., Ltd. (T6NSNA8LDZ)');
});
