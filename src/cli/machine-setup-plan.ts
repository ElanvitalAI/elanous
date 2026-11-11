import { readFileSync, statSync } from 'node:fs';
import type { Command } from 'commander';

export type MachineSetupPlatform = 'macos' | 'linux' | 'wsl';
export type MachineSetupProfile = 'default' | 'developer' | 'headquarters';

export interface MachineSetupOperation {
  readonly id: string;
  readonly phase: 'host' | 'guest' | 'local';
  readonly kind: 'install' | 'configure' | 'checkpoint' | 'manual';
  readonly manager?: 'brew' | 'apt-get' | 'cargo' | 'wsl.exe' | 'manual';
  readonly packageKind?: 'formula' | 'cask' | 'cargo' | 'manual';
  readonly packages?: readonly string[];
  readonly command?: readonly string[];
  readonly privilege: 'user' | 'sudo' | 'administrator' | 'none';
  readonly consent: 'none' | 'explicit';
  readonly reason: string;
}

export interface MachineSetupPlan {
  readonly schemaVersion: 1;
  readonly kind: 'machine-setup-plan';
  readonly profile: MachineSetupProfile;
  readonly platform: MachineSetupPlatform;
  readonly dryRun: true;
  readonly sample: 'built-in' | 'machine-capture';
  readonly operations: readonly MachineSetupOperation[];
  readonly taps: readonly { readonly name: string; readonly presence: 'would-register' | 'unknown' }[];
  readonly packages: readonly {
    readonly name: string;
    readonly manager: 'brew' | 'apt-get' | 'cargo' | 'manual';
    readonly presence: 'present' | 'would-install' | 'unknown';
    readonly reason: string;
  }[];
  readonly safety: readonly string[];
}

interface PackageChoice {
  readonly name: string;
  readonly brewName?: string;
  readonly manager: 'brew' | 'apt-get' | 'cargo' | 'manual';
  readonly purpose: string;
  readonly profile: MachineSetupProfile;
  readonly platforms?: readonly MachineSetupPlatform[];
}

