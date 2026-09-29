import { describe, expect, test } from 'bun:test';
import { installMissingTool, smokeCheck, SMOKE_CHECKS, waitForPtyCompletion, type ToolInstallDeps } from './tool-install.js';
import { remediesFor, toolInstallLine } from '../cli/doctor-distro.js';

const noSideEffects = {
  decision: () => {},
  log: () => {},
};

test('waits for a completed command with its exit code, independent of the ❯ prompt', async () => {
  const marker = 'ELANOUS_INSTALL_abc_END_';
  let polls = 0;
  const completed = await waitForPtyCompletion('pty-shell', { timeoutMs: 3_000, completionMarker: marker }, (ref) => {
    expect(ref).toBe('pty-shell');
    return ++polls === 1 ? `running\n❯` : `done\n${marker}0\n❯`;
  });
  expect(polls).toBe(2);
  expect(completed).toContain(`${marker}0`);
});

test('shared remedies preserve unsupported families and missing package lines', () => {
  expect(toolInstallLine('jq', 'darwin')).toBe('brew install jq');
  expect(toolInstallLine('ffmpeg', 'fedora')).toBeUndefined();
  expect(remediesFor('unknown')).toBeUndefined();
  expect(toolInstallLine('jq', 'unknown')).toBeUndefined();
});

