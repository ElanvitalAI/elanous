import { expect, test } from 'bun:test';
import { applyDoctorFixes, applySetupBrewTools, staticToolsNeeded, type DoctorFixDeps } from './doctor-fix.js';

const readiness = { platform: 'linux' as const, distro: 'debian' as const, rgOnPath: false, codexOnPath: false, ghOnPath: false, nodeOnPath: true };

test('installer setup installs and verifies all missing Linux tools, without changing normal doctor selection', () => {
  expect(staticToolsNeeded(readiness)).toEqual(['gh']);
  expect(staticToolsNeeded(readiness, true)).toEqual(['rg', 'codex', 'gh']);
  const calls: string[] = [];
  const deps: DoctorFixDeps = {
    readiness, setupTools: true, arch: 'x64', keyNames: [],
    installStaticTool: (name) => { calls.push(`install ${name}`); return { ok: true, detail: name }; },
    smokeCheck: (name) => { calls.push(`verify ${name}`); return true; },
  };
  const preview = applyDoctorFixes(deps, false, new Set(['static-tools']));
  expect(calls).toEqual([]);
  expect(preview.items.find((item) => item.id === 'static-tools')?.result).toBe('skipped');
  const applied = applyDoctorFixes(deps, true, new Set(['static-tools']));
  expect(applied.exitCode).toBe(0);
  expect(calls).toEqual(['install rg', 'install codex', 'install codex-code-mode-host', 'install gh', 'verify rg', 'verify codex', 'verify codex-code-mode-host', 'verify gh']);
});

test('failed download remains failed and a later retry can succeed', () => {
  let fail = true;
  const deps: DoctorFixDeps = {
    readiness, setupTools: true, arch: 'x64', keyNames: [],
    installStaticTool: (name) => ({ ok: !fail || name !== 'rg', detail: name }),
    smokeCheck: () => true,
  };
  expect(applyDoctorFixes(deps, true, new Set(['static-tools'])).exitCode).toBe(1);
  fail = false;
  expect(applyDoctorFixes(deps, true, new Set(['static-tools'])).exitCode).toBe(0);
});

test('macOS installs only missing tools and verifies each, reporting failures', () => {
  const calls: string[] = [];
  const result = applySetupBrewTools({ platform: 'darwin', ghOnPath: false, rgOnPath: true, codexOnPath: false }, (command, args) => {
    calls.push([command, ...args].join(' '));
    return { status: command === 'codex' ? 1 : 0 };
  });
  expect(calls).toEqual(['brew install gh', 'gh --version', 'brew install --cask codex', 'codex --version']);
  expect(result.failed).toEqual(['codex']);
});
