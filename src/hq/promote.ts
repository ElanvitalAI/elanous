// HQ promotion runbook: read-only preview by default; all remote mutations are behind --apply.
import { spawnSync } from 'node:child_process';
import { getUserConfig } from '../user-config.js';
import { parseLease, sshLeaseStore, defaultSshRunner, localShellRunner } from './lease.js';

export interface PromoteRunner {
  lease(): { holder: string | null; generation: number | null; expired: boolean };
  run(host: string, script: string): { status: number | null; stdout: string; stderr: string };
}

export interface PromoteLine { step: string; status: 'ready' | 'done' | 'failed'; measurement: string; command: string }
export interface PromoteResult { ok: boolean; apply: boolean; host: string; lines: PromoteLine[] }

const install = '"$HOME/.local/share/elanous/current/node_modules/elanous"';
const state = '"$HOME/.elanous-hqstate"';
const cli = 'elanous';
// A bind to the same address as nexus distinguishes an available socket from an
// occupied or uninspectable one; lsof's exit 1 alone cannot make that distinction.
const portProbe = `command -v lsof >/dev/null || { echo 'lsof unavailable' >&2; exit 1; }
python3 -c 'import os,socket,subprocess,sys; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); r=subprocess.run(["lsof","-nP","-t","-iTCP:"+str(s.getsockname()[1]),"-sTCP:LISTEN"],capture_output=True,text=True); s.close(); sys.exit(0 if r.returncode == 0 and r.stdout.strip() == str(os.getpid()) else "lsof control listener unreadable: "+r.stderr.strip())' || exit 1
port_detail=$(lsof -nP -t -iTCP:31416 -sTCP:LISTEN 2>&1); port_rc=$?
if [ "$port_rc" -ne 1 ] || [ -n "$port_detail" ]; then echo "port=31416 occupied or unreadable: $port_detail (lsof=$port_rc)" >&2; exit 1; fi
python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 31416)); s.close(); print("port=31416 available")'`;
// The drill uses short SSH aliases; host-local hq.hostName may use either the short or full name.
const hostNamesFor = (host: string): string[] => host === 'node-b' ? ['node-b', 'MacStudioB1']
  : host === 'mbp' ? ['mbp', 'MacBookProM5'] : [host];
