import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMachineSetupPlan, formatMachineSetupPlan, readMachineCaptureForPlan } from './machine-setup-plan.js';

const capture = {
  kind: 'machine-capture',
  platform: 'darwin',
  packages: {
    formulaeStatus: 'captured',
    casksStatus: 'failed',
    tapsStatus: 'captured',
    formulae: [{ name: 'neovim', version: '0.11.4' }, { name: 'ripgrep', version: '15.1.0' }],
    casks: [],
    taps: [],
  },
  dotfiles: [{ path: '.zshrc', status: 'hashed', sha256: 'private-hash' }],
  fonts: { status: 'captured', names: [{ name: 'Private Font Name.otf', scope: 'user' }] },
};

test('default profile derives macOS present packages from MBP capture and leaves failed cask inventory unknown', () => {
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'macos', capture });
  expect(plan).toMatchObject({ kind: 'machine-setup-plan', profile: 'default', platform: 'macos', dryRun: true, sample: 'machine-capture' });
  expect(plan.packages.find(item => item.name === 'neovim')).toMatchObject({ presence: 'present', manager: 'brew' });
  expect(plan.packages.find(item => item.name === 'neovim')?.reason).toContain('terminal editor');
  expect(plan.packages.find(item => item.name === 'ghostty')).toMatchObject({ presence: 'unknown', manager: 'brew' });
  expect(plan.packages.some(item => item.name === 'starship')).toBe(false);
  expect(plan.operations.some(item => item.id === 'confirm-unknown-inventory')).toBe(true);
  expect(plan.packages.some(item => item.name === 'awscli' || item.name === 'gh')).toBe(false);
  const output = JSON.stringify(plan);
  expect(output).not.toContain('private-hash');
  expect(output).not.toContain('Private Font Name');
  expect(output).not.toContain('dotfiles');
});

test('complete macOS cask inventory produces a separate brew cask operation', () => {
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'macos', capture: {
    ...capture,
    packages: { ...capture.packages, casksStatus: 'captured' },
  } });
  const cask = plan.operations.find(operation => operation.packageKind === 'cask');
  expect(cask?.manager).toBe('brew');
  expect(cask?.command).toContain('--cask');
  expect(cask?.packages).toContain('ghostty');
});

test('developer and headquarters profiles extend the user default without importing credentials', () => {
  const developer = buildMachineSetupPlan({ profile: 'developer', platform: 'macos' });
  const headquarters = buildMachineSetupPlan({ profile: 'headquarters', platform: 'macos' });
  expect(developer.packages.some(item => item.name === 'gh')).toBe(true);
  expect(developer.packages.some(item => item.name === 'ast-grep')).toBe(true);
  expect(developer.packages.some(item => item.name === 'python@3.14')).toBe(true);
  expect(developer.packages.some(item => item.name === 'awscli')).toBe(false);
  expect(headquarters.packages.some(item => item.name === 'gh')).toBe(true);
  expect(headquarters.packages.some(item => item.name === 'awscli')).toBe(true);
  expect(headquarters.packages.find(item => item.name === 'gcloud-cli')).toMatchObject({ manager: 'brew', presence: 'would-install' });
  expect(headquarters.packages.some(item => item.name === 'k3d' || item.name === 'helm' || item.name === 'packer')).toBe(true);
  expect(headquarters.operations.some(item => item.packageKind === 'cask' && item.packages?.includes('gcloud-cli'))).toBe(true);
  for (const [name, kind] of [['awscli', 'formula'], ['gcloud-cli', 'cask'], ['k3d', 'formula'], ['helm', 'formula'],
    ['hashicorp/tap/packer', 'formula'], ['autossh', 'formula'], ['lego', 'formula']] as const) {
    expect(headquarters.operations.find(item => item.kind === 'install' && item.packages?.includes(name)))
      .toMatchObject({ manager: 'brew', packageKind: kind, packages: [name] });
  }
  expect(headquarters.safety.join(' ')).toContain('credentials remain owned by eln cred');
});

