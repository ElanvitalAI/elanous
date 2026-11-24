import { execFile } from 'node:child_process';

export type CloudHost = { provider: 'aws' | 'gcp'; id: string; name: string; state: string; protected: true | null };
export type CloudHostSnapshot = { hosts: CloudHost[]; providers: Array<{ provider: 'aws' | 'gcp'; status: 'measured' | 'unavailable' }> };
type Run = (command: string, args: string[]) => Promise<{ status: number; stdout: string }>;

const runCommand: Run = (command, args) => new Promise(resolve => {
  execFile(command, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    resolve({ status: error ? 1 : 0, stdout: stdout ?? '' });
  });
});

/** Read-only provider census, including stopped machines. Unknown state is never running. */
export async function cloudHostInventory(run: Run = runCommand): Promise<CloudHostSnapshot> {
  const queries = [
    { provider: 'aws' as const, command: 'aws', args: ['ec2', 'describe-instances', '--no-cli-pager', '--output', 'json'] },
    { provider: 'gcp' as const, command: 'gcloud', args: ['compute', 'instances', 'list', '--format=json'] },
  ];
  const results = await Promise.all(queries.map(async query => {
    try {
      const response = await run(query.command, query.args);
      if (response.status !== 0) throw new Error('provider unavailable');
      const value: any = JSON.parse(response.stdout);
      const items: any[] = query.provider === 'aws'
        ? (Array.isArray(value?.Reservations) ? value.Reservations.flatMap((r: any) => { if (!Array.isArray(r?.Instances)) throw new Error('invalid AWS reservation'); return r.Instances; }) : (() => { throw new Error('bad AWS response'); })())
        : (Array.isArray(value) ? value : (() => { throw new Error('bad GCP response'); })());
      const hosts = items.map((item: any): CloudHost => {
        const id = String(query.provider === 'aws' ? item?.InstanceId ?? '' : item?.id ?? '');
        const name = String(query.provider === 'aws' ? item?.Tags?.find((t: any) => t?.Key === 'Name')?.Value ?? id : item?.name ?? '');
        const state = String(query.provider === 'aws' ? item?.State?.Name ?? '' : item?.status ?? '').toLowerCase();
        if (!id || !name || !state) throw new Error('incomplete provider record');
        return { provider: query.provider, id, name, state, protected: ['elanous-dream', 'elanous-members', 'relay-edge-seoul-1'].includes(name) ? true : null };
      });
      return { provider: query.provider, status: 'measured' as const, hosts };
    } catch { return { provider: query.provider, status: 'unavailable' as const, hosts: [] as CloudHost[] }; }
  }));
  return { hosts: results.flatMap(r => r.hosts), providers: results.map(({ provider, status }) => ({ provider, status })) };
}

export type CloudHostLookup =
  | { status: 'measured'; host: CloudHost }
  | { status: 'unmeasured' | 'not-found' | 'ambiguous'; host: null };

/** A missing provider can hide a duplicate: never report a unique host until both answer. */
export function findCloudHost(snapshot: CloudHostSnapshot, name: string): CloudHostLookup {
  if (!name.trim() || name !== name.trim()) return { status: 'not-found', host: null };
  if (snapshot.providers.length !== 2 || new Set(snapshot.providers.map(p => p.provider)).size !== 2
    || snapshot.providers.some(p => p.status !== 'measured')) return { status: 'unmeasured', host: null };
  const matches = snapshot.hosts.filter(host => host.id === name || host.name === name);
  if (matches.length === 0) return { status: 'not-found', host: null };
  if (matches.length !== 1) return { status: 'ambiguous', host: null };
  return { status: 'measured', host: matches[0]! };
}
