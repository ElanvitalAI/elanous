import { execFile } from 'node:child_process';
import { debug } from '../debug/log.js';
import type { DiscoveredInventoryResource } from './resource-inventory.js';

export interface CloudDiscoveryProviderStatus {
  provider: 'aws' | 'gcp';
  status: 'measured' | 'partial' | 'unavailable';
  resources: number;
}

export interface CloudDiscoveryResult {
  resources: DiscoveredInventoryResource[];
  providers: CloudDiscoveryProviderStatus[];
}

export interface CloudListResult { status: number; stdout: string }
export type CloudListCommand = (command: string, args: string[]) => CloudListResult | Promise<CloudListResult>;

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function runCloudListCommand(command: string, args: string[]): Promise<CloudListResult> {
  return new Promise(resolve => {
    execFile(command, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '' });
    });
  });
}

function parseJson(stdout: string): unknown {
  return JSON.parse(stdout);
}

function awsRunningInstances(value: unknown): DiscoveredInventoryResource[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { Reservations?: unknown }).Reservations))
    throw new Error('invalid aws response');
  const instances = (value as { Reservations: Array<{ Instances?: unknown }> }).Reservations.flatMap(row => Array.isArray(row.Instances) ? row.Instances : []);
  return instances.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as { InstanceId?: unknown; State?: { Name?: unknown }; Tags?: unknown };
    if (row.State?.Name !== 'running' || typeof row.InstanceId !== 'string' || !row.InstanceId) return [];
    const nameTag = Array.isArray(row.Tags)
      ? row.Tags.find(tag => !!tag && typeof tag === 'object' && (tag as { Key?: unknown }).Key === 'Name') as { Value?: unknown } | undefined
      : undefined;
    const name = typeof nameTag?.Value === 'string' ? nameTag.Value : undefined;
    return [{ id: row.InstanceId, machine: 'aws', provider: 'aws', ...(name ? { name } : {}) }];
  });
}

interface ParsedCloudResources { resources: DiscoveredInventoryResource[]; incomplete: boolean }

function gcpRunningInstances(value: unknown): ParsedCloudResources {
  if (!Array.isArray(value)) throw new Error('invalid gcp response');
  let incomplete = false;
  const resources = value.flatMap(raw => {
    if (!raw || typeof raw !== 'object') { incomplete = true; return []; }
    const row = raw as { id?: unknown; name?: unknown; status?: unknown; zone?: unknown; selfLink?: unknown };
    if (row.status !== 'RUNNING') return [];
    const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '';
    if (typeof row.name !== 'string' || !row.name || !/^\d+$/.test(id)) { incomplete = true; return []; }
    const zone = typeof row.zone === 'string' ? row.zone.split('/').at(-1) : '';
    const project = typeof row.selfLink === 'string' ? row.selfLink.match(/\/projects\/([^/]+)/)?.[1] : undefined;
    const selfLinkPath = typeof row.selfLink === 'string' ? row.selfLink.match(/compute\/v1\/(projects\/.*)$/)?.[1] : undefined;
    const canonicalPath = selfLinkPath ?? (project && zone ? `projects/${project}/zones/${zone}/instances/${row.name}` : undefined);
    return [{ id, machine: 'gcp', provider: 'gcp', name: row.name,
      aliases: canonicalPath ? [canonicalPath] : [] }];
  });
  return { resources, incomplete };
}

/** Read-only current-account discovery. Provider errors are kept as status, never raw stderr (which can contain credentials). */
export async function discoverCloudResources(run: CloudListCommand = runCloudListCommand): Promise<CloudDiscoveryResult> {
  const queries: Array<{ provider: 'aws' | 'gcp'; command: string; args: string[]; parse: (value: unknown) => ParsedCloudResources }> = [
    { provider: 'aws', command: 'aws', args: ['ec2', 'describe-instances', '--no-cli-pager', '--output', 'json'], parse: value => ({ resources: awsRunningInstances(value), incomplete: false }) },
    { provider: 'gcp', command: 'gcloud', args: ['compute', 'instances', 'list', '--format=json'], parse: gcpRunningInstances },
  ];
  const outcomes = await Promise.all(queries.map(async query => {
    try {
      const result = await run(query.command, query.args);
      if (result.status !== 0) {
        return { provider: query.provider, status: 'unavailable' as const, resources: [] };
      }
      const parsed = query.parse(parseJson(result.stdout));
      return { provider: query.provider, status: parsed.incomplete ? 'partial' as const : 'measured' as const, resources: parsed.resources };
    } catch {
      return { provider: query.provider, status: 'unavailable' as const, resources: [] };
    }
  }));
  for (const outcome of outcomes) debug.log('fleet.inventory', outcome.status === 'unavailable' ? 'cloud-discovery-unavailable' : 'cloud-discovery-measured', {
    provider: outcome.provider, ...(outcome.status !== 'unavailable' ? { resources: outcome.resources.length, partial: outcome.status === 'partial' } : {}),
  });
  return {
    resources: outcomes.flatMap(outcome => outcome.resources),
    providers: outcomes.map(outcome => ({ provider: outcome.provider, status: outcome.status, resources: outcome.resources.length })),
  };
}
