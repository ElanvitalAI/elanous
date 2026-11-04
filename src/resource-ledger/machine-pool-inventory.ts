import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export const MACHINE_POOL_PURPOSES = ['gate', 'land', 'ta', 'review', 'sim'] as const;
export type MachinePoolPurpose = typeof MACHINE_POOL_PURPOSES[number];
export type MachinePoolMemberRole = 'assigner' | 'executor' | 'both';
export interface MachinePoolMember { host: string; count: number; digest: string; role: MachinePoolMemberRole }
export interface MachinePoolDeclaration {
  purpose: MachinePoolPurpose;
  members: MachinePoolMember[];
  fanoutGroupId: string;
  fanoutGroup: { shard: { kind: 'code' | 'gate' | 'green' | 'crawl' | 'skill'; input: string; result: string; fingerprint: string } };
  fingerprint: { runtime: string; environment: string; skillPacks: Array<{ name: string; version: string }> };
  cleanup: { procedure: string; verify: string };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required');
  return value.trim();
}
/** Declaration order never implies consumer priority; a pool is identified by purpose and digest. */
export function parseMachinePoolDeclarations(value: unknown): MachinePoolDeclaration[] {
  const root = record(value, 'machine inventory');
  if (!Array.isArray(root.pools)) throw new Error('machine inventory pools must be an array');
  const seen = new Set<string>();
  return root.pools.map((raw, index) => {
    const label = 'pools[' + index + ']';
    const pool = record(raw, label);
    const purpose = requiredText(pool.purpose, label + '.purpose');
    if (!(MACHINE_POOL_PURPOSES as readonly string[]).includes(purpose)) throw new Error(label + '.purpose is unsupported');
    const fanoutGroupId = requiredText(pool.fanoutGroupId, label + '.fanoutGroupId');
    const identity = purpose + '/' + fanoutGroupId;
    if (seen.has(identity)) throw new Error('duplicate machine pool ' + identity);
    seen.add(identity);
    if (!Array.isArray(pool.members) || pool.members.length === 0) throw new Error(label + '.members must be non-empty');
    const members = pool.members.map((rawMember, memberIndex) => {
      const memberLabel = label + '.members[' + memberIndex + ']';
      const member = record(rawMember, memberLabel);
      const host = requiredText(member.host, memberLabel + '.host');
      if (!Number.isSafeInteger(member.count) || (member.count as number) < 1) throw new Error(memberLabel + '.count must be a positive integer');
      const digest = requiredText(member.digest, memberLabel + '.digest');
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(memberLabel + '.digest must be immutable sha256');
      const role = requiredText(member.role, memberLabel + '.role');
      if (!['assigner', 'executor', 'both'].includes(role)) throw new Error(memberLabel + '.role is unsupported');
      return { host, count: member.count as number, digest, role: role as MachinePoolMemberRole };
    });
    if (new Set(members.map(member => member.host)).size !== members.length) throw new Error(label + '.members host must be unique');
    const fanoutGroup = record(pool.fanoutGroup, label + '.fanoutGroup');
    const shard = record(fanoutGroup.shard, label + '.fanoutGroup.shard');
    const shardKind = requiredText(shard.kind, label + '.fanoutGroup.shard.kind');
    if (!['code', 'gate', 'green', 'crawl', 'skill'].includes(shardKind)) throw new Error(label + '.fanoutGroup.shard.kind is unsupported');
    const fingerprint = record(pool.fingerprint, label + '.fingerprint');
    const cleanup = record(pool.cleanup, label + '.cleanup');
    const skillPacks = fingerprint.skillPacks;
    if (!Array.isArray(skillPacks)) throw new Error(label + '.fingerprint.skillPacks is required and must be an array');
    return { purpose: purpose as MachinePoolPurpose, members, fanoutGroupId, fanoutGroup: { shard: { kind: shardKind as 'code' | 'gate' | 'green' | 'crawl' | 'skill', input: requiredText(shard.input, label + '.fanoutGroup.shard.input'), result: requiredText(shard.result, label + '.fanoutGroup.shard.result'), fingerprint: requiredText(shard.fingerprint, label + '.fanoutGroup.shard.fingerprint') } },
      fingerprint: { runtime: requiredText(fingerprint.runtime, label + '.fingerprint.runtime'),
        environment: requiredText(fingerprint.environment, label + '.fingerprint.environment'),
        skillPacks: skillPacks.map((rawPack, packIndex) => {
          const pack = record(rawPack, label + '.skillPacks[' + packIndex + ']');
          return { name: requiredText(pack.name, label + '.skillPacks.name'),
            version: requiredText(pack.version, label + '.skillPacks.version') };
        }) }, cleanup: { procedure: requiredText(cleanup.procedure, label + '.cleanup.procedure'),
        verify: requiredText(cleanup.verify, label + '.cleanup.verify') } };
  });
}
export function readMachinePoolDeclarations(path: string): MachinePoolDeclaration[] {
  return parseMachinePoolDeclarations(parse(readFileSync(path, 'utf8')));
}
export function machinePoolCapacity(declarations: readonly MachinePoolDeclaration[]): Record<string, Partial<Record<MachinePoolPurpose, number>>> {
  const capacity: Record<string, Partial<Record<MachinePoolPurpose, number>>> = {};
  for (const pool of declarations) for (const member of pool.members) {
    if (member.role === 'assigner') continue;
    const host = capacity[member.host] || (capacity[member.host] = {});
    host[pool.purpose] = (host[pool.purpose] || 0) + member.count;
  }
  return capacity;
}
