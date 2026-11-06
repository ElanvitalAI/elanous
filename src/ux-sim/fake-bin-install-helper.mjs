import {
  closeSync,
  constants,
  fchmodSync,
  openSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dlopen } from 'bun:ffi';

const [configPath, ...actualArgv] = process.argv.slice(2);
const fds = new Set();
const fail = (message, status) => {
  process.stderr.write(`fake-bin installer: ${message}\n`);
  process.exitCode = status;
};
const muslArch = ({ x64: 'x86_64', arm64: 'aarch64', arm: 'armhf', ppc64: 'powerpc64le', s390x: 's390x' })[process.arch] || process.arch;
const libraryCandidates = process.platform === 'linux'
  ? ['/lib/libc.musl-' + muslArch + '.so.1', '/lib/ld-musl-' + muslArch + '.so.1', 'libc.so.6']
  : ['/usr/lib/libSystem.B.dylib'];
let nativeSymbols;
let lastLoadError;
for (const library of libraryCandidates) {
  try {
    nativeSymbols = dlopen(library, {
      openat: { args: ['i32', 'cstring', 'i32', 'u32'], returns: 'i32' },
      mkdirat: { args: ['i32', 'cstring', 'u32'], returns: 'i32' },
    }).symbols;
    break;
  } catch (error) { lastLoadError = error; }
}
if (!nativeSymbols) {
  process.stderr.write(`fake-bin installer: no compatible C library exposes openat/mkdirat: ${lastLoadError?.message ?? String(lastLoadError)}\n`);
  process.exit(74);
}
const { openat, mkdirat } = nativeSymbols;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const symlinkProbeFlags = constants.O_RDONLY | constants.O_DIRECTORY;

// Threat model: this is a test-only installer fixture; dirfd/O_NOFOLLOW blocks path and symlink escapes.
// Hostile same-UID concurrent directory rename is excluded because POSIX cannot pin a directory name.

function openChildDirectory(parentFd, name) {
  let childFd = openat(parentFd, name, directoryFlags, 0);
  if (childFd >= 0) return childFd;

  const existingDirectory = openat(parentFd, name, symlinkProbeFlags, 0);
  if (existingDirectory >= 0) {
    closeSync(existingDirectory);
    throw Object.assign(new Error('symlink path refused'), { deviceStatus: 73 });
  }

  if (mkdirat(parentFd, name, 0o700) !== 0) throw Object.assign(new Error('directory create failed'), { deviceStatus: 74 });
  childFd = openat(parentFd, name, directoryFlags, 0);
  if (childFd < 0) throw Object.assign(new Error('directory open failed'), { deviceStatus: 74 });
  return childFd;
}

try {
  const config = JSON.parse((await import('node:fs')).readFileSync(configPath, 'utf8'));
  if (actualArgv.length !== config.argv.length || actualArgv.some((arg, index) => arg !== config.argv[index])) {
    fail('unexpected installer argv', 64);
  } else if (process.env[config.prefixEnv] !== config.prefix) {
    fail('install prefix mismatch', 78);
  } else if (config.exitCode !== 0) {
    process.exitCode = config.exitCode;
  } else {
    let prefixFd = openSync('/', directoryFlags);
    fds.add(prefixFd);
    for (const component of config.prefix.slice(1).split('/').filter(Boolean)) {
      const nextFd = openChildDirectory(prefixFd, component);
      fds.add(nextFd);
      closeSync(prefixFd);
      fds.delete(prefixFd);
      prefixFd = nextFd;
    }

    if (config.testBarrier === true) {
      writeSync(3, Buffer.from('ready\n'));
      const release = Buffer.alloc(1);
      if (readSync(4, release, 0, 1, null) !== 1) throw Object.assign(new Error('test barrier closed'), { deviceStatus: 74 });
    }

    for (const artifact of config.files) {
      const components = artifact.path.split('/');
      let directoryFd = prefixFd;
      const ownedFds = [];
      for (const component of components.slice(0, -1)) {
        directoryFd = openChildDirectory(directoryFd, component);
        fds.add(directoryFd);
        ownedFds.push(directoryFd);
      }
      const fileFd = openat(directoryFd, components.at(-1),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        artifact.mode ?? 0o755);
      if (fileFd < 0) throw Object.assign(new Error('artifact path refused'), { deviceStatus: 73 });
      fds.add(fileFd);
      writeFileSync(fileFd, artifact.contents, 'utf8');
      fchmodSync(fileFd, artifact.mode ?? 0o755);
      closeSync(fileFd);
      fds.delete(fileFd);
      for (const fd of ownedFds.reverse()) {
        closeSync(fd);
        fds.delete(fd);
      }
    }
  }
} catch (error) {
  if (process.exitCode !== undefined) {
    // Keep a prior explicit argv or prefix rejection status.
  } else {
    fail(error?.deviceStatus === 73 ? 'symlink or existing artifact refused' : 'install artifact write failed', error?.deviceStatus ?? 74);
  }
} finally {
  for (const fd of fds) {
    try { closeSync(fd); } catch { /* Already closed. */ }
  }
}