const PACKAGE_CHOICES: readonly PackageChoice[] = [
  { name: 'build-essential', manager: 'apt-get', purpose: 'native build tools required by WSL developer packages', profile: 'default', platforms: ['linux', 'wsl'] },
  { name: 'curl', manager: 'apt-get', purpose: 'download the verified Elanous installer in WSL', profile: 'default', platforms: ['linux', 'wsl'] },
  { name: 'python3-venv', manager: 'apt-get', purpose: 'Python virtual environments for the WSL developer profile', profile: 'default', platforms: ['linux', 'wsl'] },
  { name: 'unzip', manager: 'apt-get', purpose: 'extract the official Bun bootstrap archive', profile: 'default', platforms: ['linux', 'wsl'] },
  { name: 'zsh', manager: 'brew', purpose: 'Elanous default interactive shell', profile: 'default' },
  { name: 'neovim', manager: 'brew', purpose: 'terminal editor with the captured Neovim config', profile: 'default' },
  { name: 'yazi', manager: 'brew', purpose: 'terminal file manager; the `y` shell shortcut follows in a later apply slice', profile: 'default' },
  { name: 'ripgrep', manager: 'brew', purpose: 'fast recursive text search', profile: 'default' },
  { name: 'fd', manager: 'brew', purpose: 'fast file-name search', profile: 'default' },
  { name: 'fzf', manager: 'brew', purpose: 'interactive fuzzy finder', profile: 'default' },
  { name: 'zoxide', manager: 'brew', purpose: 'quick directory navigation', profile: 'default' },
  { name: 'bat', manager: 'brew', purpose: 'readable terminal file preview', profile: 'default' },
  { name: 'eza', manager: 'brew', purpose: 'modern directory listing', profile: 'default' },
  { name: 'git', manager: 'brew', purpose: 'source control used by the Elanous tool workflow', profile: 'default' },
  { name: 'tailscale', manager: 'brew', purpose: 'private machine networking; login still requires user approval', profile: 'default' },
  { name: 'ghostty', manager: 'brew', purpose: 'Elanous default terminal app', profile: 'default' },
  { name: 'font-jetbrains-mono-nerd-font', manager: 'brew', purpose: 'icon-capable terminal font', profile: 'default' },
  { name: 'font-noto-sans-cjk-kr', manager: 'brew', purpose: 'Korean glyph coverage', profile: 'default' },
  { name: 'oh-my-zsh', manager: 'manual', purpose: 'zsh configuration framework', profile: 'default' },
  { name: 'powerlevel10k', manager: 'brew', purpose: 'Elanous zsh prompt theme', profile: 'default' },
  { name: 'zsh-autosuggestions', manager: 'brew', purpose: 'zsh command suggestions', profile: 'default' },
  { name: 'zsh-syntax-highlighting', manager: 'brew', purpose: 'zsh command syntax feedback', profile: 'default' },
  { name: 'git-delta', manager: 'brew', purpose: 'readable git diffs', profile: 'default' },
  { name: 'gh', manager: 'brew', purpose: 'GitHub command-line workflow', profile: 'developer' },
  { name: 'bun', manager: 'brew', purpose: 'Elanous JavaScript and TypeScript runtime', profile: 'developer' },
  { name: 'node', manager: 'brew', purpose: 'Node.js tool compatibility', profile: 'developer' },
  { name: 'uv', manager: 'brew', purpose: 'Python runtime and package management', profile: 'developer' },
  { name: 'jq', manager: 'brew', purpose: 'JSON inspection', profile: 'developer' },
  { name: 'tmux', manager: 'brew', purpose: 'persistent terminal sessions', profile: 'developer' },
  { name: 'ast-grep', manager: 'brew', purpose: 'syntax-aware code search and rewriting', profile: 'developer' },
  { name: 'deno', manager: 'brew', purpose: 'optional JavaScript and TypeScript runtime', profile: 'developer' },
  { name: 'go', manager: 'brew', purpose: 'Go development runtime', profile: 'developer' },
  { name: 'gradle', manager: 'brew', purpose: 'JVM project build tool', profile: 'developer' },
  { name: 'cocoapods', manager: 'brew', purpose: 'dependency manager for legacy iOS projects', profile: 'developer' },
  { name: 'cargo', manager: 'apt-get', purpose: 'Rust package manager required by the Linux tree-sitter-cli installer', profile: 'developer', platforms: ['linux', 'wsl'] },
  { name: 'tree-sitter-cli', manager: 'brew', purpose: 'parser generation and inspection for developer tooling', profile: 'developer' },
  { name: 'python@3.14', manager: 'brew', purpose: 'explicit Python runtime for scripts and test tooling', profile: 'developer' },
  { name: 'docker-ce', manager: 'apt-get', purpose: 'official Docker Engine for k3d in WSL; skipped when a working Docker Desktop integration is already available', profile: 'developer', platforms: ['wsl'] },
  { name: 'docker-ce-cli', manager: 'apt-get', purpose: 'Docker CLI paired with Docker CE', profile: 'developer', platforms: ['wsl'] },
  { name: 'containerd.io', manager: 'apt-get', purpose: 'container runtime required by Docker CE', profile: 'developer', platforms: ['wsl'] },
  { name: 'docker-buildx-plugin', manager: 'apt-get', purpose: 'Docker Buildx plugin for local image builds', profile: 'developer', platforms: ['wsl'] },
  { name: 'awscli', manager: 'brew', purpose: 'HQ cloud operations client; never copies its credentials', profile: 'headquarters' },
  { name: 'gcloud-cli', manager: 'brew', purpose: 'HQ Google Cloud operations client; never copies its credentials', profile: 'headquarters' },
  { name: 'k3d', manager: 'brew', purpose: 'local Kubernetes clusters for isolated machine exercises', profile: 'headquarters' },
  { name: 'helm', manager: 'brew', purpose: 'Kubernetes release management for headquarters work', profile: 'headquarters' },
  { name: 'packer', brewName: 'hashicorp/tap/packer', manager: 'brew', purpose: 'headquarters machine-image build utility', profile: 'headquarters' },
  { name: 'autossh', manager: 'brew', purpose: 'restart monitoring for long-lived SSH tunnels', profile: 'headquarters' },
  { name: 'lego', manager: 'brew', purpose: 'ACME certificate automation for headquarters operations', profile: 'headquarters' },
];

