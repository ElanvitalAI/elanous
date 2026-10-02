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
    '  여기서 이어가세요:',
    `  브라우저: ${ready.pwaUrl}`,
    `  폰: ${ready.phoneLink}`,
    '  ⚠ 이 링크에는 연결 토큰이 들어 있습니다 — 남에게 보내거나 공개 캡처에 넣지 마세요.',
    '  텔레그램: `elanous telegram`',
  ]);
});

test('signed-in Tailscale offers the share command and app URL interactively', () => {
  expect(continueHereLines({ ...ready, tailscale: { host: 'mbp.tailnet-example.ts.net' } })).toEqual([
    ...continueHereLines(ready),
    '  어디서든(Tailscale): `elanous nexus pwa share enable` → https://mbp.tailnet-example.ts.net/app/',
  ]);
});

test('Tailscale without a MagicDNS name offers the command alone', () => {
  expect(continueHereLines({ ...ready, tailscale: {} })).toEqual([
    ...continueHereLines(ready),
    '  어디서든(Tailscale): `elanous nexus pwa share enable`',
  ]);
});

test('Tailscale is absent: existing output remains byte-identical', () => {
  expect(continueHereLines({ ...ready, tailscale: undefined })).toEqual(continueHereLines(ready));
  expect(continueHereLines(ready).join('\n')).not.toContain('Tailscale');
});

test('non-interactive Tailscale offer contains the command but no address', () => {
  const lines = continueHereLines({ ...ready, interactive: false, tailscale: { host: 'mbp.tailnet-example.ts.net' } });
  expect(lines).toEqual([
    ...continueHereLines({ ...ready, interactive: false }),
    '  어디서든(Tailscale): `elanous nexus pwa share enable`',
  ]);
  expect(lines.join('\n')).not.toContain('https://');
});

test('absent daemon offers start and connection commands instead of stale links', () => {
  const lines = continueHereLines({ ...ready, daemonRunning: false, telegramEnabled: false });
  expect(lines).toEqual([
    '  여기서 이어가세요:',
    '  데몬 켜기: `elanous nexus run`',
    '  브라우저: `elanous nexus show`',
    '  폰: `elanous phone link --temp --ttl 24h`',
  ]);
});

test('running daemon without a phone link uses the phone command; Telegram is optional', () => {
  const lines = continueHereLines({ ...ready, phoneLink: undefined, telegramEnabled: false });
  expect(lines).toContain(`  브라우저: ${ready.pwaUrl}`);
  expect(lines).toContain('  폰: `elanous phone link --temp --ttl 24h`');
  expect(lines.join('\n')).not.toContain('Telegram:');
  expect(continueHereLines({ ...ready, pwaUrl: undefined })).toContain('  브라우저: `elanous nexus show`');
});

test('non-interactive output contains only browser/phone commands, never URLs or QR payloads', () => {
  const lines = continueHereLines({ ...ready, interactive: false });
  expect(lines).toEqual([
    '  여기서 이어가세요:',
    '  브라우저: `elanous nexus show`',
    '  폰: `elanous phone link --temp --ttl 24h`',
    '  텔레그램: `elanous telegram`',
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
  expect(lines.filter(line => line.includes(link))).toEqual([`  폰: ${link}`]);
  for (const line of lines.filter(line => !line.includes(link))) {
    expect(line).not.toContain(token);
    expect(line).not.toContain(encodedToken);
    expect(line).not.toContain('token=');
  }
  expect(continueHereLines({ ...ready, interactive: false }).join('\n')).not.toContain('token=');
});
