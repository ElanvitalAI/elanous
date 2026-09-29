export interface GitInstallPlan {
  command: string[] | null;
  display: string;
  needsSudo: boolean;
  note?: string;
  /** Commands run before `command`, in order (e.g. `apt-get update` — a fresh image has empty package lists). */
  preCommands?: string[][];
  /** The command only starts an installer UI and returns at once (macOS `xcode-select --install`): wait until git appears. */
  waitForGit?: boolean;
}

/** Only known package managers are executable; unknown hosts get a manual download link. */
export function gitInstallPlan({ platform, distro, has, isRoot = false }: {
  platform: NodeJS.Platform;
  distro?: string;
  has: (name: string) => boolean;
  /** Root (uid 0 — containers) runs the package manager directly; sudo is often not installed there. */
  isRoot?: boolean;
}): GitInstallPlan {
  const manual: GitInstallPlan = { command: null, display: 'Git 설치: https://git-scm.com/downloads', needsSudo: false };
  if (platform === 'darwin') {
    // brew finishes in the terminal; xcode-select only opens Apple's installer window and returns immediately.
    if (has('brew')) return { command: ['brew', 'install', 'git'], display: 'brew install git', needsSudo: false };
    if (has('xcode-select')) return { command: ['xcode-select', '--install'], display: 'xcode-select --install', needsSudo: false, waitForGit: true, note: '설치 안내 창에서 «설치»를 누르면 끝날 때까지 기다린다.' };
    return manual;
  }
  if (platform === 'win32') {
    return has('winget')
      ? { command: ['winget', 'install', '--id', 'Git.Git', '-e', '--source', 'winget'], display: 'winget install --id Git.Git -e --source winget', needsSudo: false }
      : manual;
  }
  if (platform !== 'linux') return manual;
  const family = distro?.toLowerCase();
  const manager = family === 'debian' || family === 'ubuntu' ? 'apt-get'
    : family === 'fedora' || family === 'rhel' || family === 'amzn2023' ? 'dnf'
      : family === 'arch' ? 'pacman' : family === 'alpine' ? 'apk' : null;
  if (!manager || !has(manager)) return manual;
  if (!isRoot && !has('sudo')) return manual;
  const prefix = isRoot ? [] : ['sudo'];
  const install = manager === 'pacman' ? [manager, '-S', '--noconfirm', 'git']
    : manager === 'apk' ? [manager, 'add', 'git']
      : [manager, 'install', '-y', 'git'];
  const command = [...prefix, ...install];
  const preCommands = manager === 'apt-get' ? [[...prefix, 'apt-get', 'update']] : undefined;
  return {
    command,
    display: [...(preCommands ?? []).map((pre) => pre.join(' ')), command.join(' ')].join(' && '),
    needsSudo: !isRoot,
    ...(preCommands ? { preCommands } : {}),
  };
}
