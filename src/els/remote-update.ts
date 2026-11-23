/** Operator-pinned SSH transport for a registered ELS host's existing local catch-up and update-all. */
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { FederatedHost } from './hosts.js';
import type { UpdatePane, UpdateResultRow } from './update-all.js';

const SHA = /^[a-f0-9]{40}$/i;
const MAX_OUTPUT = 1024 * 1024;
const REMOTE_TIMEOUT_MS = 31 * 60 * 1000;
const marker = 'ELS_UPDATE_ALL_RESULT=';
const beforeMarker = 'ELS_UPDATE_ALL_BEFORE=';

function quote(word: string): string { return `'${word.replaceAll("'", "'\\''")}'`; }

export function remoteUpdateCommand(host: FederatedHost, desired: string): { argv: string[]; script: string } {
  const update = host.update;
  if (!update) throw new Error(`${host.name}: remote SSH update transport not configured`);
  if (!SHA.test(desired)) throw new Error('invalid desired sha');
  const url = new URL(host.baseUrl);
  const targetHost = update.sshTarget.slice(update.sshTarget.indexOf('@') + 1);
  if (!/^[a-z_][a-z0-9_-]*@[A-Za-z0-9._-]+$/i.test(update.sshTarget)
    || url.hostname.toLowerCase() !== targetHost.toLowerCase()) throw new Error(`${host.name}: SSH HostName differs from registered URL host`);
  if (!isAbsolute(update.knownHostsFile) || /[\s%\0]/.test(update.knownHostsFile))
    throw new Error(`${host.name}: one literal pinned known_hosts path required`);
  const file = lstatSync(update.knownHostsFile);
  if (!file.isFile() || (file.mode & 0o022) !== 0) throw new Error(`${host.name}: pinned known_hosts must be a regular, non-writable-by-group file`);
  const bin = update.bin ?? 'eln';
  for (const value of [update.home, update.stateRoot, update.cwd, ...(update.bin ? [update.bin] : [])])
    if (value !== undefined && !isAbsolute(value)) throw new Error(`${host.name}: remote path must be absolute`);
  // The child executes only existing local CLI paths. The parent parses a single tagged JSON result.
  const env = [update.home ? `HOME=${quote(update.home)}` : '', update.stateRoot ? `ELANOUS_STATE_DIR=${quote(update.stateRoot)}` : '', 'COORD_ID=RES-INFRA'].filter(Boolean).join(' ');
  const command = `${env ? `env ${env} ` : ''}${quote(bin)}`;
  const testArg = update.stateRoot ? ` --test=${quote(update.stateRoot)}` : '';
  const before = `import { readFileSync } from 'node:fs'; const desired = JSON.parse(readFileSync(process.env.HOME + '/elanous-hq/seat-state/OP/rail/DESIRED.json', 'utf8')).sha; if (typeof desired !== 'string' || desired.toLowerCase() !== '${desired.toLowerCase()}') { console.error('remote desired differs from approved target'); process.exit(2); } const record = JSON.parse(readFileSync(process.env.HOME + '/.local/share/elanous/install.json', 'utf8')); console.log('${beforeMarker}' + JSON.stringify({ commit: record.commit }))`;
  const after = `import { readFileSync } from 'node:fs'; const record = JSON.parse(readFileSync(process.env.HOME + '/.local/share/elanous/install.json', 'utf8')); if (typeof record.commit !== 'string' || record.commit.toLowerCase() !== '${desired.toLowerCase()}') { console.error('remote installed build differs from approved target'); process.exit(2); }`;
  const script = `set -eu\n${update.cwd ? `cd ${quote(update.cwd)}\n` : ''}${env ? `env ${env} ` : ''}bun -e ${quote(before)}\n${command}${testArg} self-update --catch-up --seat ${update.catchUpSeat} --json --expected-desired ${quote(desired)}\n${env ? `env ${env} ` : ''}bun -e ${quote(after)}\n${command}${testArg} side update-all --local-only --json --expected-desired ${quote(desired)}`;
  return { argv: ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${update.knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `HostName=${targetHost}`, '-o', 'ConnectTimeout=10', update.sshTarget, 'sh', '-s'], script };
}

export function remoteProgressLines(host: string, emit: (message: string) => void) {
  const decoder = new StringDecoder('utf8');
  let pending = ''; let discarding = false;
  const flush = (text: string) => {
    for (const char of text) {
      if (char === '\n') {
        if (!discarding) {
          const match = /^ELS_UPDATE_PROGRESS remaining=([0-9]{1,6}) eta=([0-9]{1,6})$/.exec(pending);
          if (match) emit(`[${host}] Remaining seats: ${Number(match[1])} · ${Number(match[2])}s remaining`);
        }
        pending = ''; discarding = false;
      } else if (!discarding) {
        pending += char;
        if (pending.length > 128) { pending = ''; discarding = true; }
      }
    }
  };
  return { write: (chunk: Buffer) => flush(decoder.write(chunk)), end: () => { flush(decoder.end()); } };
}