const checks: Array<[string, string]> = [
  ['PWA build', `test -f "$HOME/.local/share/elanous/current/node_modules/elanous/apps/pwa/out/index.html" && echo 'index.html present'`],
  ['MCP list', `set -o pipefail; codex mcp list --json | python3 -c 'import json,sys; data=json.load(sys.stdin); print("MCP entries="+str(len(data)))'`],
  ['installed hq', `${cli} hq promote --help >/dev/null && python3 -c 'import json,pathlib; p=pathlib.Path.home()/".elanous-hqcfg/config.json"; print("host="+json.loads(p.read_text())["hq"]["hostName"])'`],
];
const stages: Array<[string, string]> = [
  ['standby checksums', `cd ${install} && bun -e 'import("node:fs/promises").then(async ({ readlink }) => { const root = process.env.HOME + "/.elanous-standby"; const generations = { core: await readlink(root + "/core/latest"), big: await readlink(root + "/big/latest") }; const { verifyStandby } = await import("./scripts/hq/standby-verify.ts"); const result = await verifyStandby({ root, tiers: ["core", "big"], generations }); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1 }).catch(error => { console.error(error); process.exitCode = 1 })'`],
  ['copy to promotion universe', `python3 - <<'PY'
import hashlib, json, os, pathlib, shutil, tempfile
home = pathlib.Path.home()
standby = home / '.elanous-standby'
target = home / '.elanous-hqstate'
parent = target.parent
stage = pathlib.Path(tempfile.mkdtemp(prefix='.elanous-hqstate-promote-', dir=parent))
backup = None
try:
    copied = 0
    for tier in ('core', 'big'):
        generation = os.environ['HQ_PROMOTE_' + tier.upper()]
        source = standby / tier / generation
        if not source.is_dir() or source.is_symlink():
            raise ValueError('missing or symlinked pinned generation: ' + tier)
        manifest_bytes = (source / 'MANIFEST.json').read_bytes()
        expected_manifest = os.environ['HQ_PROMOTE_' + tier.upper() + '_MANIFEST_SHA256']
        if hashlib.sha256(manifest_bytes).hexdigest() != expected_manifest:
            raise ValueError('verified manifest changed: ' + tier)
        manifest = json.loads(manifest_bytes)
        if manifest['tier'] != tier or manifest['generation'] != generation:
            raise ValueError('generation changed: ' + tier)
        for entry in manifest['entries']:
            name = entry['path']
            rel = pathlib.PurePosixPath(name)
            if not name or rel.is_absolute() or '..' in rel.parts or name.startswith('./') or chr(92) in name or name in ('MANIFEST.json', 'SHA256SUMS'):
                raise ValueError('invalid manifest path: ' + name)
            src = source
            for part in rel.parts:
                src = src / part
                if src.is_symlink():
                    raise ValueError('symlinked source: ' + name)
            if not src.is_file():
                raise ValueError('missing source: ' + name)
            dest = stage / name
            if dest.parent.is_symlink():
                raise ValueError('symlinked destination parent: ' + name)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.is_symlink():
                raise ValueError('symlinked destination: ' + name)
            shutil.copy2(src, dest)
            digest = hashlib.sha256(dest.read_bytes()).hexdigest()
            if digest != entry['sha256']:
                raise ValueError('checksum changed during copy: ' + name)
            copied += 1
        if hashlib.sha256((source / 'MANIFEST.json').read_bytes()).hexdigest() != expected_manifest:
            raise ValueError('verified manifest changed during copy: ' + tier)
    for tier in ('core', 'big'):
        source = standby / tier / os.environ['HQ_PROMOTE_' + tier.upper()]
        expected_manifest = os.environ['HQ_PROMOTE_' + tier.upper() + '_MANIFEST_SHA256']
        if hashlib.sha256((source / 'MANIFEST.json').read_bytes()).hexdigest() != expected_manifest:
            raise ValueError('verified manifest changed before promotion: ' + tier)
    if not (stage / 'release/features.sqlite').is_file() or not (stage / 'config.json').is_file():
        raise ValueError('core promotion files missing')
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        raise ValueError('promotion target is not a directory')
    if target.exists():
        backup = pathlib.Path(tempfile.mkdtemp(prefix='.elanous-hqstate-old-', dir=parent))
        backup.rmdir()
        target.rename(backup)
    try:
        stage.rename(target)
    except BaseException:
        if backup is not None:
            backup.rename(target)
            backup = None
        raise
    bytes_count = sum(p.stat().st_size for p in target.rglob('*') if p.is_file())
    if backup is not None:
        shutil.rmtree(backup)
        backup = None
    print('promotion files=' + str(copied) + ' bytes=' + str(bytes_count) + 'B')
finally:
    if stage.exists():
        shutil.rmtree(stage)
PY`],
  ['target hq config', `python3 - <<'PY'
import json, os, pathlib, tempfile
source = pathlib.Path.home() / '.elanous-hqcfg/config.json'
target = pathlib.Path.home() / '.elanous-hqstate/config.json'
with source.open() as f: hq = json.load(f)['hq']
with target.open() as f: config = json.load(f)
assert isinstance(hq, dict) and hq.get('hostName') == os.environ['HQ_PROMOTE_HOST'], 'host-specific hq config mismatch'
config['hq'] = hq
with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, prefix='config.promote-', delete=False) as f:
    tmp = pathlib.Path(f.name)
    json.dump(config, f)
    f.write(chr(10))
try:
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)
finally:
    tmp.unlink(missing_ok=True)
print('hq.hostName=' + hq['hostName'])
PY`],
  ['nexus health', `command -v lsof >/dev/null || { echo 'lsof unavailable: cannot identify nexus listener' >&2; exit 1; }
${portProbe} || { echo 'port=31416 already occupied or unreadable' >&2; exit 1; }
ELANOUS_STATE_DIR=${state} ${cli} --config-dir ${state} nexus run --port 31416 --http-host 127.0.0.1 --no-mcp --no-auto-build --no-auto-install --no-auto-restart --no-watch > "$HOME/.elanous-hqstate/nexus-promote.log" 2>&1 & pid=$!
descendants() {
  for child in $(pgrep -P "$1" 2>/dev/null); do descendants "$child"; echo "$child"; done
}
cleanup() {
  tree=$(descendants "$pid")
  for proc in $tree; do kill "$proc" 2>/dev/null || true; done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  n=0
  until ${portProbe} >/dev/null 2>&1; do
    if [ "$n" -ge 10 ]; then echo 'port=31416 still occupied after cleanup' >&2; return 1; fi
    n=$((n+1)); sleep 1
  done
  echo 'nexus stopped port=31416 released' >&2
}
trap 'cleanup' EXIT
n=0
code=000
owner=''
owned=0
while [ "$n" -lt 15 ]; do
  code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:31416/v1/health) || code=000
  listeners=$(lsof -nP -t -iTCP:31416 -sTCP:LISTEN 2> /dev/null) || listeners=''
  owner=$(printf '%s\\n' "$listeners" | head -n 1)
  ancestor=$owner
  owned=0
  while [ -n "$ancestor" ] && [ "$ancestor" != 1 ]; do
    if [ "$ancestor" = "$pid" ]; then owned=1; break; fi
    ancestor=$(ps -o ppid= -p "$ancestor" | tr -d '[:space:]')
  done
  if [ "$code" = 200 ] && [ "$owned" = 1 ] && [ "$listeners" = "$owner" ] && kill -0 "$pid" 2>/dev/null; then
    trap - EXIT
    echo "health=$code port=31416 pid=$pid listener_pid=$owner"; exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  n=$((n+1)); sleep 2
done
echo "health=$code port=31416 nexus_pid=$pid listener_pid=$owner owned=$owned" >&2; exit 1`],
  ['steward rescue', `ELANOUS_STATE_DIR=${state} ${cli} --config-dir ${state} steward mode rescue && ELANOUS_STATE_DIR=${state} ${cli} --config-dir ${state} steward mode --json`],
];