function brewPackageName(value: string): boolean {
  return /^(?:[A-Za-z0-9][A-Za-z0-9@+._-]*\/){0,2}[A-Za-z0-9][A-Za-z0-9@+._-]*$/.test(value);
}

const APT_NAMES: Readonly<Record<string, string>> = {
  fd: 'fd-find',
  node: 'nodejs',
  go: 'golang-go',
  awscli: 'awscli',
  gradle: 'gradle',
};

function packageRoute(choice: PackageChoice, platform: MachineSetupPlatform): {
  manager: 'brew' | 'apt-get' | 'cargo' | 'manual';
  kind: 'formula' | 'cask' | 'cargo' | 'manual';
  name: string;
} {
  if (choice.manager === 'manual') return { manager: 'manual', kind: 'manual', name: choice.name };
  if (platform === 'macos') return {
    manager: 'brew',
    kind: choice.name === 'ghostty' || choice.name === 'gcloud-cli' || choice.name.startsWith('font-') ? 'cask' : 'formula',
    name: choice.brewName ?? choice.name,
  };
  if (choice.name === 'tree-sitter-cli') return { manager: 'cargo', kind: 'cargo', name: choice.name };
  if (['k3d', 'helm', 'packer', 'autossh', 'lego'].includes(choice.name)) {
    return { manager: 'manual', kind: 'manual', name: choice.brewName ?? choice.name };
  }
  if (choice.name === 'ghostty' || choice.name.startsWith('font-') || choice.name === 'yazi' || choice.name === 'bun' || choice.name === 'uv'
    || choice.name === 'tailscale' || choice.name === 'git-delta' || choice.name === 'powerlevel10k'
    || choice.name === 'eza' || choice.name === 'gh'
    || choice.name === 'gcloud-cli' || choice.name === 'ast-grep' || choice.name === 'cocoapods'
    || choice.name === 'deno' || choice.name === 'python@3.14') return { manager: 'manual', kind: 'manual', name: choice.name };
  return { manager: 'apt-get', kind: 'formula', name: APT_NAMES[choice.name] ?? choice.name };
}

function isPlatform(value: string): value is MachineSetupPlatform {
  return value === 'macos' || value === 'linux' || value === 'wsl';
}

function isProfile(value: string): value is MachineSetupProfile {
  return value === 'default' || value === 'developer' || value === 'headquarters';
}

function capturePackageState(capture: unknown): {
  readonly formulae: ReadonlySet<string>;
  readonly casks: ReadonlySet<string>;
  readonly fontNames: readonly string[];
  readonly formulaeKnown: boolean;
  readonly casksKnown: boolean;
} {
  if (!capture || typeof capture !== 'object') throw new Error('invalid capture profile');
  if ((capture as { kind?: unknown }).kind !== 'machine-capture') throw new Error('invalid capture profile');
  const packages = (capture as { packages?: unknown }).packages;
  if (!packages || typeof packages !== 'object') throw new Error('invalid capture profile');
  const value = packages as Record<string, unknown>;
  const readRows = (rows: unknown): { names: Set<string>; valid: boolean } => {
    if (!Array.isArray(rows)) return { names: new Set(), valid: false };
    const names = new Set<string>();
    let valid = true;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof (row as { name?: unknown }).name !== 'string'
        || !brewPackageName((row as { name: string }).name)) {
        valid = false;
        continue;
      }
      names.add((row as { name: string }).name);
    }
    return { names, valid };
  };
  const formulae = readRows(value.formulae);
  const casks = readRows(value.casks);
  const fonts = (capture as { fonts?: unknown }).fonts;
  const fontNames = fonts && typeof fonts === 'object' && Array.isArray((fonts as { names?: unknown }).names)
    ? (fonts as { names: unknown[] }).names.flatMap(font => font && typeof font === 'object'
      && typeof (font as { name?: unknown }).name === 'string' ? [(font as { name: string }).name] : [])
    : [];
  return {
    formulae: formulae.names,
    casks: casks.names,
    fontNames,
    formulaeKnown: value.formulaeStatus === 'captured' && formulae.valid,
    casksKnown: value.casksStatus === 'captured' && casks.valid,
  };
}