export async function runRemoteUpdate(host: FederatedHost, panes: readonly UpdatePane[], desired: string, progress?: (message: string) => void): Promise<{
  result: UpdateResultRow['result']; detail: string; panes: UpdateResultRow[]; requested?: number;
}> {
  if (!SHA.test(desired)) throw new Error('invalid desired sha');
  // Older or malformed federation responses cannot prove that an OP pane is absent.
  if (panes.some(pane => pane.seat === undefined)) throw new Error(`${host.name}: remote seat identity unavailable`);
  if (host.update?.catchUpSeat === 'OP' || panes.some(pane => pane.seat === 'OP'))
    throw new Error(`${host.name}: remote OP seat requires its own approved HITL path`);
  const { argv, script } = remoteUpdateCommand(host, desired);
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('ssh', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', reject);
    child.stdin.end(script);
    let stdout = ''; let stderr = ''; let bytes = 0;
    const lines = progress ? remoteProgressLines(host.name, progress) : undefined;
    const timer = setTimeout(() => child.kill('SIGKILL'), REMOTE_TIMEOUT_MS);
    const append = (chunk: Buffer, channel: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { child.kill('SIGKILL'); return; }
      if (channel === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => { append(chunk, 'stderr'); lines?.write(chunk); });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); lines?.end(); resolve({ code, stdout, stderr }); });
  });
  if (output.code !== 0 && output.code !== 1) throw new Error(`${host.name}: SSH/local catch-up failed (${output.code}); remote output omitted`);
  const oldLine = output.stdout.split(/\r?\n/).find(row => row.startsWith(beforeMarker));
  if (!oldLine) throw new Error(`${host.name}: remote installed-build before receipt absent`);
  const old = JSON.parse(oldLine.slice(beforeMarker.length)) as { commit?: unknown };
  if (typeof old.commit !== 'string' || !SHA.test(old.commit)) throw new Error(`${host.name}: invalid remote installed-build before receipt`);
  const line = output.stdout.split(/\r?\n/).find(row => row.startsWith(marker));
  if (!line) throw new Error(`${host.name}: remote update receipt absent`);
  const receipt = JSON.parse(line.slice(marker.length)) as { ok?: unknown; desired?: unknown; installed?: unknown; rows?: unknown; requested?: unknown };
  if (receipt.desired !== desired || receipt.installed !== desired || typeof receipt.ok !== 'boolean' || receipt.ok !== (output.code === 0) || !Array.isArray(receipt.rows))
    throw new Error(`${host.name}: remote desired/install/result mismatch`);
  const translated = translateRemoteRows(host.name, panes, receipt.rows as UpdateResultRow[]);
  const result = translated.some(row => row.result === 'failed') ? 'failed' : translated.some(row => row.result === 'waiting') ? 'waiting' : receipt.ok ? 'updated' : 'failed';
  const requested = typeof receipt.requested === 'number' && Number.isSafeInteger(receipt.requested) && receipt.requested >= 0 && receipt.requested <= translated.length ? receipt.requested : undefined;
  return { result, detail: `${old.commit.slice(0, 12)}→${desired.slice(0, 12)}; SSH pinned`, panes: translated, ...(requested === undefined ? {} : { requested }) };
}

export function translateRemoteRows(host: string, panes: readonly UpdatePane[], localRows: readonly UpdateResultRow[]): UpdateResultRow[] {
  const wanted = new Map(panes.map(pane => [pane.address.slice(pane.address.indexOf(':') + 1), pane]));
  const translated: UpdateResultRow[] = [];
  for (const row of localRows) {
    if (!row || typeof row.tab !== 'string' || !['updated', 'skipped', 'waiting', 'failed'].includes(row.result) || typeof row.detail !== 'string'
      || (row.runtime !== undefined && typeof row.runtime !== 'string'))
      throw new Error(`${host}: invalid remote pane receipt`);
    const suffix = row.tab.slice(row.tab.indexOf(':') + 1);
    const pane = wanted.get(suffix);
    if (!pane || row.seat !== (pane.seat ?? '')) throw new Error(`${host}: unexpected remote pane or seat ${row.tab}`);
    wanted.delete(suffix);
    translated.push({ tab: pane.address, seat: pane.seat ?? '', result: row.result, detail: row.detail, ...(row.runtime === undefined ? {} : { runtime: row.runtime }) });
  }
  if (wanted.size) throw new Error(`${host}: remote pane receipt incomplete`);
  return translated;
}
