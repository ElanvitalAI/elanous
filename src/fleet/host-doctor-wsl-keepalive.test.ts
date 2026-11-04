import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { HOST_DOCTOR_CHECKS, parseWslKeepaliveObservation } from './host-doctor.js';

function probeOf(id: string): string {
  const spec = HOST_DOCTOR_CHECKS.find((check) => check.id === id);
  if (!spec) throw new Error(`unknown check ${id}`);
  return spec.probe;
}

/** Use an explicitly configured or installed PowerShell; never download one in a test. */
function installedPowerShellForTest(): string | undefined {
  for (const executable of [process.env.ELANOUS_TEST_PWSH_PATH, 'pwsh', 'powershell.exe']) {
    if (!executable) continue;
    const available = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 5_000 });
    if (available.status === 0) return executable;
  }
  return undefined;
}


describe('WSL keepalive emitted PowerShell', () => {
  test('executes the emitted encoded probe through a mocked PowerShell command', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'wsl-keepalive-probe-'));
    try {
      const bin = join(root, 'bin');
      const capture = join(root, 'powershell-script.txt');
      mkdirSync(bin, { recursive: true });
      const powershell = join(bin, 'powershell.exe');
      writeFileSync(powershell, [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const args = process.argv.slice(2);',
        "const at = args.indexOf('-EncodedCommand');",
        "if (args[0] !== '-NoProfile' || args[1] !== '-NonInteractive' || at !== 2 || !args[at + 1]) process.exit(9);",
        "fs.writeFileSync(process.env.POWERSHELL_CAPTURE_PATH, Buffer.from(args[at + 1], 'base64').toString('utf16le'));",
        "process.stdout.write(process.env.MOCK_POWERSHELL_OUTPUT || '');",
      ].join('\n'));
      chmodSync(powershell, 0o755);
      const cases = [
        ['elangram-wsl', 'ElangramWslKeepalive'],
        ['host-e-wsl', 'ElanainucWslKeepalive'],
      ] as const;
      for (const [distro, task] of cases) {
        const mockOutput = [
          'task', task, 'Ready', 'MSFT_TaskLogonTrigger', 'True',
          'S-1-5-21-1000', 'S-1-5-21-1000', 'S-1-5-21-1000',
          'InteractiveToken', 'False', '00:10:00', 'False', 'False',
          'PT0S', 'PT0S', '1', 'wsl.exe', '-d ' + distro + ' --exec /usr/bin/sleep infinity',
        ].join('|');
        const run = spawnSync('bash', ['-c', probeOf('wsl.keepalive-logon-task')], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: bin + delimiter + (process.env.PATH ?? ''),
            WSL_DISTRO_NAME: distro,
            MOCK_POWERSHELL_OUTPUT: mockOutput,
            POWERSHELL_CAPTURE_PATH: capture,
          },
        });
        expect(run.status).toBe(0);
        expect(parseWslKeepaliveObservation(run.stdout).status).toBe('pass');
        const emittedScript = readFileSync(capture, 'utf8');
        expect(emittedScript).toContain('$name="' + task + '"');
        expect(emittedScript).toContain('Get-ScheduledTask -TaskName $name');
        expect(emittedScript).toContain('elseif($_ -is [bool]){$_.ToString()}');
        expect(emittedScript).toContain('if($null -eq $trigger[0].ExecutionTimeLimit){"<not-set>"}');
        expect(emittedScript).not.toContain('TASKNAME');
        expect(emittedScript).not.toContain('wsl.exe --shutdown');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});

const serializerPowerShell = installedPowerShellForTest();
test.skipIf(!serializerPowerShell)('PowerShell serializer integration (skipped: pwsh unavailable; mocked probe remains covered)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wsl-keepalive-serializer-'));
  try {
    const bin = join(root, 'bin');
    const capture = join(root, 'powershell-script.txt');
    mkdirSync(bin, { recursive: true });
    const powershell = join(bin, 'powershell.exe');
    writeFileSync(powershell, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "const at = args.indexOf('-EncodedCommand');",
      "if (args[0] !== '-NoProfile' || args[1] !== '-NonInteractive' || at !== 2 || !args[at + 1]) process.exit(9);",
      "fs.writeFileSync(process.env.POWERSHELL_CAPTURE_PATH, Buffer.from(args[at + 1], 'base64').toString('utf16le'));",
      "process.stdout.write(process.env.MOCK_POWERSHELL_OUTPUT || '');",
    ].join('\n'));
    chmodSync(powershell, 0o755);
    const mockOutput = [
      'task', 'ElangramWslKeepalive', 'Ready', 'MSFT_TaskLogonTrigger', 'True',
      'S-1-5-21-1000', 'S-1-5-21-1000', 'S-1-5-21-1000',
      'InteractiveToken', 'False', '00:10:00', 'False', 'False',
      'PT0S', 'PT0S', '1', 'wsl.exe', '-d elangram-wsl --exec /usr/bin/sleep infinity',
    ].join('|');
    const run = spawnSync('bash', ['-c', probeOf('wsl.keepalive-logon-task')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + delimiter + (process.env.PATH ?? ''),
        WSL_DISTRO_NAME: 'elangram-wsl',
        MOCK_POWERSHELL_OUTPUT: mockOutput,
        POWERSHELL_CAPTURE_PATH: capture,
      },
    });
    expect(run.status).toBe(0);
    const emittedScript = readFileSync(capture, 'utf8');
    const serializer = emittedScript.slice(emittedScript.lastIndexOf('Write-Output ('));
    const limitStart = emittedScript.indexOf('$triggerExecutionTimeLimit=if(');
    const limitEnd = emittedScript.indexOf(';$action=', limitStart);
    expect(limitStart).toBeGreaterThanOrEqual(0);
    expect(limitEnd).toBeGreaterThan(limitStart);
    const limitAssignment = emittedScript.slice(limitStart, limitEnd);
    for (const [limit, expectedStatus] of [['$null', 'pass'], ['"P1D"', 'fail']] as const) {
      const setup = '$trigger=@([pscustomobject]@{ExecutionTimeLimit=' + limit + '});' + limitAssignment + ';';
      const values = '$values=@("task","ElangramWslKeepalive","Ready","MSFT_TaskLogonTrigger",$true,"S-1-5-21-1000","S-1-5-21-1000","S-1-5-21-1000","InteractiveToken",$false,"00:10:00",$false,$false,"PT0S",$triggerExecutionTimeLimit,1,"wsl.exe","-d elangram-wsl --exec /usr/bin/sleep infinity");';
      const actual = spawnSync(serializerPowerShell!, ['-NoProfile', '-NonInteractive', '-Command', setup + values + serializer], { encoding: 'utf8' });
      expect(actual.status).toBe(0);
      expect(actual.stdout.trim()).toContain('|False|');
      expect(parseWslKeepaliveObservation(actual.stdout).status).toBe(expectedStatus);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