describe('smokeCheck', () => {
  test('runs real operations with stdin and a 20s limit; rejects output mismatches and nonzero exits', () => {
    const commands: string[][] = [];
    const opts: unknown[] = [];
    const exec: NonNullable<ToolInstallDeps['exec']> = (cmd, options) => {
      commands.push(cmd);
      opts.push(options);
      return { status: 0, stdout: commands.length === 1 ? '1\n' : 'not the answer' };
    };
    expect(smokeCheck('jq', { exec }).ok).toBe(true);
    expect(commands[0]).toEqual(['jq', '.a']);
    expect(opts[0]).toEqual({ stdin: '{"a":1}', timeoutMs: 20_000 });
    expect(smokeCheck('jq', { exec }).ok).toBe(false);
    expect(smokeCheck('ffmpeg', { exec: () => ({ status: 1 }) }).ok).toBe(false);
    expect(SMOKE_CHECKS.ffmpeg.cmd).toEqual(['ffmpeg', '-hide_banner', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.1', '-f', 'null', '-']);
  });
  test('git init targets a unique temporary directory rather than --version', () => {
    const commands: string[][] = [];
    for (let i = 0; i < 2; i++) expect(smokeCheck('git', { exec: (cmd) => { commands.push(cmd); return { status: 0 }; } }).ok).toBe(true);
    expect(commands[0]?.slice(0, 3)).toEqual(['git', 'init', '-q']);
    expect(commands[0]?.[3]).not.toEqual(commands[1]?.[3]);
    expect(smokeCheck('git').ok).toBe(true);
  });
});

describe('installMissingTool', () => {
  test('smoke passes first: already, no PTY typing or waiting', async () => {
    let typed = 0;
    let waited = 0;
    const result = await installMissingTool({ tool: 'jq', family: 'darwin', ptyRef: 'pty-1' }, {
      ...noSideEffects,
      exec: () => ({ status: 0, stdout: '1\n' }),
      typeLine: () => { typed++; },
      waitIdle: () => { waited++; return '$'; },
    });
    expect(result.outcome).toBe('already');
    expect(typed).toBe(0);
    expect(waited).toBe(0);
  });

  test('darwin jq: types brew line once, waits until idle, verifies real work, then installed', async () => {
    const typed: Array<[string, string]> = [];
    const events: string[] = [];
    const decisions: string[] = [];
    let checks = 0;
    const result = await installMissingTool({ tool: 'jq', family: 'darwin', ptyRef: 'pty-1' }, {
      exec: () => ({ status: checks++ === 0 ? 1 : 0, stdout: '1' }),
      typeLine: (ref, line) => { typed.push([ref, line]); },
      waitIdle: (ref, opts) => { expect(ref).toBe('pty-1'); expect(opts.timeoutMs).toBe(300_000); return `ready\n${opts.completionMarker}0\n❯`; },
      decision: (data) => { decisions.push(data.kind); },
      log: (event) => { events.push(event); },
    });
    expect(result).toMatchObject({ outcome: 'installed', line: 'brew install jq' });
    expect(typed).toHaveLength(1);
    expect(typed[0]?.[0]).toBe('pty-1');
    expect(typed[0]?.[1]).toStartWith('brew install jq; install_rc=$?;');
    expect(checks).toBe(2);
    expect(decisions).toEqual(['ROUTE', 'VERIFY']);
    expect(events).toEqual(['checked', 'typed', 'installed']);
  });

  test('a failed install exit cannot be reported installed even when a later smoke passes', async () => {
    let checks = 0;
    const result = await installMissingTool({ tool: 'jq', family: 'darwin', ptyRef: 'pty-1' }, {
      ...noSideEffects,
      exec: () => ({ status: checks++ === 0 ? 127 : 0, stdout: '1' }),
      typeLine: () => {},
      waitIdle: (_ref, opts) => `${opts.completionMarker}1\n❯`,
    });
    expect(checks).toBe(2);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('install exited 1');
  });

  test('debian jq: sudo-is-human and no typing', async () => {
    let typed = 0;
    const decisions: string[] = [];
    const result = await installMissingTool({ tool: 'jq', family: 'debian', ptyRef: 'pty-1' }, {
      ...noSideEffects, exec: () => ({ status: 1 }), typeLine: () => { typed++; },
      decision: (data) => { decisions.push(data.kind); },
    });
    expect(result).toMatchObject({ outcome: 'escalate', reason: 'sudo-is-human', line: 'sudo apt-get update && sudo apt-get install -y jq' });
    expect(typed).toBe(0);
    expect(decisions).toEqual(['ESCALATE']);
  });

  test('unknown family and unsupported remedy escalate without guessing', async () => {
    for (const family of ['unknown', 'fedora'] as const) {
      const tool = family === 'unknown' ? 'jq' : 'ffmpeg';
      const result = await installMissingTool({ tool, family, ptyRef: 'pty-1' }, {
        ...noSideEffects, exec: () => ({ status: 1 }),
        typeLine: () => { throw Error('must not type'); },
      });
      expect(result).toEqual({ outcome: 'escalate', reason: 'no-remedy' });
    }
  });

  test('post-install probe failure stays unverified rather than reporting a missing executable', async () => {
    let checks = 0;
    const result = await installMissingTool({ tool: 'jq', family: 'darwin', ptyRef: 'pty-1' }, {
      ...noSideEffects,
      exec: () => ++checks === 1 ? { status: 127 } : { status: null, stderr: 'timed out' },
      typeLine: () => {}, waitIdle: (_ref, opts) => `${opts.completionMarker}0\n❯`,
    });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'jq smoke unavailable: timed out' });
  });

  test('failed post-install smoke reports the PTY snapshot last five lines', async () => {
    const decisions: string[] = [];
    const result = await installMissingTool({ tool: 'jq', family: 'darwin', ptyRef: 'pty-1' }, {
      exec: () => ({ status: 1 }),
      typeLine: () => {}, waitIdle: (_ref, opts) => `old\none\ntwo\nthree\nfour\nfive\n${opts.completionMarker}0`,
      decision: (data) => { decisions.push(data.kind); }, log: () => {},
    });
    expect(result.outcome).toBe('failed');
    expect(result.line).toBe('brew install jq');
    expect(result.reason).toContain('two | three | four | five');
    expect(decisions).toEqual(['ROUTE', 'VERIFY']);
  });

  test('default probes both before and after installation in the PTY despite a different agent PATH', async () => {
    const oldPath = process.env.PATH;
    const lines: string[] = [];
    let installed = false;
    try {
      process.env.PATH = '/agent/without/jq';
      const result = await installMissingTool({ tool: 'jq', family: 'darwin', ptyRef: 'pty-shell' }, {
        typeLine: (ref, line) => {
          expect(ref).toBe('pty-shell');
          lines.push(line);
          if (line.startsWith('brew install jq; install_rc=$?;')) installed = true;
        },
        waitIdle: (_ref, opts) => {
          if (opts.timeoutMs === 300_000) return `brew done\n${opts.completionMarker}0\n❯`;
          const line = lines.at(-1)!;
          const marker = /ELANOUS_SMOKE_[a-f0-9]+/.exec(line)?.[0];
          expect(marker).toBeDefined();
          return `${marker}_START\n${installed ? '1' : 'jq: command not found'}\n${marker}_END_${installed ? 0 : 127}\n$`;
        },
        ...noSideEffects,
      });
      expect(result.outcome).toBe('installed');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain("'jq' '.a'");
      expect(lines[0]).toContain("printf %s '{\"a\":1}' | ");
      expect(lines[1]).toStartWith('brew install jq; install_rc=$?;');
      expect(lines[2]).toContain("'jq' '.a'");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  test('PTY smoke ignores echoed command and rejects missing exit marker', async () => {
    const lines: string[] = [];
    const result = await installMissingTool({ tool: 'jq', family: 'debian', ptyRef: 'pty-shell' }, {
      typeLine: (_ref, line) => { lines.push(line); },
      waitIdle: () => `echo ${lines[0]}\n$`,
      ...noSideEffects,
    });
    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('missing exit marker');
    expect(lines).toHaveLength(1);
  });

  test('default PTY probe does not mistake the host executable for the PTY executable', async () => {
    const result = await installMissingTool({ tool: 'jq', family: 'debian', ptyRef: 'pty-shell' }, {
      typeLine: () => {},
      waitIdle: (_ref, opts) => {
        expect(opts.timeoutMs).toBe(20_000);
        return 'ELANOUS_SMOKE_missing_START\njq: command not found\n$';
      },
      ...noSideEffects,
    });
    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('missing exit marker');
  });

  test('PTY distro determines remedy even when the agent host has a different distro', async () => {
    const typed: string[] = [];
    const result = await installMissingTool({ tool: 'jq', ptyRef: 'remote' }, {
      ...noSideEffects,
      typeLine: (_ref, line) => { typed.push(line); },
      waitIdle: (_ref, opts) => {
        if (opts.timeoutMs === 300_000) return '$';
        const marker = /ELANOUS_SMOKE_[a-f0-9]+/.exec(typed.at(-1)!)?.[0];
        return `${marker}_START\n${typed.length === 1 ? 'command not found' : typed.length === 2 ? 'Linux\nID=ubuntu\nVERSION_ID="24.04"' : '1'}\n${marker}_END_${typed.length === 1 ? 127 : 0}\n$`;
      },
    });
    expect(result).toMatchObject({ outcome: 'escalate', reason: 'sudo-is-human', line: 'sudo apt-get update && sudo apt-get install -y jq' });
    expect(typed).toHaveLength(2);
  });

  test('PTY typing failure and timeout cannot trigger an install', async () => {
    for (const failTyping of [true, false]) {
      const typed: string[] = [];
      const result = await installMissingTool({ tool: 'jq', family: 'darwin', ptyRef: 'remote' }, {
        ...noSideEffects,
        typeLine: (_ref, line) => { typed.push(line); if (failTyping) throw Error('write denied'); },
        waitIdle: () => { if (!failTyping) throw Error('PTY idle timeout'); return '$'; },
      });
      expect(result.outcome).toBe('failed');
      expect(typed).toHaveLength(1);
    }
  });

  test('codex help passing requires login to verify actual work later', async () => {
    const result = await installMissingTool({ tool: 'codex', family: 'unknown', ptyRef: 'pty-1' }, {
      ...noSideEffects, exec: (cmd) => cmd[1] === '--help' ? { status: 0 } : { status: 1, stdout: 'Not logged in' },
    });
    expect(result).toMatchObject({ outcome: 'escalate', needsLogin: true });
    const authenticated = await installMissingTool({ tool: 'codex', family: 'unknown', ptyRef: 'pty-1' }, {
      ...noSideEffects, exec: (cmd) => cmd[1] === '--help' ? { status: 0 } : { status: 0, stdout: 'Logged in using ChatGPT' },
    });
    expect(authenticated).toMatchObject({ outcome: 'already' });
    expect(authenticated.needsLogin).toBeUndefined();
  });
});

test('distro probe typed into the PTY avoids `case …)` inside $( ) — bash 3.2 (macOS /bin/sh) reads that ) as the end', async () => {
  const typed: string[] = [];
  let waits = 0;
  await installMissingTool({ tool: 'jq', ptyRef: 'shell_00000000' }, {
    typeLine: (_ref, line) => { typed.push(line); },
    // 1st wait = the smoke probe: jq is missing (exit 127). 2nd wait = the distro probe: stop there.
    waitIdle: async (_ref, opts) => {
      waits += 1;
      if (waits > 1) throw new Error('stop after the distro probe is typed');
      const marker = opts.completionMarker!.replace(/_END_$/, '');
      return `\n${marker}_START\njq: not found\n\n${marker}_END_127\n`;
    },
    decision: () => {},
    log: () => {},
  });
  const probe = typed.find((line) => line.includes('uname -s'));
  expect(probe).toBeDefined();
  expect(probe).not.toMatch(/case\s+"\$row"/);
  expect(probe).toContain("grep -E '^(ID|ID_LIKE|VERSION_ID)='");
});
