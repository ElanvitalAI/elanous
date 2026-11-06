'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { chmodSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

function fixSpawnHelper(root = join(__dirname, '..')) {
  if (process.platform === 'win32') return;
  try {
    const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds');
    for (const platform of readdirSync(prebuilds)) {
      const helper = join(prebuilds, platform, 'spawn-helper');
      try { chmodSync(helper, 0o755); } catch { /* missing optional prebuild */ }
    }
  } catch { /* node-pty is optional */ }
}

function shouldSkip(env = process.env) {
  return env.npm_config_global !== 'true'
    || env.ELANOUS_SKIP_POSTINSTALL === '1'
    || Boolean(env.CI && env.CI !== 'false' && env.CI !== '0')
    || env.npm_config_offline === 'true'
    || env.NPM_CONFIG_OFFLINE === 'true'
    || env.npm_config_online === 'false'
    || env.NPM_CONFIG_ONLINE === 'false';
}

function killProcessTree(child, platform = process.platform, kill = process.kill, run = spawnSync) {
  // Known limit: if both Windows tree-kill tools are unavailable or blocked, Node can only kill the launcher process; see install.md.
  if (platform !== 'win32' && child.pid) kill(-child.pid, 'SIGKILL');
  else if (platform === 'win32' && child.pid) {
    let result;
    try { result = run('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); }
    catch { result = { error: true, status: 1 }; }
    if (result.error || result.status !== 0) {
      const script = `$ErrorActionPreference='Stop';$p=${Number(child.pid)};$all=Get-CimInstance Win32_Process;$ids=@($p);$front=@($p);while($front.Count){$next=@($all|Where-Object{$front -contains [int]$_.ParentProcessId}|ForEach-Object{[int]$_.ProcessId});$ids+= $next;$front=$next};[array]::Reverse($ids);foreach($id in $ids){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}`;
      let fallback;
      try { fallback = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); }
      catch { fallback = { error: true, status: 1 }; }
      if (fallback.error || fallback.status !== 0) try { child.kill('SIGKILL'); } catch { /* best-effort, caller always stops waiting */ }
    }
  } else child.kill('SIGKILL');
}

/** npm lifecycle is best-effort; launcher retries when the version marker is absent. */
function runPostinstall(env = process.env, run = spawn, timeoutMs = 10 * 60 * 1000, terminate = killProcessTree) {
  fixSpawnHelper();
  if (shouldSkip(env)) return 0;
  try {
    const child = run(process.execPath, [join(__dirname, '..', 'bin', 'elanous.cjs'), 'bootstrap'], {
      stdio: 'ignore',
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...env, ELANOUS_INSTALL_YES: '1' },
    });
    const timeout = setTimeout(() => {
      try { terminate(child); } catch { /* best-effort tree termination */ }
      finally { clearTimeout(timeout); child.unref?.(); }
    }, timeoutMs);
    child.once('exit', () => clearTimeout(timeout));
    child.once('error', () => clearTimeout(timeout));
    child.unref?.();
  } catch { /* first `eln` will retry without making npm installation fail */ }
  return 0;
}

if (require.main === module) process.exitCode = runPostinstall();
module.exports = { fixSpawnHelper, killProcessTree, runPostinstall, shouldSkip };