test('captured tap-qualified package names remain valid and copied font files suppress cask reinstall', () => {
  const source = {
    ...capture,
    packages: {
      ...capture.packages,
      casksStatus: 'captured',
      casks: [],
      formulae: [...capture.packages.formulae, { name: 'steipete/tap/camsnap' }],
    },
    fonts: { status: 'captured', names: [
      { name: 'JetBrainsMonoNerdFont-Regular.ttf', scope: 'user' },
      { name: 'NotoSansCJKkr-Regular.otf', scope: 'user' },
    ] },
  };
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'macos', capture: source });
  expect(plan.packages.find(item => item.name === 'neovim')?.presence).toBe('present');
  expect(plan.packages.find(item => item.name === 'font-jetbrains-mono-nerd-font')?.presence).toBe('present');
  expect(plan.packages.find(item => item.name === 'font-noto-sans-cjk-kr')?.presence).toBe('present');
  expect(JSON.stringify(plan)).not.toContain('JetBrainsMonoNerdFont-Regular.ttf');
  expect(JSON.stringify(plan)).not.toContain('NotoSansCJKkr-Regular.otf');
});

test('HQ package capture preserves the selected tap identity and treats a different formula with the same basename as unknown', () => {
  const exact = buildMachineSetupPlan({ profile: 'headquarters', platform: 'macos', capture: {
    ...capture,
    packages: { ...capture.packages, formulaeStatus: 'captured', formulae: [{ name: 'hashicorp/tap/packer' }] },
  } });
  expect(exact.packages.find(item => item.name === 'hashicorp/tap/packer')).toMatchObject({ presence: 'present', manager: 'brew' });
  const otherTap = buildMachineSetupPlan({ profile: 'headquarters', platform: 'macos', capture: {
    ...capture,
    packages: { ...capture.packages, formulaeStatus: 'captured', formulae: [{ name: 'other/tap/packer' }] },
  } });
  expect(otherTap.packages.find(item => item.name === 'hashicorp/tap/packer')?.presence).toBe('unknown');
});

test('Japanese-only Noto CJK font does not satisfy the Korean font profile choice', () => {
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'macos', capture: {
    ...capture,
    packages: { ...capture.packages, casksStatus: 'captured', casks: [] },
    fonts: { status: 'captured', names: [{ name: 'NotoSansCJKjp-Regular.otf', scope: 'user' }] },
  } });
  expect(plan.packages.find(item => item.name === 'font-noto-sans-cjk-kr')?.presence).toBe('would-install');
});

test('Linux plan uses apt package names and leaves unverified app/font routes explicit', () => {
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'linux' });
  expect(plan.packages.find(item => item.name === 'fd-find')).toMatchObject({ manager: 'apt-get', presence: 'would-install' });
  expect(plan.packages.find(item => item.name === 'ghostty')).toMatchObject({ manager: 'manual', presence: 'would-install' });
  expect(plan.operations.find(item => item.kind === 'install' && item.manager === 'apt-get')?.command).toContain('--dry-run');
  expect(plan.operations.some(item => item.manager === 'manual' && item.packages?.includes('font-jetbrains-mono-nerd-font'))).toBe(true);
  expect(plan.packages.find(item => item.name === 'tailscale')?.manager).toBe('manual');
  expect(plan.operations.some(item => item.id === 'tailscale-repository-preflight')).toBe(true);
  expect(plan.operations.find(item => item.manager === 'apt-get' && item.kind === 'install')?.packages).not.toContain('tailscale');
  expect(plan.operations.every(item => item.kind !== 'install' || item.manager !== 'apt-get' || item.command?.includes('--dry-run'))).toBe(true);
});

