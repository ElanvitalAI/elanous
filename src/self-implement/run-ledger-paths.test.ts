import { expect, test } from 'bun:test';
import { parseNamespacedRunId } from './run-ledger-paths.js';

test('parses the release graph run namespace without accepting path-like ids', () => {
  expect(parseNamespacedRunId('release-loop/334FCC6A-DC0C-4DBE-84C7-2B6A37C6B240')).toEqual({
    namespace: 'release-loop', uuid: '334fcc6a-dc0c-4dbe-84c7-2b6a37c6b240',
  });
  for (const invalid of ['unknown/334fcc6a-dc0c-4dbe-84c7-2b6a37c6b240', '../334fcc6a-dc0c-4dbe-84c7-2b6a37c6b240',
    'release-loop/../../etc/passwd', 'release-loop/not-a-uuid', 'release-loop/a/b',
    'release-loop/334fcc6a-dc0c-4dbe-84c7-2b6a37c6b240\n',
    'release-loop/334fcc6a-dc0c-4dbe-84c7-2b6a37c6b240\r\n']) {
    expect(parseNamespacedRunId(invalid)).toBeNull();
  }
});
