import { expect, test } from 'bun:test';
import { continueHereLines, type ContinueHereOptions } from './continue-here.js';

const ready: ContinueHereOptions = {
  daemonRunning: true,
  pwaUrl: 'http://127.0.0.1:31415/app/',
  phoneLink: 'elanous://connect?host=mbp.example.ts.net&port=31415&tls=1&token=a%2Bb%2Fc%3D',
  telegramEnabled: true,
  interactive: true,
};

test('running daemon shows its browser and issued phone link, plus Telegram when enabled', () => {
  expect(continueHereLines(ready)).toEqual([
    '  Continue here:',
    `  Browser: ${ready.pwaUrl}`,
    `  Phone: ${ready.phoneLink}`,
    '  ⚠ This link contains a connection token — do not share it or include it in a public screenshot.',
    '  Telegram: `elanous telegram`',
  ]);
});

test('absent daemon offers start and connection commands instead of stale links', () => {
  const lines = continueHereLines({ ...ready, daemonRunning: false, telegramEnabled: false });
  expect(lines).toEqual([
    '  Continue here:',
    '  Start the daemon: `elanous nexus run`',
    '  Browser: `elanous nexus show`',
    '  Phone: `elanous phone link --temp --ttl 24h`',
  ]);
});

test('running daemon without a phone link uses the phone command; Telegram is optional', () => {
  const lines = continueHereLines({ ...ready, phoneLink: undefined, telegramEnabled: false });
  expect(lines).toContain(`  Browser: ${ready.pwaUrl}`);
  expect(lines).toContain('  Phone: `elanous phone link --temp --ttl 24h`');
  expect(lines.join('\n')).not.toContain('Telegram:');
  expect(continueHereLines({ ...ready, pwaUrl: undefined })).toContain('  Browser: `elanous nexus show`');
});

test('non-interactive output contains only browser/phone commands, never URLs or QR payloads', () => {
  const lines = continueHereLines({ ...ready, interactive: false });
  expect(lines).toEqual([
    '  Continue here:',
    '  Browser: `elanous nexus show`',
    '  Phone: `elanous phone link --temp --ttl 24h`',
    '  Telegram: `elanous telegram`',
  ]);
  expect(lines.join('\n')).not.toContain(ready.phoneLink!);
  expect(lines.join('\n')).not.toContain(ready.pwaUrl!);
  expect(lines.join('\n')).not.toContain('QR');
});

test('encoded connection token appears only inside the phone link, not in any other output line', () => {
  const link = ready.phoneLink!;
  const token = new URL(link).searchParams.get('token')!;
  const encodedToken = new URL(link).searchParams.toString().split('token=')[1]!;
  const lines = continueHereLines(ready);
  expect(lines.filter(line => line.includes(link))).toEqual([`  Phone: ${link}`]);
  for (const line of lines.filter(line => !line.includes(link))) {
    expect(line).not.toContain(token);
    expect(line).not.toContain(encodedToken);
    expect(line).not.toContain('token=');
  }
  expect(continueHereLines({ ...ready, interactive: false }).join('\n')).not.toContain('token=');
});