test('developer profile chooses curated runtimes and exposes unverified Linux installers as manual steps', () => {
  const plan = buildMachineSetupPlan({ profile: 'developer', platform: 'linux' });
  expect(plan.packages.find(item => item.name === 'golang-go')).toMatchObject({ manager: 'apt-get', presence: 'would-install' });
  expect(plan.packages.find(item => item.name === 'gradle')).toMatchObject({ manager: 'apt-get', presence: 'would-install' });
  expect(plan.packages.find(item => item.name === 'cargo')).toMatchObject({ manager: 'apt-get', presence: 'would-install' });
  expect(plan.packages.find(item => item.name === 'tree-sitter-cli')).toMatchObject({ manager: 'cargo', presence: 'would-install' });
  for (const platform of ['linux', 'wsl'] as const) {
    const platformPlan = buildMachineSetupPlan({ profile: 'developer', platform });
    const cargoInstall = platformPlan.operations.find(item => item.manager === 'apt-get' && item.packages?.includes('cargo'));
    const treeSitterInstall = platformPlan.operations.find(item => item.manager === 'cargo' && item.packages?.includes('tree-sitter-cli'));

    expect(platformPlan.packages.find(item => item.name === 'cargo')).toMatchObject({ manager: 'apt-get' });
    expect(cargoInstall).toBeDefined();
    expect(treeSitterInstall).toBeDefined();
    expect(platformPlan.operations.indexOf(cargoInstall!)).toBeLessThan(platformPlan.operations.indexOf(treeSitterInstall!));
  }
  expect(plan.operations.some(item => item.manager === 'manual' && item.packages?.includes('deno'))).toBe(true);
  expect(plan.operations.some(item => item.manager === 'manual' && item.packages?.includes('cocoapods'))).toBe(true);
});

test('Linux headquarters profile leaves non-default external package sources manual', () => {
  const plan = buildMachineSetupPlan({ profile: 'headquarters', platform: 'linux' });
  for (const name of ['k3d', 'helm', 'hashicorp/tap/packer', 'autossh', 'lego']) {
    expect(plan.packages.find(item => item.name === name)?.manager).toBe('manual');
  }
  expect(plan.operations.some(item => item.kind === 'install' && item.manager === 'apt-get'
    && ['k3d', 'helm', 'packer', 'autossh', 'lego'].includes(item.packages?.[0] ?? ''))).toBe(false);
});

test('WSL plan starts with host install and reboot checkpoint before guest setup', () => {
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'wsl' });
  expect(plan.packages.some(item => item.name === 'ghostty')).toBe(false);
  expect(plan.operations.some(item => item.id === 'wsl-terminal-fonts')).toBe(true);
  expect(plan.operations.slice(0, 3).map(item => item.id)).toEqual(['wsl-install', 'wsl-reboot-checkpoint', 'wsl-systemd']);
  expect(plan.operations[0]).toMatchObject({ phase: 'host', manager: 'wsl.exe', privilege: 'administrator', consent: 'explicit' });
  expect(plan.operations[0]?.command).toContain('Ubuntu');
  expect(plan.operations[1]?.kind).toBe('checkpoint');
  const guestPackages = plan.operations.findIndex(item => item.phase === 'guest' && item.kind === 'install');
  const windowsTerminal = plan.operations.findIndex(item => item.id === 'wsl-terminal-fonts');
  expect(guestPackages).toBeGreaterThan(plan.operations.findIndex(item => item.id === 'wsl-systemd'));
  expect(windowsTerminal).toBeGreaterThan(guestPackages);
  expect(plan.operations[windowsTerminal]).toMatchObject({ phase: 'host', kind: 'manual' });
  expect(plan.dryRun).toBe(true);
});

test('WSL developer profile includes unattended installer and native-build prerequisites', () => {
  const wsl = buildMachineSetupPlan({ profile: 'developer', platform: 'wsl' });
  for (const name of ['build-essential', 'curl', 'python3-venv', 'unzip']) {
    expect(wsl.packages.find(item => item.name === name)).toMatchObject({ manager: 'apt-get', presence: 'would-install' });
  }
  for (const name of ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin']) {
    expect(wsl.packages.find(item => item.name === name)).toMatchObject({ manager: 'apt-get', presence: 'would-install' });
  }
  expect(wsl.operations.map(item => item.id)).toContain('wsl-docker-engine');
  expect(wsl.operations.map(item => item.id)).toContain('wsl-k3d-install');
  expect(wsl.operations.find(item => item.id === 'wsl-systemd')?.privilege).toBe('none');
  expect(wsl.operations.filter(item => item.manager === 'apt-get').every(item => item.privilege === 'none'
    && !item.command?.includes('sudo'))).toBe(true);
  expect(wsl.operations.find(item => item.id === 'wsl-k3d-install')?.reason).toContain('official installer');
  const mac = buildMachineSetupPlan({ profile: 'developer', platform: 'macos' });
  expect(mac.packages.some(item => item.name.startsWith('docker-') || item.name === 'containerd.io')).toBe(false);
  expect(buildMachineSetupPlan({ profile: 'headquarters', platform: 'wsl' }).operations.some(item => item.id === 'wsl-k3d-install')).toBe(true);
  for (const name of ['build-essential', 'curl', 'python3-venv', 'unzip']) {
    expect(mac.packages.some(item => item.name === name)).toBe(false);
  }
});

