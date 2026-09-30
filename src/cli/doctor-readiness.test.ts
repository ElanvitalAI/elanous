import { describe, expect, test } from 'bun:test';
import {
  checkReadiness,
  detectSubstrate,
  MEMORY_AVAILABLE_FLOOR_BYTES,
  parseDockerInfo,
  parseKubectlServerVersion,
  parseMeminfo,
  parseVmStatAvailableBytes,
  type ReadinessDeps,
  type ReadinessItem,
  type SubstrateSignals,
  servicePathRefs,
} from './doctor-readiness.js';

const CODE = 'abc123def4567890abc123def4567890abc123de';
const SAME_SHA = 'abc123def';
const OTHER_SHA = 'fffffffffff';

function byId(deps: ReadinessDeps, id: string): ReadinessItem {
  const item = checkReadiness(deps).items.find((entry) => entry.id === id);
  if (!item) throw new Error(`missing readiness item ${id}`);
  return item;
}

const healthy: ReadinessDeps = {
  provider: 'openai-codex',
  usableLlm: { usable: true, provider: 'openai-codex', via: 'login', why: 'login' },
  ghOnPath: true,
  ghAuthStatus: 0,
  pathEntries: ['/usr/bin'],
  health: { daemonSha: SAME_SHA },
  codeRevision: CODE,
  platform: 'darwin',
};

