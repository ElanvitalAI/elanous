import { describe, expect, test } from 'bun:test';
import { installTelegramService, renderTelegramServiceFile, telegramRunCommand, TELEGRAM_LAUNCHD_LABEL } from './telegram-service.js';
import { updateTelegramRunner } from './cli/self-update.js';

describe('telegram service definition (print only)', () => {
  test('the command runs `telegram run` from the stable installed path, not a version folder', () => {
    const cmd = telegramRunCommand('/usr/bin/bun', '/h/.local/share/elanous/versions/1.0.0-abc/node_modules/elanous/bin/elanous.mjs', () => true);
    expect(cmd).toEqual(['/usr/bin/bun', '/h/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs', 'telegram', 'run']);
  });

  test('darwin renders a launchd plist with its own label beside the nexus one, and names the enable command', () => {
    const f = renderTelegramServiceFile({ platform: 'darwin', home: '/h', logDir: '/h/.elanous/logs', command: ['/usr/bin/bun', '/x/elanous.mjs', 'telegram', 'run'], uid: 501 })!;
    expect(f.path).toBe('/h/Library/LaunchAgents/com.elanous.telegram.plist');
    expect(f.content).toContain(`<string>${TELEGRAM_LAUNCHD_LABEL}</string>`);
    expect(f.content).toContain('<string>telegram</string>');
    expect(f.content).toContain('<string>run</string>');
    expect(f.content).toContain('/h/.elanous/logs/telegram-run.err.log');
    expect(f.enable).toEqual(['launchctl bootstrap gui/501 /h/Library/LaunchAgents/com.elanous.telegram.plist']);
  });

  test('SEC2: the generated com.elanous.telegram plist omits a bot token even when present in the environment', () => {
    const token = '123456789:SEC2-synthetic-secret';
    const previous = process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = token;
    try {
      const command = telegramRunCommand('/usr/bin/bun', '/x/elanous.mjs');
      const file = renderTelegramServiceFile({ platform: 'darwin', home: '/h', logDir: '/h/logs', command, uid: 501 })!;
      expect(command).toEqual(['/usr/bin/bun', '/x/elanous.mjs', 'telegram', 'run']);
      expect(file.content).toContain('<string>com.elanous.telegram</string>');
      expect(file.content).not.toContain('<key>EnvironmentVariables</key>');
      expect(file.content).not.toContain(token);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
      else process.env.ELANOUS_TELEGRAM_BOT_TOKEN = previous;
    }
  });

  test('SEC2: installation writes the token-free plist and bootstraps by file path only', () => {
    const token = '123456789:SEC2-install-synthetic-secret';
    const previous = process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = token;
    try {
      const file = renderTelegramServiceFile({
        platform: 'darwin', home: '/h', logDir: '/h/logs',
        command: telegramRunCommand('/usr/bin/bun', '/x/elanous.mjs'), uid: 501,
      })!;
      const written: Array<{ path: string; body: string }> = [];
      const commands: Array<{ command: string; args: string[] }> = [];
      const result = installTelegramService(file, 'standalone', 501, {
        exists: () => false, readFile: () => '',
        writeFile: (path, body) => { written.push({ path, body }); },
        mkdir: () => {}, rename: () => {}, chmod: () => {},
        run: (command, args) => { commands.push({ command, args }); return { status: 0, stderr: '' }; },
      });
      expect(result.ok).toBe(true);
      expect(written).toEqual([{ path: file.path, body: file.content }]);
      expect(written[0]!.body).not.toContain('<key>EnvironmentVariables</key>');
      expect(written[0]!.body).not.toContain(token);
      expect(commands).toEqual([
        { command: 'launchctl', args: ['bootout', 'gui/501/com.elanous.telegram'] },
        { command: 'launchctl', args: ['bootstrap', 'gui/501', file.path] },
      ]);
      expect(JSON.stringify(commands)).not.toContain(token);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
      else process.env.ELANOUS_TELEGRAM_BOT_TOKEN = previous;
    }
  });

  test('SEC2: replacing an emergency EnvironmentVariables plist removes its token before bootstrap', () => {
    const token = '123456789:SEC2-legacy-synthetic-secret';
    const file = renderTelegramServiceFile({
      platform: 'darwin', home: '/h', logDir: '/h/logs',
      command: telegramRunCommand('/usr/bin/bun', '/x/elanous.mjs'), uid: 501,
    })!;
    const legacy = file.content.replace('</dict>\n</plist>', `  <key>EnvironmentVariables</key>\n  <dict><key>ELANOUS_TELEGRAM_BOT_TOKEN</key><string>${token}</string></dict>\n</dict>\n</plist>`);
    const files = new Map([[file.path, legacy]]);
    const commands: Array<{ command: string; args: string[] }> = [];
    const renamed: Array<{ from: string; to: string }> = [];
    const modes = new Map<string, number>();
    const result = installTelegramService(file, 'standalone', 501, {
      chmod: (path, mode) => { modes.set(path, mode); },
      exists: (path) => files.has(path),
      readFile: (path) => files.get(path)!,
      writeFile: (path, body) => { files.set(path, body); },
      mkdir: () => {},
      rename: (from, to) => { files.set(to, files.get(from)!); files.delete(from); modes.set(to, modes.get(from) ?? 0o644); renamed.push({ from, to }); },
      run: (command, args) => { commands.push({ command, args }); return { status: 0, stderr: '' }; },
    });
    expect(result.ok).toBe(true);
    expect(result.backup).toBeDefined();
    expect(renamed).toEqual([{ from: file.path, to: result.backup! }]);
    expect(files.get(result.backup!)).toBe(legacy);
    // The token-bearing backup is owner-only (0600).
    expect(modes.get(result.backup!)).toBe(0o600);
    expect(files.get(file.path)).toBe(file.content);
    expect(files.get(file.path)).not.toContain('<key>EnvironmentVariables</key>');
    expect(files.get(file.path)).not.toContain(token);
    expect(commands).toEqual([
      { command: 'launchctl', args: ['bootout', 'gui/501/com.elanous.telegram'] },
      { command: 'launchctl', args: ['bootstrap', 'gui/501', file.path] },
    ]);
    expect(JSON.stringify(commands)).not.toContain(token);
  });

  test('SEC2: self-update restarts the telegram runner by service label without putting a token in argv', () => {
    const token = '987654321:SEC2-synthetic-secret';
    const previous = process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = token;
    try {
      const commands: Array<{ command: string; args: string[] }> = [];
      const result = updateTelegramRunner(
        { exitCode: 11, verdict: 'restart', from: 'aaaaaaaaaaaa', to: 'bbbbbbbbbbbb' },
        true,
        { telegramRunnerInstalled: () => true, os: 'darwin', uid: 501 },
        (command, args) => { commands.push({ command, args }); return { status: 0, stderr: '' }; },
        '/checkout',
      );
      expect(result.verdict).toBe('restarted');
      expect(commands).toEqual([{ command: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.elanous.telegram'] }]);
      expect(JSON.stringify(commands)).not.toContain(token);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
      else process.env.ELANOUS_TELEGRAM_BOT_TOKEN = previous;
    }
  });

  test('linux renders a user systemd unit', () => {
    const f = renderTelegramServiceFile({ platform: 'linux', home: '/h', command: ['/usr/bin/bun', '/x/elanous.mjs', 'telegram', 'run'] })!;
    expect(f.path).toBe('/h/.config/systemd/user/elanous-telegram.service');
    expect(f.content).toContain('ExecStart=/usr/bin/bun /x/elanous.mjs telegram run');
    expect(f.enable.at(-1)).toBe('systemctl --user enable --now elanous-telegram.service');
  });

  test('other platforms have no definition', () => {
    expect(renderTelegramServiceFile({ platform: 'win32', home: 'C:/h', command: ['x'] })).toBeNull();
  });
});

test('SEC2: real filesystem — the token-bearing backup ends up 0600 and the new plist has no token', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync, renameSync, chmodSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'sec2-'));
  try {
    const token = '123456789:SEC2-fs-synthetic-secret';
    const file = renderTelegramServiceFile({ platform: 'darwin', home, logDir: join(home, 'logs'), command: telegramRunCommand('/usr/bin/bun', '/x/elanous.mjs'), uid: 501 })!;
    mkdirSync(join(file.path, '..'), { recursive: true });
    writeFileSync(file.path, file.content.replace('</dict>\n</plist>', `  <key>EnvironmentVariables</key>\n  <dict><key>ELANOUS_TELEGRAM_BOT_TOKEN</key><string>${token}</string></dict>\n</dict>\n</plist>`), { mode: 0o644 });
    const result = installTelegramService(file, 'standalone', 501, {
      exists: existsSync, readFile: (p) => readFileSync(p, 'utf8'), writeFile: (p, t) => writeFileSync(p, t),
      mkdir: (p) => mkdirSync(p, { recursive: true }), rename: renameSync, chmod: chmodSync,
      run: () => ({ status: 0, stderr: '' }),
    });
    expect(result.ok).toBe(true);
    expect(statSync(result.backup!).mode & 0o777).toBe(0o600);
    expect(readFileSync(file.path, 'utf8')).not.toContain(token);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('SEC2: if restricting the old plist fails, nothing is moved and the live plist stays', () => {
  const file = renderTelegramServiceFile({ platform: 'darwin', home: '/h', logDir: '/h/logs', command: telegramRunCommand('/usr/bin/bun', '/x/elanous.mjs'), uid: 501 })!;
  const files = new Map([[file.path, 'legacy plist']]);
  const commands: string[] = [];
  expect(() => installTelegramService(file, 'standalone', 501, {
    exists: (path) => files.has(path), readFile: (path) => files.get(path)!,
    writeFile: (path, body) => { files.set(path, body); }, mkdir: () => {},
    rename: (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
    chmod: () => { throw new Error('EPERM'); },
    run: (command) => { commands.push(command); return { status: 0, stderr: '' }; },
  })).toThrow('EPERM');
  expect([...files.keys()]).toEqual([file.path]);
  expect(files.get(file.path)).toBe('legacy plist');
  expect(commands).toEqual([]);
});