// One --apply per target host: stages run as separate ssh calls, so the lock is a directory that outlives each call.
const lockDir = '"$HOME/.elanous-hq/promote.lock"';
export const promoteLockAcquire = `mkdir -p "$HOME/.elanous-hq" && if mkdir ${lockDir} 2>/dev/null; then printf '%s %s\\n' "$PPID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${lockDir}/owner; else echo "promote lock held: $(cat ${lockDir}/owner 2>/dev/null) · remove ${lockDir} only after confirming no promote is running" >&2; exit 1; fi`;
export const promoteLockRelease = `rm -rf ${lockDir}`;

export function defaultPromoteRunner(): PromoteRunner {
  const config = getUserConfig().hq ?? {};
  const arbiter = config.arbiter ?? 'cloud-vm';
  const store = sshLeaseStore(arbiter, arbiter === 'local' ? localShellRunner : defaultSshRunner);
  return {
    lease() {
      const { now, raw } = store.read();
      const record = parseLease(raw);
      return { holder: record?.holder ?? null, generation: record?.generation ?? null,
        expired: !record || now - record.renewedAt > record.ttlSeconds };
    },
    run(host, script) {
      const r = spawnSync('ssh', ['-o', 'BatchMode=yes', host, `bash -c '${script.replaceAll("'", "'\\''")}'`], { encoding: 'utf8', timeout: 120_000 });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
    },
  };
}