test('WSL profile plans an explicit guest eln install and version verification after bootstrap', () => {
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'wsl' });
  const install = plan.operations.find(item => item.id === 'wsl-eln-install');
  const verify = plan.operations.find(item => item.id === 'wsl-eln-version-check');
  expect(install).toMatchObject({ phase: 'guest', kind: 'install', manager: 'manual', privilege: 'user', consent: 'explicit' });
  expect(install?.command?.[2]).toContain('set -o pipefail');
  expect(install?.command?.[2]).toContain('curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash -s -- --yes --no-setup');
  expect(verify).toMatchObject({ phase: 'guest', kind: 'checkpoint', manager: 'manual', privilege: 'user', consent: 'explicit' });
  expect(verify?.command?.[2]).toContain('test "$prefix/bin/eln" -ef "$resolved"');
  expect(verify?.command?.[2]).toContain('type -P eln');
  expect(verify?.command?.[2]).toContain('"$prefix/bin/eln" --version');
  expect(plan.operations.findIndex(item => item.id === 'wsl-eln-install'))
    .toBeGreaterThan(plan.operations.findIndex(item => item.id === 'wsl-systemd'));
  expect(plan.operations.findIndex(item => item.id === 'wsl-eln-version-check'))
    .toBeGreaterThan(plan.operations.findIndex(item => item.id === 'wsl-eln-install'));
  expect(buildMachineSetupPlan({ profile: 'default', platform: 'linux' }).operations.some(item => item.id.startsWith('wsl-eln-'))).toBe(false);
});

test('WSL plan reflects the selected distribution in its host install command', () => {
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'wsl', distribution: 'Debian' });
  expect(plan.operations[0]?.command).toEqual(['wsl.exe', '--install', '--distribution', 'Debian', '--no-launch']);
  expect(() => buildMachineSetupPlan({ profile: 'default', platform: 'wsl', distribution: 'Debian;reboot' }))
    .toThrow('WSL distribution name is invalid');
});

test('plan rejects unknown profile or platform', () => {
  expect(() => buildMachineSetupPlan({ profile: 'custom', platform: 'linux' })).toThrow('profile must be');
  expect(() => buildMachineSetupPlan({ profile: 'default', platform: 'windows' })).toThrow('platform must be');
});

test('capture file input is schema-checked and reduced to package inventory only', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-setup-capture-'));
  const path = join(root, 'capture.json');
  try {
    writeFileSync(path, JSON.stringify(capture));
    const loaded = readMachineCaptureForPlan(path);
    const plan = buildMachineSetupPlan({ profile: 'default', platform: 'macos', capture: loaded });
    expect(plan.sample).toBe('machine-capture');
    expect(JSON.stringify(plan)).not.toContain('private-hash');
    writeFileSync(path, JSON.stringify({ ...capture, kind: 'other' }));
    expect(() => readMachineCaptureForPlan(path)).toThrow('capture file is unreadable or is not a machine-capture profile');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture from another platform remains unknown and malformed package rows cannot imply absence', () => {
  const linuxFromMac = buildMachineSetupPlan({ profile: 'default', platform: 'linux', capture });
  expect(linuxFromMac.packages.every(item => item.presence === 'unknown')).toBe(true);
  expect(linuxFromMac.operations.some(item => item.id === 'confirm-unknown-inventory')).toBe(true);

  const damaged = {
    ...capture,
    packages: { ...capture.packages, formulae: null },
  };
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'macos', capture: damaged });
  expect(plan.packages.find(item => item.name === 'neovim')?.presence).toBe('unknown');
  expect(plan.operations.some(item => item.id === 'confirm-unknown-inventory')).toBe(true);
});

test('plain-text plan displays commands, package sets, phase, and privilege', () => {
  const plan = buildMachineSetupPlan({ profile: 'default', platform: 'linux' });
  const output = formatMachineSetupPlan(plan);
  expect(output).toContain('sudo apt-get install --dry-run');
  expect(output).toContain('sudo ·');
  expect(output).toContain('fd-find');
});
