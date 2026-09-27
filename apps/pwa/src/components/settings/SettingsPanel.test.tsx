import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

// The full SettingsPanel has daemon-backed cards; check the chat card's real JSX mount here.
test('settings mounts the automatic-routing card', () => {
  const source = readFileSync(join(import.meta.dir, 'SettingsPanel.tsx'), 'utf8');
  expect(source).toContain("import { ChatRoutingCard } from './ChatRoutingCard'");
  expect(source).toContain('<ChatRoutingCard />');
});