export function promoteHq(host: string, apply = false, runner: PromoteRunner = defaultPromoteRunner()): PromoteResult {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) || host.includes('..')) throw new Error('hq promote: invalid host');
  const lines: PromoteLine[] = [];
  const acceptedHostNames = hostNamesFor(host);
  const result = (step: string, command: string, status: PromoteLine['status'], measurement: string) => {
    lines.push({ step, status, measurement, command });
  };
  let preflightOk = true;
  for (const [name, command] of checks) {
    let r: ReturnType<PromoteRunner['run']>;
    try { r = runner.run(host, command); } catch (error) { r = { status: null, stdout: '', stderr: String(error) }; }
    const ok = r.status === 0 && (name !== 'installed hq' || acceptedHostNames.some(name => r.stdout.trim() === `host=${name}`));
    if (!ok) preflightOk = false;
    result(`preflight ${name}`, command, ok ? 'done' : 'failed', (r.status === 0 ? r.stdout : r.stderr).trim() || `exit=${r.status}`);
  }
  let lease: ReturnType<PromoteRunner['lease']>;
  try { lease = runner.lease(); } catch (error) {
    result('① lease', 'read arbiter lease', 'failed', String(error));
    return { ok: false, apply, host, lines };
  }
  if (!acceptedHostNames.includes(lease.holder ?? '') || lease.expired) {
    result('① lease', 'read arbiter lease', 'failed', `holder=${lease.holder ?? 'none'} generation=${lease.generation ?? 'none'} expired=${lease.expired}`);
    return { ok: false, apply, host, lines };
  }
  result('① lease', 'read arbiter lease', 'done', `holder=${lease.holder} generation=${lease.generation} expired=false`);
  const targetHostName = lines.find(line => line.step === 'preflight installed hq')?.measurement.trim().replace(/^host=/, '') ?? '';
  if (!acceptedHostNames.includes(targetHostName) || targetHostName !== lease.holder) {
    result('① lease', 'compare arbiter holder to target hq.hostName', 'failed', `holder=${lease.holder} hq.hostName=${targetHostName}`);
    return { ok: false, apply, host, lines };
  }
  if (apply && !preflightOk) return { ok: false, apply, host, lines };
  let pinned: { core: string; big: string; coreManifestSha256: string; bigManifestSha256: string } | null = null;
  let locked = false;
  try {
  for (let i = 0; i < stages.length; i++) {
    const [name, script] = stages[i];
    const command = i === 1 && pinned
      ? `HQ_PROMOTE_CORE=${pinned.core} HQ_PROMOTE_BIG=${pinned.big} HQ_PROMOTE_CORE_MANIFEST_SHA256=${pinned.coreManifestSha256} HQ_PROMOTE_BIG_MANIFEST_SHA256=${pinned.bigManifestSha256} ${script}`
      : i === 2 ? `HQ_PROMOTE_HOST=${targetHostName} ${script}` : script;
    if (apply && i > 0) {
      try {
        const current = runner.lease();
        if (current.holder !== targetHostName || current.generation !== lease.generation || current.expired) {
          result(`${'②③④⑤⑥'[i]} ${name}`, command, 'failed', `lease changed: holder=${current.holder ?? 'none'} generation=${current.generation ?? 'none'} expired=${current.expired}`);
          return { ok: false, apply, host, lines };
        }
      } catch (error) {
        result(`${'②③④⑤⑥'[i]} ${name}`, command, 'failed', `lease read failed: ${String(error)}`);
        return { ok: false, apply, host, lines };
      }
    }
    if (!apply && i > 0) {
      result(`${'②③④⑤⑥'[i]} ${name}`, command, 'ready', `dry-run: would run on ${host}; no writes`);
      continue;
    }
    if (apply && i === 1) {
      // The host lock and the port probe share one call: the lock is held from before the copy until the finally below.
      const lockedProbe = `${promoteLockAcquire} && ${portProbe}`;
      let probe: ReturnType<PromoteRunner['run']>;
      try { probe = runner.run(host, lockedProbe); } catch (error) { probe = { status: null, stdout: '', stderr: String(error) }; }
      locked = !probe.stderr.includes('promote lock held');
      if (!locked) {
        result('③ copy to promotion universe', lockedProbe, 'failed', probe.stderr.trim());
        return { ok: false, apply, host, lines };
      }
      if (probe.status !== 0 || probe.stdout.trim() !== 'port=31416 available') {
        result('③ copy to promotion universe', portProbe, 'failed', `port=31416 occupied or unreadable before copy: ${probe.stderr.trim() || probe.stdout.trim() || `exit=${probe.status}`}`);
        return { ok: false, apply, host, lines };
      }
    }
    let r: ReturnType<PromoteRunner['run']>;
    try { r = runner.run(host, command); } catch (error) { r = { status: null, stdout: '', stderr: String(error) }; }
    let measurement = (r.status === 0 ? r.stdout : r.stderr).trim() || `exit=${r.status}`;
    let ok = r.status === 0;
    if (i === 1 && ok) ok = /promotion files=\d+ bytes=\d+B/.test(r.stdout);
    if (i === 2 && ok) ok = r.stdout.trim() === `hq.hostName=${targetHostName}`;
    if (i === 3 && ok) ok = /health=200 port=31416 pid=\d+ listener_pid=\d+\b/.test(r.stdout);
    if (i === 4 && ok) ok = /"mode"\s*:\s*"rescue"/.test(r.stdout);
    if (i === 0 && ok) {
      try {
        const verification = JSON.parse(r.stdout) as { ok?: boolean; tiers?: Array<{ tier: string; generation: string | null; manifestSha256: string | null; checked: number; entries: number | null }> };
        ok = verification.ok === true && verification.tiers?.length === 2
          && verification.tiers.map(t => t.tier).join(',') === 'core,big'
          && verification.tiers.every(t => t.generation && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(t.generation)
            && typeof t.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(t.manifestSha256)
            && t.entries !== null && t.entries > 0 && t.checked === t.entries) === true;
        if (ok) pinned = { core: verification.tiers![0].generation!, big: verification.tiers![1].generation!,
          coreManifestSha256: verification.tiers![0].manifestSha256!, bigManifestSha256: verification.tiers![1].manifestSha256! };
      } catch { ok = false; }
      if (!ok) measurement = `checksum verification failed · ${measurement}`;
    }
    result(`${'②③④⑤⑥'[i]} ${name}`, command, ok ? 'done' : 'failed', measurement);
    if (!ok) return { ok: false, apply, host, lines };
  }
  return { ok: preflightOk, apply, host, lines };
  } finally {
    if (locked) {
      try { runner.run(host, promoteLockRelease); } catch { /* the lock names its owner for manual release */ }
    }
  }
}

export function formatPromote(result: PromoteResult): string {
  return [`hq promote --to ${result.host} ${result.apply ? '--apply' : '(dry-run)'}`,
    ...result.lines.map(line => `${line.step}: ${line.status} · ${line.measurement}${line.status === 'ready' ? ` · ${line.command}` : ''}`)].join('\n');
}
