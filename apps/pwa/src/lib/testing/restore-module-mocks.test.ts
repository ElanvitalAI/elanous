import { expect, test } from 'bun:test';
import { restoreModuleMocksAfterAll } from './restore-module-mocks';

test('rejects relative specifiers — the restoring mock.module would resolve them against the helper', async () => {
  await expect(restoreModuleMocksAfterAll(['./XtermView'], async () => ({}))).rejects.toThrow('use an alias');
});
