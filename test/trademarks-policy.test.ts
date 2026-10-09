import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const policy = readFileSync(join(root, 'TRADEMARKS.md'), 'utf8');
const license = readFileSync(join(root, 'LICENSE'), 'utf8');
const exportManifest = readFileSync(join(root, 'release/public-export.yaml'), 'utf8');

test('public export ships the trademark policy alongside the existing license and notices', () => {
  const included = exportManifest.split(/^exclude:/m)[0];
  for (const file of ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'THIRD_PARTY_NOTICES.md']) {
    expect(included).toMatch(new RegExp(`^  - ${file.replace('.', '\\.')}\\s*$`, 'm'));
  }
});

test('independently distributed forks change both product identity and logo without losing attribution', () => {
  expect(policy).toMatch(/forks[\s\S]*change its public-facing product name and logo\/icon to distinct ones/i);
  expect(policy).toMatch(/Do not distribute a fork as “Elanous,”[\s\S]*Elanous logo/);
  expect(policy).toMatch(/Keep the copyright, attribution and other notices required by \[LICENSE\]/);
});

test('Powered by Elanous is limited to truthful, non-official origin attribution', () => {
  expect(policy).toMatch(/“Powered by Elanous”[\s\S]*genuinely built on or incorporating Elanous code/);
  expect(policy).toMatch(/independently maintained and is not endorsed by Elanvital AI/);
  expect(policy).toMatch(/Do not use the phrase as the fork's name, logo, primary badge/);
  expect(policy).toMatch(/If the code relationship is no longer accurate, stop using the statement/);
});

test('Apache code rights and trademark permissions stay separate; filing sequence remains conditional', () => {
  expect(license).toMatch(/6\.  Trademarks\. This License does not grant permission/);
  expect(policy).toMatch(/Section 6 does \*\*not\*\* grant a general trademark license/);
  expect(policy).toMatch(/neither changes nor revokes rights in code under LICENSE/);
  expect(policy).toMatch(/ELA-23 → ELA-52 is only a \*conditional order for considering filings\*/);
  expect(policy).toMatch(/do not establish that either application was filed, accepted, registered or granted/);
});