function capturedFontCovers(cask: string, names: readonly string[]): boolean {
  const needles: Readonly<Record<string, readonly string[]>> = {
    'font-jetbrains-mono-nerd-font': ['jetbrainsmononerd'],
    'font-noto-sans-cjk-kr': ['notosanscjkkr'],
    'font-noto-emoji': ['notoemoji', 'notocoloremoji'],
    'font-terminess-ttf-nerd-font': ['terminessnerd'],
  };
  const expected = needles[cask];
  return !!expected?.some(needle => names.some(name => name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle)));
}

function capturedPackageMatch(name: string, rows: ReadonlySet<string>): { readonly name?: string; readonly ambiguous: boolean } {
  if (rows.has(name)) return { name, ambiguous: false };
  const aliases = [...rows].filter(candidate => candidate.endsWith(`/${name}`));
  return aliases.length === 1 ? { name: aliases[0], ambiguous: false } : { ambiguous: aliases.length > 1 };
}

function captureTapInventory(capture: unknown): { readonly taps: readonly string[]; readonly known: boolean } {
  if (!capture || typeof capture !== 'object') return { taps: [], known: false };
  const packages = (capture as { packages?: unknown }).packages;
  if (!packages || typeof packages !== 'object') return { taps: [], known: false };
  const value = packages as Record<string, unknown>;
  if (value.tapsStatus !== 'captured' || !Array.isArray(value.taps)) return { taps: [], known: false };
  const taps: string[] = [];
  for (const name of value.taps) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      return { taps: [], known: false };
    }
    if (!taps.includes(name)) taps.push(name);
  }
  return { taps: taps.sort(), known: true };
}