describe('checkReadiness', () => {
  // 2026-09-24 결정(#20142) 뒤 계약: auto + codex 로그인은 «정상»이다.
  test('provider auto with a codex login is ok — codex first, rotation and fallback chain apply', () => {
    const item = byId({ ...healthy, provider: 'auto', usableLlm: { usable: true, provider: 'openai-codex', via: 'login', why: 'login' } }, 'provider-decision');
    expect(item.status).toBe('ok');
    expect(item.evidence).toContain('login openai-codex');
    expect(item.remedy).toBeUndefined();
  });

  test('an unknown provider value is not echoed into the report', () => {
    const item = byId({ ...healthy, provider: 'grok-AKIAIOSFODNN7EXAMPLE' }, 'provider-decision');
    expect(item.evidence).not.toContain('AKIA');
    expect(item.evidence).toContain('value not shown');
  });

  test('an explicit provider with a measured login is ok', () => {
    const item = byId({ ...healthy, provider: 'grok' }, 'provider-decision');
    expect(item.status).toBe('ok');
    expect(item.remedy).toBeUndefined();
  });

  test('an explicit provider without a measured route stays unknown even if its name is configured', () => {
    for (const usableLlm of [undefined, null]) {
      const item = byId({ provider: 'grok', usableLlm }, 'provider-decision');
      expect(item).toEqual({ id: 'provider-decision', status: 'unknown', evidence: 'llm.provider=grok route was not measured' });
    }
  });

  test('an unavailable explicit openai or local route names a remedy for that selected provider', () => {
    const unavailable = { usable: false, via: 'none' as const, why: 'no usable LLM route selected' };
    expect(byId({ provider: 'openai', usableLlm: unavailable }, 'provider-decision'))
      .toMatchObject({ status: 'manual', remedy: 'Set OPENAI_API_KEY or llm.apiKey for openai' });
    expect(byId({ provider: 'local', usableLlm: unavailable }, 'provider-decision'))
      .toMatchObject({ status: 'manual', remedy: 'Set llm.baseUrl or LOCAL_LLM_URL for local' });
    expect(byId({ provider: 'openai-codex', usableLlm: unavailable }, 'provider-decision').remedy)
      .toBe('elanous login openai-codex');
  });

  test('an unavailable route consumes only the allowlisted reason, never a credential', () => {
    const secret = 'sk-live-should-never-appear';
    const missing = byId({ provider: 'auto', usableLlm: { usable: false, via: 'none', why: 'no usable LLM route selected' } }, 'provider-decision');
    expect(missing.evidence).toContain('no usable LLM route selected');
    const unsafe = byId({ provider: 'auto', usableLlm: { usable: false, via: 'none', why: secret } }, 'provider-decision');
    expect(unsafe.evidence).toContain('route unavailable');
    expect(JSON.stringify(unsafe)).not.toContain(secret);
  });

  test('provider auto reports the selected key route; an unmeasured route stays unknown', () => {
    const key = byId({ ...healthy, provider: 'auto', usableLlm: { usable: true, provider: 'openai', via: 'key', why: 'key' } }, 'provider-decision');
    expect(key.status).toBe('ok');
    expect(key.evidence).toContain('key openai');
    const unmeasured = byId({ ...healthy, provider: 'auto', usableLlm: null }, 'provider-decision');
    expect(unmeasured.status).toBe('unknown');
    expect(unmeasured.evidence).toContain('not measured');
  });

  test('an omitted provider is unmeasured, while an empty provider is the auto default', () => {
    const omitted = byId({ ...healthy, provider: undefined }, 'provider-decision');
    expect(omitted.status).toBe('unknown');
    expect(omitted.evidence).not.toContain('no codex login');
    const empty = byId({ ...healthy, provider: '  ' }, 'provider-decision');
    expect(empty.status).toBe('ok');
  });

  test('gh present and gh auth status 1 is manual with gh auth login', () => {
    const item = byId({ ...healthy, ghOnPath: true, ghAuthStatus: 1 }, 'gh-auth');
    expect(item.status).toBe('manual');
    expect(item.remedy).toBe('gh auth login');
  });

  test('gh auth status 0 is ok', () => {
    const item = byId({ ...healthy, ghOnPath: true, ghAuthStatus: 0 }, 'gh-auth');
    expect(item.status).toBe('ok');
    expect(item.remedy).toBeUndefined();
  });

  test('gh missing is manual and names the install command for the measured platform', () => {
    const linux = byId({ ...healthy, ghOnPath: false, ghAuthStatus: 1, platform: 'linux' }, 'gh-auth');
    expect(linux.status).toBe('manual');
    expect(linux.remedy).toBe('elanous doctor --fix --yes');   // apt gh 는 2.80 미만(Debian 12 2.23 · Ubuntu 24.04 2.45)
    const darwin = byId({ ...healthy, ghOnPath: false, ghAuthStatus: 1, platform: 'darwin' }, 'gh-auth');
    expect(darwin.status).toBe('manual');
    expect(darwin.remedy).toBe('brew install gh');
    const windows = byId({ ...healthy, ghOnPath: false, ghAuthStatus: 1, platform: 'win32' }, 'gh-auth');
    expect(windows.remedy).toBe('winget install --id GitHub.cli -e');
    const unmeasured = byId({ ...healthy, ghOnPath: false, ghAuthStatus: 1, platform: undefined }, 'gh-auth');
    expect(unmeasured.status).toBe('manual');
    expect(unmeasured.remedy).toBeUndefined();
    const unsupported = byId({ ...healthy, ghOnPath: false, ghAuthStatus: 1, platform: 'aix' }, 'gh-auth');
    expect(unsupported.remedy).toBeUndefined();
  });

  test('missing harness tools on Debian name rg, install node first, then codex', () => {
    const tool = byId({ ...healthy, distro: 'debian', rgOnPath: false, codexOnPath: false, nodeOnPath: false }, 'harness-tools');
    expect(tool.status).toBe('manual');
    expect(tool.evidence).toContain('rg and codex missing');
    expect(tool.remedy).toBe('sudo apt-get update && sudo apt-get install -y ripgrep');
  });

  // 🩸 2026-09-25 amazonlinux:2: node 를 깔 줄이 없는데 `sudo npm install -g @openai/codex` 만 나가 npm 없음으로 죽었다.
  test('no node install line for the family ⇒ no codex (npm) line either', () => {
    const tool = byId({ ...healthy, distro: 'amzn2', rgOnPath: false, codexOnPath: false, nodeOnPath: false }, 'harness-tools');
    expect(tool.remedy ?? '').not.toContain('npm');
    expect(tool.evidence).toContain('install rg, node manually');
  });

  test('existing readiness items retain identical status, evidence and remedy across harness probes', () => {
    const base: ReadinessDeps = {
      provider: 'auto', usableLlm: { usable: false, via: 'none', why: 'no usable LLM route selected' },
      ghOnPath: false, platform: 'linux', distro: 'debian',
      buildToolchain: { make: false, cxx20: false }, nodePty: 'broken',
      pythonEnv: { status: 'manual', evidence: 'python missing', remedy: 'pyenv install 3.12.12' },
    };
    const without = checkReadiness(base).items.filter((entry) => entry.id !== 'harness-tools');
    const withMissing = checkReadiness({ ...base, rgOnPath: false, codexOnPath: false, nodeOnPath: false }).items.filter((entry) => entry.id !== 'harness-tools');
    const withPresent = checkReadiness({ ...base, rgOnPath: true, codexOnPath: true, nodeOnPath: true }).items.filter((entry) => entry.id !== 'harness-tools');
    expect(withMissing).toEqual(without);
    expect(withPresent).toEqual(without);
  });

  test('installed node needs only codex; unknown distro names missing tools without commands', () => {
    expect(byId({ distro: 'debian', rgOnPath: true, codexOnPath: false, nodeOnPath: true }, 'harness-tools').remedy)
      .toBe('sudo npm install -g @openai/codex');
    const unknown = byId({ distro: 'unknown', rgOnPath: false, codexOnPath: false, nodeOnPath: false }, 'harness-tools');
    expect(unknown).toMatchObject({ status: 'manual' });
    expect(unknown.evidence).toContain('rg and codex');
    expect(unknown.remedy).toBeUndefined();
    expect(byId({ distro: 'unknown', rgOnPath: true, codexOnPath: false, nodeOnPath: true }, 'harness-tools').remedy).toBeUndefined();
    expect(byId({ distro: 'debian', rgOnPath: true, codexOnPath: false, nodeOnPath: false }, 'harness-tools').remedy)
      .toBe('Install Node.js 20+ using the official distribution instructions at https://nodejs.org/en/download');
    expect(byId({ rgOnPath: true, codexOnPath: true, nodeOnPath: true }, 'harness-tools').status).toBe('ok');
    const missingNode = byId({ distro: 'debian', rgOnPath: true, codexOnPath: true, nodeOnPath: false }, 'harness-tools');
    expect(missingNode).toMatchObject({ status: 'manual', remedy: 'Install Node.js 20+ using the official distribution instructions at https://nodejs.org/en/download' });
    expect(missingNode.evidence).toContain('node missing');
    const unknownMissingNode = byId({ distro: 'unknown', rgOnPath: true, codexOnPath: true, nodeOnPath: false }, 'harness-tools');
    expect(unknownMissingNode.status).toBe('manual');
    expect(unknownMissingNode.remedy).toBeUndefined();
    expect(byId({ rgOnPath: true, codexOnPath: true, nodeOnPath: null }, 'harness-tools').status).toBe('unknown');
    expect(byId({ rgOnPath: null, codexOnPath: false }, 'harness-tools').status).toBe('manual');
    expect(byId({ rgOnPath: true, codexOnPath: null }, 'harness-tools').status).toBe('unknown');
    expect(byId({ distro: 'debian', rgOnPath: false, codexOnPath: null }, 'harness-tools'))
      .toMatchObject({ status: 'manual', remedy: 'sudo apt-get update && sudo apt-get install -y ripgrep' });
    const unmeasuredNode = byId({ distro: 'debian', rgOnPath: false, codexOnPath: false, nodeOnPath: null }, 'harness-tools');
    expect(unmeasuredNode).toMatchObject({ status: 'manual', remedy: 'sudo apt-get update && sudo apt-get install -y ripgrep' });
    expect(unmeasuredNode.evidence).toContain('node not measured');
  });

  test('gh present but auth status not runnable is unknown', () => {
    const item = byId({ ...healthy, ghOnPath: true, ghAuthStatus: null }, 'gh-auth');
    expect(item.status).toBe('unknown');
    expect(item.remedy).toBeUndefined();
  });

  test('an install prefix whose bin is off PATH is fixable with the installer PATH line', () => {
    const item = byId({
      ...healthy,
      installPrefix: '/home/user/.local/share/elanous',
      pathEntries: ['/usr/bin', '/home/user/.local/bin'],
    }, 'install-path');
    expect(item.status).toBe('fixable');
    expect(item.remedy).toBe(`export PATH='/home/user/.local/share/elanous/bin':\"$PATH\"`);
  });

  test('the install-path remedy keeps the existing PATH when a shell runs it', () => {
    const prefix = '/opt/elanous';
    const item = byId({
      ...healthy,
      installPrefix: prefix,
      pathEntries: ['/usr/bin'],
    }, 'install-path');
    const script = `PATH=/usr/bin:/usr/local/bin; ${item.remedy}; printf '%s' \"$PATH\"`;
    const ran = Bun.spawnSync({
      cmd: ['bash', '-c', script],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toBe(`${prefix}/bin:/usr/bin:/usr/local/bin`);
  });

  test('a prefix containing spaces is judged on the real path and shell-quoted in the remedy', () => {
    const prefix = '/Users/Ada Lovelace/Library/Application Support/elanous';
    const missing = byId({
      ...healthy,
      installPrefix: prefix,
      pathEntries: ['/usr/bin', `${prefix}/ bin`],
    }, 'install-path');
    expect(missing.status).toBe('fixable');
    expect(missing.evidence).toContain(prefix);
    expect(missing.evidence).not.toContain('[redacted]');
    expect(missing.remedy).toBe(`export PATH='/Users/Ada Lovelace/Library/Application Support/elanous/bin':\"$PATH\"`);
    const present = byId({
      ...healthy,
      installPrefix: `${prefix}/`,
      pathEntries: [`${prefix}/bin`],
    }, 'install-path');
    expect(present.status).toBe('ok');
    expect(present.evidence).toContain(`${prefix}/bin`);
  });

  test('Windows PATH matches a trailing backslash case-insensitively and splits semicolons', () => {
    const prefix = 'C:\\Users\\u\\AppData\\Local\\elanous';
    const item = byId({ platform: 'win32', installPrefix: prefix, pathEntries: [`C:\\Windows;C:\\USERS\\U\\AppData\\Local\\elanous\\bin\\`] }, 'install-path');
    expect(item.status).toBe('ok');
    expect(item.evidence).toContain(`${prefix}\\bin`);
    expect(byId({ platform: 'win32', installPrefix: prefix, pathEntries: [`${prefix}\\bin\\`] }, 'install-path').status).toBe('ok');
  });

  test('Windows missing PATH uses the installer PowerShell expression with escaped quotes', () => {
    const prefix = 'C:\\Users\\u\\AppData\\Local\\elanous';
    expect(byId({ platform: 'win32', installPrefix: prefix, pathEntries: [] }, 'install-path'))
      .toMatchObject({ status: 'fixable', remedy: `$env:PATH = '${prefix}\\bin' + [IO.Path]::PathSeparator + $env:PATH` });
    expect(byId({ platform: 'win32', installPrefix: "C:\\Users\\O'Brien\\elanous", pathEntries: [] }, 'install-path').remedy)
      .toBe("$env:PATH = 'C:\\Users\\O''Brien\\elanous\\bin' + [IO.Path]::PathSeparator + $env:PATH");
  });

  test('an install prefix whose bin is on PATH is ok', () => {
    const item = byId({
      ...healthy,
      installPrefix: '/opt/elanous/',
      pathEntries: ['/usr/bin', '/opt/elanous/bin'],
    }, 'install-path');
    expect(item.status).toBe('ok');
  });

  test('a checkout (null install prefix) is ok even when PATH is empty, and an omitted prefix is unknown', () => {
    const checkout = byId({ ...healthy, installPrefix: null, pathEntries: [] }, 'install-path');
    expect(checkout.status).toBe('ok');
    expect(checkout.evidence).toContain('checkout');
    const omitted = byId({ ...healthy, installPrefix: undefined, pathEntries: [] }, 'install-path');
    expect(omitted.status).toBe('unknown');
    expect(omitted.evidence).not.toContain('checkout');
    const blank = byId({ ...healthy, installPrefix: '   ', pathEntries: [] }, 'install-path');
    expect(blank.status).toBe('unknown');
    expect(blank.evidence).not.toContain('checkout');
  });

  test('a responding health whose daemonSha differs from codeRevision is manual and names both commits', () => {
    const item = byId({
      ...healthy,
      health: { daemonSha: OTHER_SHA },
      codeRevision: CODE,
      platform: 'darwin',
    }, 'service-version');
    expect(item.status).toBe('manual');
    expect(item.evidence).toContain(OTHER_SHA);
    expect(item.evidence).toContain(CODE);
    expect(item.remedy).toBe('bash scripts/install.sh --no-modify-path && launchctl kickstart -k gui/$(id -u)/com.elanous.nexus');
  });

  test('linux restart uses the user systemd unit', () => {
    const item = byId({
      ...healthy,
      health: { daemonSha: OTHER_SHA },
      codeRevision: CODE,
      platform: 'linux',
    }, 'service-version');
    expect(item.status).toBe('manual');
    expect(item.remedy).toBe('bash scripts/install.sh --no-modify-path && systemctl --user restart elanous-nexus');
  });

  test('an unmeasured platform does not invent a launchctl restart command', () => {
    const item = byId({
      ...healthy,
      health: { daemonSha: OTHER_SHA },
      codeRevision: CODE,
      platform: undefined,
    }, 'service-version');
    expect(item.status).toBe('manual');
    expect(item.evidence).toContain(OTHER_SHA);
    expect(item.evidence).toContain(CODE);
    expect(item.remedy).toBeUndefined();
  });

  test('a daemonSha that is a prefix of codeRevision is ok, and a longer daemon sha is not', () => {
    const item = byId({
      ...healthy,
      health: { daemonSha: SAME_SHA },
      codeRevision: CODE,
    }, 'service-version');
    expect(item.status).toBe('ok');
    expect(item.remedy).toBeUndefined();
    const longer = byId({
      ...healthy,
      health: { daemonSha: `${CODE}ffff` },
      codeRevision: CODE,
      platform: 'darwin',
    }, 'service-version');
    expect(longer.status).toBe('manual');
    expect(longer.evidence).toContain(`${CODE}ffff`);
    expect(longer.evidence).toContain(CODE);
    expect(longer.remedy).toBe('bash scripts/install.sh --no-modify-path && launchctl kickstart -k gui/$(id -u)/com.elanous.nexus');
  });

  test('redacted lookalikes are not compared as commits', () => {
    const item = byId({
      ...healthy,
      health: { daemonSha: 'sk-live-should-never-appear' },
      codeRevision: 'sk-live-should-never-appear',
      platform: 'darwin',
    }, 'service-version');
    expect(item.status).toBe('manual');
    expect(item.evidence).not.toContain('sk-live-should-never-appear');
    expect(item.evidence).toContain('[redacted]');
    expect(item.evidence).not.toContain('matches');
  });

  test('no service file and no health response needs no version comparison or human action', () => {
    const report = checkReadiness({ serviceFile: null, health: null });
    expect(report.items.find((entry) => entry.id === 'service-version'))
      .toEqual({ id: 'service-version', status: 'ok', evidence: 'no service installed; nothing to compare' });
    expect(report.items.find((entry) => entry.id === 'service-file'))
      .toMatchObject({ status: 'ok', evidence: 'no service file installed' });
    expect(report.items.filter((entry) => entry.status === 'manual' || entry.status === 'fixable').map((entry) => entry.id))
      .not.toContain('service-version');
    for (const serviceFile of [{ path: '/unit.service', text: '[Service]' }, undefined]) {
      expect(byId({ serviceFile, health: null }, 'service-version'))
        .toEqual({ id: 'service-version', status: 'unknown', evidence: 'health did not respond; not measured' });
    }
    expect(byId({ serviceFile: null }, 'service-version'))
      .toEqual({ id: 'service-version', status: 'unknown', evidence: 'health was not measured' });
  });

  test('health that does not respond is unknown, not a claim that the service is down', () => {
    const item = byId({ ...healthy, health: null }, 'service-version');
    expect(item.status).toBe('unknown');
    expect(item.evidence).not.toMatch(/down|stopped|안 돈다/);
    expect(item.remedy).toBeUndefined();
  });

  test('a health body missing daemonSha is unknown rather than a mismatch', () => {
    const item = byId({ ...healthy, health: {}, codeRevision: CODE }, 'service-version');
    expect(item.status).toBe('unknown');
  });

  // 🆕 2026-09-24 — 로드맵 8번 F4: 리눅스에서 TMPDIR 와 bun 캐시가 다른 파일시스템이면 optional 의존성이 조용히 빠진다(EXDEV).
  test('bun-tmpdir: Linux split filesystems are fixable with a TMPDIR remedy; same is ok; unmeasured is unknown; other platforms are ok', () => {
    const by = (d: Parameters<typeof checkReadiness>[0]) => checkReadiness(d).items.find((entry) => entry.id === 'bun-tmpdir')!;
    const split = by({ platform: 'linux', tmpdirSameFsAsBunCache: false });
    expect(split.status).toBe('fixable');
    expect(split.remedy).toContain('export TMPDIR=~/tmp-bun');
    expect(by({ platform: 'linux', tmpdirSameFsAsBunCache: true }).status).toBe('ok');
    expect(by({ platform: 'linux', tmpdirSameFsAsBunCache: null }).status).toBe('unknown');
    expect(by({ platform: 'linux' }).status).toBe('unknown');
    expect(by({ platform: 'darwin', tmpdirSameFsAsBunCache: false }).status).toBe('ok');
  });

  test('every item has the readiness shape and a one-line remedy when present', () => {
    const report = checkReadiness({
      provider: 'auto',
      usableLlm: { usable: true, provider: 'openai-codex', via: 'login', why: 'login' },
      ghOnPath: false,
      installPrefix: '/opt/elanous',
      pathEntries: [],
      health: { daemonSha: OTHER_SHA },
      codeRevision: CODE,
      platform: 'darwin',
    });
    expect(report.items.map((entry) => entry.id)).toEqual([
      'provider-decision',
      'gh-auth',
      'harness-tools',
      'install-path',
      'service-version',
      'bun-version',
      'bun-tmpdir',
      'service-file',
      'service-secrets',
      'build-toolchain',
      'node-pty',
      'python-env',
      'substrate',
      'docker',
      'kubernetes',
      'memory',
    ]);
    for (const entry of report.items) {
      expect(['ok', 'fixable', 'manual', 'unknown']).toContain(entry.status);
      expect(entry.evidence.length).toBeGreaterThan(0);
      if (entry.remedy !== undefined) {
        expect(entry.remedy).not.toContain('\n');
        expect(entry.remedy.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('omitted lookups stay unknown instead of claiming gh is missing, a checkout, or no codex login', () => {
    const report = checkReadiness({});
    const by = (id: string) => report.items.find((entry) => entry.id === id)!;
    expect(by('provider-decision').status).toBe('unknown');
    expect(by('provider-decision').evidence).not.toContain('no codex login');
    expect(by('gh-auth').status).toBe('unknown');
    expect(by('gh-auth').evidence).not.toContain('not on PATH');
    expect(by('install-path').status).toBe('unknown');
    expect(by('install-path').evidence).not.toContain('checkout');
    expect(by('service-version').status).toBe('unknown');
    expect(by('service-version').evidence).toContain('not measured');
  });

  test('a credential string placed in every printable input is absent from the report', () => {
    const secret = 'sk-live-should-never-appear';
    const github = 'ghp_shouldneverappear1234567890';
    const report = checkReadiness({
      provider: `grok-${github}`,
      ghOnPath: true,
      ghAuthStatus: 1,
      installPrefix: `/opt/${secret}/elanous`,
      pathEntries: [`/opt/${secret}/bin`],
      health: { daemonSha: secret },
      codeRevision: `${secret}-revision`,
      platform: 'darwin',
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(github);
    expect(text).not.toContain('ghp_');
    expect(text).not.toMatch(/api[_-]?key|bearer|password/i);
    expect(report.items.find((entry) => entry.id === 'provider-decision')?.status).toBe('unknown');
    expect(report.items.find((entry) => entry.id === 'service-version')?.evidence).not.toContain(secret);
    const install = report.items.find((entry) => entry.id === 'install-path');
    // 가려야 하는 경로엔 실행 불가능한 자리표시자 명령을 주지 않는다(리뷰 must-fix) — 사람 몫.
    expect(install?.status).toBe('manual');
    expect(install?.evidence).not.toContain(secret);
    expect(install?.remedy).toBeUndefined();
  });

  test('a secret inside a PATH entry does not hide a real matching install bin', () => {
    const secret = 'sk-live-should-never-appear';
    const prefix = `/opt/${secret}/elanous`;
    const item = byId({
      ...healthy,
      installPrefix: prefix,
      pathEntries: [`/usr/bin`, `${prefix}/bin`],
    }, 'install-path');
    expect(item.status).toBe('ok');
    expect(item.evidence).not.toContain(secret);
    expect(item.evidence).toContain('[redacted-path]');
    expect(JSON.stringify(item)).not.toContain(secret);
  });
});

// 🆕 2026-09-24 — 전역 elanous 링크가 설치본으로 풀리면 PATH 블록이 필요 없다.
describe('bun-version — one pin (.bun-version) for installer, pod image and doctor', () => {
  const by = (d: Parameters<typeof checkReadiness>[0]) => checkReadiness(d).items.find((entry) => entry.id === 'bun-version')!;
  test('equal is ok, different is manual with the pinned install line, unreadable is unknown', () => {
    expect(by({ bunVersion: '1.4.2', bunPin: '1.4.2' }).status).toBe('ok');
    const differs = by({ bunVersion: '1.3.12', bunPin: '1.4.2', platform: 'linux' });
    expect(differs.status).toBe('manual');
    expect(differs.evidence).toContain('1.3.12');
    expect(differs.remedy).toBe('curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2');
    expect(by({ bunVersion: '1.3.12', bunPin: '1.4.2', platform: 'win32' }).remedy).toBeUndefined();
    expect(by({ bunVersion: '1.4.2', bunPin: null }).status).toBe('unknown');
    expect(by({}).status).toBe('unknown');
  });
});

describe('install-path — elanous on PATH resolving into the install', () => {
  const base = { installPrefix: '/home/u/.local/share/elanous', pathEntries: ['/home/u/.bun/bin', '/usr/bin'] };
  test('ok when the first elanous on PATH resolves inside the install prefix', () => {
    const r = checkReadiness({ ...base, elanousOnPath: '/home/u/.local/share/elanous/versions/1.0.0-abc/node_modules/elanous/bin/elanous.mjs' });
    expect(r.items.find((i) => i.id === 'install-path')).toMatchObject({ status: 'ok' });
  });
  test('still fixable when elanous on PATH is a checkout, absent, or a sibling prefix', () => {
    for (const elanousOnPath of ['/home/u/src/monad-agent/bin/elanous.mjs', null, undefined, '/home/u/.local/share/elanous-other/bin/elanous']) {
      const r = checkReadiness({ ...base, elanousOnPath });
      expect(r.items.find((i) => i.id === 'install-path')).toMatchObject({ status: 'fixable' });
    }
  });
});

describe('readiness — T2 additions (2026-09-24)', () => {
  const find = (deps: Parameters<typeof checkReadiness>[0], id: string) => checkReadiness(deps).items.find((entry) => entry.id === id)!;

  test('auto with no login and no LLM key is manual, not a false green', () => {
    expect(find({ provider: 'auto', usableLlm: { usable: false, via: 'none', why: 'no usable LLM route selected' } }, 'provider-decision'))
      .toMatchObject({ status: 'manual', remedy: 'elanous login openai-codex' });
    expect(find({ provider: 'auto', usableLlm: { usable: true, provider: 'local', via: 'local-server', why: 'local' } }, 'provider-decision'))
      .toMatchObject({ status: 'ok', evidence: 'llm.provider=auto → local-server local' });
    expect(find({ provider: 'auto', usableLlm: null }, 'provider-decision').status).toBe('unknown');
  });

  test('service file: version folder is fixable, bare elanous is manual, stable path is ok, absent is ok, unmeasured is unknown', () => {
    const plist = (arg: string) => `<array><string>/usr/bin/bun</string><string>${arg}</string><string>nexus</string><string>run</string></array>`;
    expect(find({ serviceFile: { path: '/p', text: plist('/i/versions/1.0.0-a/node_modules/elanous/bin/elanous.mjs') } }, 'service-file').status).toBe('fixable');
    expect(find({ serviceFile: { path: '/p', text: '<array><string>elanous</string><string>nexus</string><string>run</string></array>' } }, 'service-file'))
      .toMatchObject({ status: 'manual', remedy: 'elanous nexus install' });
    expect(find({ serviceFile: { path: '/p', text: plist('/i/current/node_modules/elanous/bin/elanous.mjs') } }, 'service-file').status).toBe('ok');
    expect(find({ serviceFile: null }, 'service-file').status).toBe('ok');
    expect(find({}, 'service-file').status).toBe('unknown');
    expect(JSON.stringify(find({ serviceFile: { path: '/p', text: 'SECRET_KEY=abc /versions/1/node_modules/elanous/' } }, 'service-file'))).not.toContain('SECRET_KEY');
  });
});

test('systemd provider environment is fixable by name only; unrelated entries are ok and unreadable files unknown', () => {
  const secret = 'unique-service-secret-12345';
  const unit = `[Service]\nEnvironment="OPENAI_API_KEY=${secret}"\nEnvironment="ELANOUS_PWA_STATIC_DIR=/public"\n`;
  const found = byId({ serviceFile: { path: '/unit', text: unit } }, 'service-secrets');
  expect(found.status).toBe('fixable');
  expect(found.evidence).toContain('OPENAI_API_KEY');
  expect(JSON.stringify(checkReadiness({ serviceFile: { path: '/unit', text: unit } }))).not.toContain(secret);
  expect(byId({ serviceFile: { path: '/unit', text: 'Environment="ELANOUS_PWA_STATIC_DIR=/public"\n' } }, 'service-secrets').status).toBe('ok');
  expect(byId({}, 'service-secrets').status).toBe('unknown');
  const plist = `<plist><dict><key>EnvironmentVariables</key><dict><key>OPENAI_API_KEY</key><string>${secret}</string></dict></dict></plist>`;
  const plistItem = byId({ serviceFile: { path: '/plist', text: plist } }, 'service-secrets');
  expect(plistItem.status).toBe('fixable');
  expect(plistItem.evidence).toContain('OPENAI_API_KEY');
  expect(JSON.stringify(plistItem)).not.toContain(secret);
  expect(byId({ serviceFile: null }, 'service-secrets').status).toBe('ok');
});

describe('readiness — build toolchain and node-pty (RFC #20265 P2)', () => {
  const find = (deps: Parameters<typeof checkReadiness>[0], id: string) => checkReadiness(deps).items.find((entry) => entry.id === id)!;
  test('build-toolchain: both present ok · missing is manual with the distro one-liner · a probe that could not run is unknown', () => {
    expect(find({ buildToolchain: { make: true, cxx20: true } }, 'build-toolchain').status).toBe('ok');
    expect(find({ buildToolchain: { make: false, cxx20: false }, distro: 'fedora' }, 'build-toolchain'))
      .toMatchObject({ status: 'manual', remedy: 'sudo dnf install -y gcc-c++ make' });
    expect(find({ buildToolchain: { make: true, cxx20: false }, distro: 'amzn2' }, 'build-toolchain').remedy).toContain('gcc10');
    expect(find({ buildToolchain: { make: true, cxx20: null } }, 'build-toolchain').status).toBe('unknown');
    expect(find({}, 'build-toolchain').status).toBe('unknown');
  });
  test('node-pty: found ok · missing with a toolchain is fixable (rebuild) · without one is manual (toolchain first)', () => {
    expect(find({ nodePty: 'found' }, 'node-pty').status).toBe('ok');
    expect(find({ nodePty: 'missing', buildToolchain: { make: true, cxx20: true } }, 'node-pty').status).toBe('fixable');
    expect(find({ nodePty: 'broken', buildToolchain: { make: false, cxx20: true }, distro: 'debian' }, 'node-pty'))
      .toMatchObject({ status: 'manual', remedy: 'sudo apt-get install -y build-essential' });
    expect(find({}, 'node-pty').status).toBe('unknown');
  });
});

// 🆕 2026-09-24 — python-env (RFC #20265 A3 · 대표 표준 = elanous venv)
describe('python-env readiness', () => {
  const pick = (deps: Parameters<typeof checkReadiness>[0]) => checkReadiness(deps).items.find((i) => i.id === 'python-env')!;
  test('unmeasured is unknown, not ok', () => {
    expect(pick({}).status).toBe('unknown');
    expect(pick({ pythonEnv: null }).status).toBe('unknown');
  });
  test('Windows manual Python remedy is not prefixed with POSIX distro build commands', () => {
    expect(pick({ platform: 'win32', distro: 'debian', pythonEnv: { status: 'manual', evidence: 'no python.exe found', remedy: 'uv python install 3.12' } }))
      .toMatchObject({ status: 'manual', remedy: 'uv python install 3.12' });
  });
  test('fixable points at doctor --fix; manual prefixes the distro python build deps', () => {
    expect(pick({ pythonEnv: { status: 'fixable', evidence: 'venv missing', remedy: 'elanous python setup --yes' } })).toMatchObject({ status: 'fixable', remedy: 'elanous doctor --fix --yes' });
    const m = pick({ distro: 'amzn2', pythonEnv: { status: 'manual', evidence: 'python 3.7 older than 3.12.12', remedy: 'pyenv install 3.12.12' } });
    expect(m.status).toBe('manual');
    expect(m.remedy).toContain('openssl11-devel');
    expect(m.remedy).toContain('pyenv install 3.12.12');
    expect(pick({ distro: 'unknown', pythonEnv: { status: 'manual', evidence: 'x', remedy: 'pyenv install 3.12.12' } }).remedy).toBe('pyenv install 3.12.12');
  });
});

test('python-env with no python at all on debian gets the distro python line, not the pyenv prose', () => {
  const m = checkReadiness({ distro: 'debian', pythonEnv: { status: 'manual', evidence: 'no python3 found (ELANOUS_PYTHON · elanous venv · pyenv · PATH)', remedy: 'install Python 3.12.12+ (pyenv install 3.12.12) — see RFC-doctor-fix-build-toolchain-and-python-by-distro A2' } }).items.find((i) => i.id === 'python-env')!;
  expect(m.remedy).toBe('sudo apt-get update && sudo apt-get install -y python3 python3-venv && elanous python setup --yes');
});

test('python-env with no python on a family without a base line keeps the build path', () => {
  const m = checkReadiness({ distro: 'amzn2', pythonEnv: { status: 'manual', evidence: 'no python3 found (ELANOUS_PYTHON · elanous venv · pyenv · PATH)', remedy: 'install Python 3.12.12+ (pyenv install 3.12.12) — see RFC A2' } }).items.find((i) => i.id === 'python-env')!;
  expect(m.remedy).toContain('pyenv install');
});

test('python-env ensurepip case does not prepend pyenv build deps', () => {
  const m = checkReadiness({ distro: 'debian', pythonEnv: { status: 'manual', evidence: 'the base python cannot create a venv with pip (ensurepip missing)', remedy: 'sudo apt-get install -y python3-venv && elanous python setup --yes' } }).items.find((i) => i.id === 'python-env')!;
  expect(m.remedy).toBe('sudo apt-get install -y python3-venv && elanous python setup --yes');
});

describe('service-version remedy follows where doctor runs (D5)', () => {
  test('an installed copy only needs a restart — the remedy restarts, it does not install from a checkout', () => {
    const item = byId({ ...healthy, installPrefix: '/opt/elanous', health: { daemonSha: OTHER_SHA }, codeRevision: CODE, platform: 'darwin' }, 'service-version');
    expect(item.status).toBe('manual');
    expect(item.remedy).toBe('launchctl kickstart -k gui/$(id -u)/com.elanous.nexus');
    const linux = byId({ ...healthy, installPrefix: '/opt/elanous', health: { daemonSha: OTHER_SHA }, codeRevision: CODE, platform: 'linux' }, 'service-version');
    expect(linux.remedy).toBe('systemctl --user restart elanous-nexus');
  });
});

describe('L0 substrate · docker · kubernetes · memory (RFC docker·k8s ladder)', () => {
  const none: SubstrateSignals = { kubernetesServiceHost: false, serviceAccountNamespace: false, dockerenv: false, containerenv: false, cgroup: null, containerEnv: null };
  const GiB = 1024 ** 3;

  test('cgroup v2 `0::/` alone is not evidence of a host — /.dockerenv decides container', () => {
    expect(detectSubstrate({ ...none, cgroup: '0::/\n', dockerenv: true })).toEqual({ substrate: 'container', signal: '/.dockerenv' });
    expect(byId({ substrate: { ...none, cgroup: '0::/\n', dockerenv: true } }, 'substrate')).toMatchObject({ status: 'ok', evidence: 'container (/.dockerenv)' });
  });

  test('KUBERNETES_SERVICE_HOST wins over every container signal', () => {
    const item = byId({ substrate: { ...none, kubernetesServiceHost: true, dockerenv: true, cgroup: '0::/kubepods/besteffort/pod1' } }, 'substrate');
    expect(item.evidence).toBe('kubernetes (env KUBERNETES_SERVICE_HOST)');
  });

  test('service-account namespace, podman containerenv, cgroup v1 runtimes and env container each decide', () => {
    expect(detectSubstrate({ ...none, serviceAccountNamespace: true })?.substrate).toBe('kubernetes');
    expect(detectSubstrate({ ...none, containerenv: true })).toEqual({ substrate: 'container', signal: '/run/.containerenv' });
    expect(detectSubstrate({ ...none, cgroup: '12:pids:/docker/abc\n0::/' })).toEqual({ substrate: 'container', signal: '/proc/1/cgroup docker' });
    expect(detectSubstrate({ ...none, cgroup: '0::/kubepods.slice/x' })?.substrate).toBe('kubernetes');
    expect(detectSubstrate({ ...none, cgroup: '1:name=systemd:/machine.slice/libpod-abc.scope' })?.signal).toBe('/proc/1/cgroup libpod');
    expect(detectSubstrate({ ...none, containerEnv: 'podman' })).toEqual({ substrate: 'container', signal: 'env container=podman' });
  });

  test('no signal is host; no measured signal at all is unknown, not host', () => {
    expect(byId({ substrate: { ...none, cgroup: '0::/' } }, 'substrate')).toMatchObject({ status: 'ok', evidence: 'host (no container or kubernetes signal)' });
    const blind: SubstrateSignals = { kubernetesServiceHost: null, serviceAccountNamespace: null, dockerenv: null, containerenv: null, cgroup: null, containerEnv: null };
    expect(byId({ substrate: blind }, 'substrate').status).toBe('unknown');
    expect(byId({}, 'substrate').status).toBe('unknown');
  });

  test('docker: absent CLI is ok (optional); unmeasured is unknown', () => {
    expect(byId({ docker: { onPath: false } }, 'docker')).toMatchObject({ status: 'ok', evidence: 'not installed — optional (container verification matrix needs it)' });
    expect(byId({ docker: { onPath: null } }, 'docker').status).toBe('unknown');
    expect(byId({}, 'docker').status).toBe('unknown');
  });

  test('docker: engine not responding is manual with a platform start line; timeout stays unknown', () => {
    const mac = byId({ platform: 'darwin', docker: { onPath: true, info: { kind: 'no-response', detail: 'Cannot connect to the Docker daemon' }, desktopApp: 'OrbStack' } }, 'docker');
    expect(mac).toMatchObject({ status: 'manual', remedy: 'open -a OrbStack' });
    expect(mac.evidence).toContain('Cannot connect');
    expect(byId({ platform: 'darwin', docker: { onPath: true, info: { kind: 'no-response' }, desktopApp: null } }, 'docker').remedy).toBeUndefined();
    expect(byId({ platform: 'linux', docker: { onPath: true, info: { kind: 'no-response' } } }, 'docker').remedy).toBe('sudo systemctl start docker');
    expect(byId({ docker: { onPath: true, info: { kind: 'timeout' } } }, 'docker').status).toBe('unknown');
    expect(byId({ docker: { onPath: true, info: null } }, 'docker').status).toBe('unknown');
  });

  test('docker: a responding engine reports version, CPU and memory', () => {
    const item = byId({ docker: { onPath: true, info: { kind: 'engine', engine: { serverVersion: '28.5.2', ncpu: 18, memTotalBytes: 16807133184, operatingSystem: 'OrbStack' } } } }, 'docker');
    expect(item).toMatchObject({ status: 'ok', evidence: 'engine 28.5.2 (OrbStack) · 18 CPU · 15.7GB memory' });
  });

  test('kubernetes: absent / no context is ok; unreachable cluster is manual naming the context', () => {
    expect(byId({ kubernetes: { onPath: false } }, 'kubernetes').status).toBe('ok');
    expect(byId({ kubernetes: { onPath: true, context: null } }, 'kubernetes')).toMatchObject({ status: 'ok', evidence: 'kubectl installed, no context — optional' });
    expect(byId({ kubernetes: { onPath: true } }, 'kubernetes').status).toBe('unknown');
    const down = byId({ kubernetes: { onPath: true, context: 'kind-elanous', server: { kind: 'no-response', detail: 'connection refused' } } }, 'kubernetes');
    expect(down.status).toBe('manual');
    expect(down.evidence).toContain('kind-elanous: cluster unreachable');
    expect(down.remedy).toBe("kubectl --context 'kind-elanous' cluster-info");
    expect(byId({ kubernetes: { onPath: true, context: 'kind-elanous', server: { kind: 'timeout' } } }, 'kubernetes').status).toBe('unknown');
    expect(byId({ kubernetes: { onPath: true, context: 'kind-elanous', server: { kind: 'ok', gitVersion: 'v1.31.0' } } }, 'kubernetes'))
      .toMatchObject({ status: 'ok', evidence: 'context kind-elanous · server v1.31.0' });
  });

  test('memory parsers: vm_stat uses the page size from its first line; /proc/meminfo multiplies kB', () => {
    const vmStat = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                   254052.',
      'Pages active:                                2841490.',
      'Pages inactive:                              2850001.',
      'Pages speculative:                               585.',
    ].join('\n');
    expect(parseVmStatAvailableBytes(vmStat)).toBe((254052 + 2850001) * 16384);
    expect(parseVmStatAvailableBytes(vmStat.replace('16384', '4096'))).toBe((254052 + 2850001) * 4096);
    expect(parseVmStatAvailableBytes('garbage')).toBeNull();
    const meminfo = 'MemTotal:       16318412 kB\nMemFree:          812344 kB\nMemAvailable:   11203880 kB\n';
    expect(parseMeminfo(meminfo)).toEqual({ totalBytes: 16318412 * 1024, availableBytes: 11203880 * 1024 });
    expect(parseMeminfo('MemTotal:       16318412 kB\n')).toEqual({ totalBytes: 16318412 * 1024, availableBytes: null });
  });

  test('memory: below the k3s-grounded 2GB floor is manual; above is ok; docker VM memory is appended', () => {
    expect(MEMORY_AVAILABLE_FLOOR_BYTES).toBe(2 * GiB);
    const low = byId({ memory: { totalBytes: 4 * GiB, availableBytes: 1.5 * GiB, source: '/proc/meminfo' } }, 'memory');
    expect(low.status).toBe('manual');
    expect(low.evidence).toContain('k3s');
    const ok = byId({
      memory: { totalBytes: 128 * GiB, availableBytes: 48.7 * GiB, source: 'vm_stat' },
      docker: { onPath: true, info: { kind: 'engine', engine: { serverVersion: '28.5.2', memTotalBytes: 15.6 * GiB } } },
    }, 'memory');
    expect(ok.status).toBe('ok');
    expect(ok.evidence).toBe('total 128.0GB · available 48.7GB · docker VM 15.6GB (vm_stat)');
    expect(byId({ memory: { totalBytes: 8 * GiB, availableBytes: null, source: 'vm_stat' } }, 'memory').status).toBe('unknown');
    expect(byId({ memory: { totalBytes: null, availableBytes: null, source: '/proc/meminfo' } }, 'memory').status).toBe('unknown');
    expect(byId({}, 'memory').status).toBe('unknown');
  });

  test('docker info and kubectl version parsers keep only the server fields', () => {
    expect(parseDockerInfo('{"ServerVersion":"28.5.2","NCPU":18,"MemTotal":16807133184,"OperatingSystem":"OrbStack"}'))
      .toEqual({ serverVersion: '28.5.2', ncpu: 18, memTotalBytes: 16807133184, operatingSystem: 'OrbStack' });
    expect(parseDockerInfo('{"ServerVersion":"","ServerErrors":["Cannot connect"]}')).toBeNull();
    expect(parseDockerInfo('not json')).toBeNull();
    expect(parseKubectlServerVersion('{"clientVersion":{"gitVersion":"v1.31.0"},"serverVersion":{"gitVersion":"v1.30.2"}}')).toBe('v1.30.2');
    expect(parseKubectlServerVersion('{"clientVersion":{"gitVersion":"v1.31.0"}}')).toBeNull();
  });
});

// 🩸 09-26: 운영 plist 가 사람 작업 트리(pilot)를 가리켰다 — WorkingDirectory ⊕ ELANOUS_PWA_STATIC_DIR.
describe('service-file — a service that depends on a git working tree', () => {
  const plist = `<dict>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>ELANOUS_PWA_STATIC_DIR</key>\n    <string>/Users/u/work/checkout/apps/pwa/out</string>\n  </dict>\n  <key>ProgramArguments</key>\n  <array><string>/Users/u/.bun/bin/bun</string><string>/Users/u/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs</string></array>\n  <key>WorkingDirectory</key>\n  <string>/Users/u/work/checkout</string>\n</dict>`;
  test('servicePathRefs reads WorkingDirectory and the PWA dir from a plist and a systemd unit', () => {
    expect(servicePathRefs(plist)).toEqual(['/Users/u/work/checkout/apps/pwa/out', '/Users/u/work/checkout']);
    expect(servicePathRefs('[Service]\nWorkingDirectory=/home/u\nEnvironment="ELANOUS_PWA_STATIC_DIR=/home/u/src/apps/pwa/out"\n')).toEqual(['/home/u', '/home/u/src/apps/pwa/out']);
  });
  test('git-tree refs make it manual with a reinstall-from-home remedy; none keeps it ok', () => {
    const by = (d: Parameters<typeof checkReadiness>[0]) => checkReadiness(d).items.find((e) => e.id === 'service-file')!;
    const bad = by({ platform: 'darwin', serviceFile: { path: '/p.plist', text: plist }, serviceGitTreeRefs: ['/Users/u/work/checkout'] });
    expect(bad.status).toBe('manual');
    expect(bad.evidence).toContain('git working tree');
    expect(bad.remedy).toBe('cd ~ && elanous nexus install --launchd');
    expect(by({ platform: 'darwin', serviceFile: { path: '/p.plist', text: plist }, serviceGitTreeRefs: [] }).status).toBe('ok');
  });
});