export function buildMachineSetupPlan(input: {
  readonly profile: string;
  readonly platform: string;
  readonly capture?: unknown;
  readonly sourceCapture?: unknown;
  readonly distribution?: string;
}): MachineSetupPlan {
  if (!isProfile(input.profile)) throw new Error('profile must be default, developer, or headquarters');
  if (!isPlatform(input.platform)) throw new Error('platform must be macos, linux, or wsl');
  const { profile, platform } = { profile: input.profile, platform: input.platform };
  const distribution = input.distribution ?? 'Ubuntu';
  if (platform === 'wsl' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(distribution)) {
    throw new Error('WSL distribution name is invalid');
  }
  const captured = input.capture ? capturePackageState(input.capture) : undefined;
  const tapCapture = input.sourceCapture ?? input.capture;
  const capturedTaps = tapCapture ? captureTapInventory(tapCapture) : undefined;
  const capturePlatform = input.capture && typeof input.capture === 'object'
    ? (input.capture as { platform?: unknown }).platform : undefined;
  const captureMatchesTarget = capturePlatform === (platform === 'macos' ? 'darwin' : 'linux');
  const profileChoices = PACKAGE_CHOICES.filter((choice) => (!choice.platforms || choice.platforms.includes(platform))
    && (choice.profile === 'default'
    || profile === 'developer' && choice.profile === 'developer'
    || profile === 'headquarters' && (choice.profile === 'developer' || choice.profile === 'headquarters')));
  const selected = profileChoices.filter(choice => !(platform === 'wsl' && choice.name === 'ghostty'));
  const packages = selected.map((choice) => {
    const route = packageRoute(choice, platform);
    const manager = route.manager;
    const selectedName = choice.brewName ?? choice.name;
    const routeRows = captured && captureMatchesTarget && route.manager === 'brew'
      ? route.kind === 'cask' ? captured.casks : captured.formulae
      : undefined;
    const capturedMatch = routeRows ? capturedPackageMatch(choice.name, routeRows) : undefined;
    const name = manager === 'brew' && capturedMatch?.name && !choice.brewName ? capturedMatch.name : route.name;
    let presence: 'present' | 'would-install' | 'unknown' = 'would-install';
    if (captured) {
      if (!captureMatchesTarget) presence = 'unknown';
      else {
        const isCask = route.kind === 'cask';
        const rows = isCask ? captured.casks : captured.formulae;
        const known = isCask ? captured.casksKnown : captured.formulaeKnown;
        const exactPresent = rows.has(name) || !choice.brewName && capturedMatch?.name === name;
        const conflictingAlias = capturedMatch?.ambiguous === true
          || !!choice.brewName && (rows.has(choice.name) || !!capturedMatch?.name && capturedMatch.name !== selectedName);
        presence = exactPresent || isCask && capturedFontCovers(choice.name, captured.fontNames)
          ? 'present' : conflictingAlias ? 'unknown' : known ? 'would-install' : 'unknown';
      }
    }
    return { name, manager, presence, reason: choice.purpose };
  });
  const operations: MachineSetupOperation[] = [];
  if (platform === 'macos') operations.push({ id: 'brew-preflight', phase: 'local', kind: 'manual', manager: 'manual', privilege: 'user', consent: 'explicit', reason: 'Check Homebrew; if absent, install it through the official interactive installer before applying this plan.' });
  const taps = platform === 'macos' && capturedTaps?.known
    ? capturedTaps.taps.map(name => ({ name, presence: 'would-register' as const }))
    : [];
  if (platform === 'macos' && tapCapture && !capturedTaps?.known) {
    operations.push({ id: 'confirm-tap-inventory', phase: 'local', kind: 'manual', manager: 'manual', privilege: 'user', consent: 'explicit', reason: 'Captured Homebrew tap inventory is incomplete; recapture and confirm repositories before applying packages.' });
  }
  for (const tap of taps) {
    operations.push({ id: `brew-tap-${tap.name.replace('/', '-')}`, phase: 'local', kind: 'configure', manager: 'brew', command: ['brew', 'tap', tap.name], privilege: 'user', consent: 'explicit', reason: 'Register a repository captured from the source machine before installing its packages.' });
  }
  if (platform === 'wsl') {
    operations.push(
      { id: 'wsl-install', phase: 'host', kind: 'install', manager: 'wsl.exe', command: ['wsl.exe', '--install', '--distribution', distribution, '--no-launch'], privilege: 'administrator', consent: 'explicit', reason: `Create the ${distribution} WSL distribution without launching its first-run prompt; a Windows reboot may be required.` },
      { id: 'wsl-reboot-checkpoint', phase: 'host', kind: 'checkpoint', manager: 'manual', privilege: 'none', consent: 'explicit', reason: 'Pause after Windows requests a reboot; resume setup after the new distribution is initialized.' },
      { id: 'wsl-systemd', phase: 'guest', kind: 'configure', manager: 'manual', privilege: 'none', consent: 'explicit', reason: 'Enable systemd in /etc/wsl.conf as the WSL root user; no guest password or sudo prompt is required.' },
      { id: 'wsl-eln-install', phase: 'guest', kind: 'install', manager: 'manual', command: ['bash', '-lc', 'set -o pipefail; curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash -s -- --yes --no-setup'], privilege: 'user', consent: 'explicit', reason: 'Install the latest eln release inside the selected WSL guest after its first-run setup.' },
      { id: 'wsl-eln-version-check', phase: 'guest', kind: 'checkpoint', manager: 'manual', command: ['bash', '-lc', 'prefix="${XDG_DATA_HOME:-$HOME/.local/share}/elanous"; test -x "$prefix/bin/eln" && resolved="$(type -P eln)" && test "$prefix/bin/eln" -ef "$resolved" && "$prefix/bin/eln" --version'], privilege: 'user', consent: 'explicit', reason: 'Verify eln resolves to the installer-owned guest path and reports that installed version before continuing the profile.' },
    );
    if (profile === 'developer' || profile === 'headquarters') {
      operations.push(
        { id: 'wsl-docker-engine', phase: 'guest', kind: 'configure', manager: 'wsl.exe', command: ['docker', 'info'], privilege: 'none', consent: 'explicit', reason: 'Use a working Docker API engine if already available (including Docker Desktop WSL integration); otherwise install Docker CE and enable its systemd service as WSL root. k3d documents Podman support as experimental; rootless Podman also needs a user socket, linger, DOCKER_HOST, and a Podman-specific registry network (https://k3d.io/v5.8.3/usage/advanced/podman/).'},
        { id: 'wsl-k3d-install', phase: 'guest', kind: 'install', manager: 'wsl.exe', command: ['k3d'], privilege: 'none', consent: 'explicit', reason: 'Install k3d with its official installer as WSL root after the container engine responds, then verify its CLI.' },
      );
    }
  }
  if (platform !== 'macos') operations.push({ id: `${platform}-apt-refresh`, phase: platform === 'wsl' ? 'guest' : 'local', kind: 'configure', manager: 'apt-get', command: platform === 'wsl' ? ['apt-get', 'update'] : ['sudo', 'apt-get', 'update'], privilege: platform === 'wsl' ? 'none' : 'sudo', consent: 'explicit', reason: platform === 'wsl' ? 'Refresh package metadata through the WSL root execution boundary; no sudo prompt is required.' : 'Refresh package metadata before any package installation is applied.' });
  if (platform !== 'macos' && selected.some((choice) => choice.name === 'tailscale')) operations.push({ id: 'tailscale-repository-preflight', phase: platform === 'wsl' ? 'guest' : 'local', kind: 'manual', manager: 'manual', privilege: 'sudo', consent: 'explicit', reason: 'Tailscale uses its official distribution repository; verify that repository and package source before applying its install step.' });
  if (platform !== 'macos' && selected.some((choice) => choice.name === 'gh')) operations.push({ id: 'gh-source-preflight', phase: platform === 'wsl' ? 'guest' : 'local', kind: 'manual', manager: 'manual', privilege: 'sudo', consent: 'explicit', reason: 'GitHub CLI install sources vary by distribution; verify the approved package source before applying its install step.' });
  if (packages.some((item) => item.presence === 'unknown')) operations.push({ id: 'confirm-unknown-inventory', phase: platform === 'wsl' ? 'guest' : 'local', kind: 'manual', manager: 'manual', privilege: 'user', consent: 'explicit', reason: 'Some capture inventories are unavailable or belong to another platform; inspect and confirm those packages before applying a plan.' });
  const packageOperations: MachineSetupOperation[] = [];
  for (const item of packages) {
    if (item.presence === 'present' || item.presence === 'unknown') continue;
    const choice = selected.find((candidate) => (packageRoute(candidate, platform).name === item.name
      || candidate.name === item.name.split('/').at(-1)) && packageRoute(candidate, platform).manager === item.manager)!;
    const route = packageRoute(choice, platform);
    const hostOnly = platform === 'wsl' && (choice.name === 'ghostty' || choice.name.startsWith('font-'));
    const phase = hostOnly ? 'host' : platform === 'wsl' ? 'guest' : 'local';
    const { manager, kind } = route;
    const name = item.name;
    packageOperations.push({
      id: `${platform}-${manager}-${name.replaceAll('/', '-')}`,
      phase,
      kind: 'install',
      manager: manager as MachineSetupOperation['manager'],
      packageKind: kind,
      packages: [name],
      ...(manager === 'apt-get' ? { command: platform === 'wsl' ? ['apt-get', 'install', '--dry-run', name] : ['sudo', 'apt-get', 'install', '--dry-run', name] } : {}),
      ...(manager === 'brew' ? { command: ['brew', 'install', ...(kind === 'cask' ? ['--cask'] : []), name] } : {}),
      ...(manager === 'cargo' ? { command: ['cargo', 'install', '--locked', name] } : {}),
      privilege: manager === 'apt-get' ? platform === 'wsl' ? 'none' : 'sudo' : manager === 'manual' ? 'none' : 'user',
      consent: manager === 'manual' ? 'explicit' : 'none',
      reason: manager === 'manual'
        ? `Source-specific or manually reviewed packages from the ${profile} profile; confirm their installer before apply.`
        : `Planned ${manager} packages from the ${profile} profile; this command is descriptive and is not executed by setup plan.`,
    });
  }
  operations.push(...packageOperations.filter((operation) => operation.phase !== 'host'));
  if (selected.some((choice) => choice.name === 'tailscale')) {
    operations.push({ id: 'tailscale-login', phase: platform === 'wsl' ? 'guest' : 'local', kind: 'manual', manager: 'manual', privilege: 'user', consent: 'explicit', reason: 'Tailscale login is a user-approved step; this plan never starts login or copies an auth key.' });
  }
  if (selected.some((choice) => choice.name === 'yazi')) {
    operations.push({ id: 'yazi-shell-shortcut', phase: platform === 'wsl' ? 'guest' : 'local', kind: 'manual', manager: 'manual', privilege: 'user', consent: 'explicit', reason: 'Configure the documented `y` shell wrapper after the selected shell is installed.' });
  }
  if (platform === 'wsl') {
    operations.push(...packageOperations.filter((operation) => operation.phase === 'host'));
    operations.push({ id: 'wsl-terminal-fonts', phase: 'host', kind: 'manual', manager: 'manual', privilege: 'user', consent: 'explicit', reason: 'After guest setup, install terminal font assets and apply Windows Terminal settings in a later apply slice.' });
  }
  return {
    schemaVersion: 1,
    kind: 'machine-setup-plan',
    profile,
    platform,
    dryRun: true,
    sample: captured || tapCapture ? 'machine-capture' : 'built-in',
    operations,
    taps,
    packages,
    safety: [
      'Planning only: no package manager, shell, network, or privileged command is executed.',
      'Machine capture contributes package names and capture status only; dotfile hashes, fonts, and credential values are not copied into the plan.',
      profile !== 'headquarters' ? 'The selected profile excludes headquarters-only cloud clients and credentials.' : 'HQ clients are install-only; credentials remain owned by eln cred and are never copied.',
    ],
  };
}

export function readMachineCaptureForPlan(path: string): unknown {
  try {
    if (statSync(path).size > 5 * 1024 * 1024) throw new Error('oversized');
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'machine-capture') throw new Error('wrong kind');
    return value;
  } catch {
    throw new Error('capture file is unreadable or is not a machine-capture profile');
  }
}

export function registerMachineSetupPlanCommand(command: Command): void {
  command
    .option('--profile <profile>', 'default, developer, or headquarters', 'default')
    .requiredOption('--platform <platform>', 'macos, linux, or wsl')
    .option('--capture <file>', 'optional machine capture JSON used only to mark known installed packages')
    .option('--json', 'structured dry-run plan')
    .action((options: { profile: string; platform: string; capture?: string; json?: boolean }) => {
      try {
        const plan = buildMachineSetupPlan({ profile: options.profile, platform: options.platform,
          ...(options.capture ? { capture: readMachineCaptureForPlan(options.capture) } : {}) });
        console.log(options.json ? JSON.stringify(plan, null, 2) : formatMachineSetupPlan(plan));
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'machine setup plan failed');
        process.exitCode = 1;
      }
    });
}

export function formatMachineSetupPlan(plan: MachineSetupPlan): string {
  const lines = [`machine setup plan · ${plan.profile} · ${plan.platform} · dry-run`, 'Taps:'];
  for (const tap of plan.taps) lines.push(`  ${tap.presence.padEnd(13)} brew ${tap.name} — register before package installs`);
  lines.push('Packages:');
  for (const item of plan.packages) lines.push(`  ${item.presence.padEnd(13)} ${item.manager} ${item.name} — ${item.reason}`);
  lines.push('Operations:');
  for (const operation of plan.operations) {
    const details = [operation.phase, operation.manager, operation.privilege, operation.packages?.join(', '), operation.command?.join(' ')].filter(Boolean).join(' · ');
    lines.push(`  ${operation.id} · ${operation.kind} · ${details} · ${operation.reason}`);
  }
  return lines.join('\n');
}
