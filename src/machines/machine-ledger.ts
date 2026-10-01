import { readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';

export interface MachineRow {
  id: string;
  name: string;
  specs: string;
  locationStatus: string;
  role: string;
  duties: string;
}

export interface DeviceRow {
  id: string;
  name: string;
  status: string;
  purpose: string;
}

export interface MachineLedger {
  title: string;
  policy: string[];
  machines: MachineRow[];
  devices: DeviceRow[];
  rules: string[];
  changes: string[];
}

export const machineLedgerPath = (root = process.cwd()): string => resolve(root, 'docs/ops/machines.yaml');
export const machineMarkdownPath = (root = process.cwd()): string => resolve(root, 'docs/ops/LEDGER-machines-and-devices.md');

// The ledger rule: no secrets, IPs or accounts — token prefixes, key=value assignments, e-mail addresses.
const forbidden = /(?:sk-(?:proj-|live-|ant-)?|gh[pousr]_|github_pat_|glpat-|xox[abposr]-|tskey-|AKIA|AIza)[A-Za-z0-9_-]{8,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:token|secret|password|passwd|api[_-]?key|key)\s*[=:]\s*\S|-----BEGIN [A-Z ]*PRIVATE KEY|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/i;
// A value lands in a Markdown table cell: a pipe or line break would split the row.
const tableBreaking = /[|\r\n]/;
const containsIpv6 = (value: string): boolean => (value.match(/(?:[a-f\d]*:){2,}[a-f\d:.]*/gi) ?? []).some((candidate) => isIP(candidate.replace(/\.+$/, '')) === 6);
const idPattern = /^[a-z][a-z0-9-]*$/;
const keys = (value: Record<string, unknown>, allowed: string[], label: string): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
};
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || forbidden.test(value) || containsIpv6(value)) throw new Error(`invalid or secret-like ${label}`);
  if (tableBreaking.test(value)) throw new Error(`${label} must not contain a pipe or line break`);
  return value;
};
const list = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
};

export function validateMachineLedger(value: unknown): MachineLedger {
  const data = record(value, 'ledger');
  keys(data, ['title', 'policy', 'machines', 'devices', 'rules', 'changes'], 'ledger');
  if (!Array.isArray(data.machines) || !Array.isArray(data.devices)) throw new Error('invalid machines or devices');
  const ids = new Set<string>();
  const rows = <T extends { id: string }>(entries: unknown[], fields: string[], label: string): T[] => entries.map((entry, index) => {
    const row = record(entry, `${label}[${index}]`);
    keys(row, fields, label);
    const result = Object.fromEntries(fields.map((field) => [field, text(row[field], `${label}.${field}`)])) as T;
    if (!idPattern.test(result.id) || ids.has(result.id)) throw new Error(`empty, duplicate or invalid id: ${result.id}`);
    ids.add(result.id);
    return result;
  });
  return {
    title: text(data.title, 'title'),
    policy: list(data.policy, 'policy'),
    machines: rows<MachineRow>(data.machines, ['id', 'name', 'specs', 'locationStatus', 'role', 'duties'], 'machines'),
    devices: rows<DeviceRow>(data.devices, ['id', 'name', 'status', 'purpose'], 'devices'),
    rules: list(data.rules, 'rules'),
    changes: list(data.changes, 'changes'),
  };
}

export function loadMachineLedger(root = process.cwd()): MachineLedger {
  const document = parseDocument(readFileSync(machineLedgerPath(root), 'utf8'), { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join('; '));
  return validateMachineLedger(document.toJS());
}

export function renderLedgerMarkdown(ledger: MachineLedger): string {
  const data = validateMachineLedger(ledger);
  const names = (name: string) => name === '(미정)' ? name : name.split(' · ').map((part) => `\`${part}\``).join(' · ');
  const portablePolicy = data.policy.find((line) => line.startsWith('창은 '));
  const portableHeading = portablePolicy ? `## 2. 창 (${portablePolicy.slice('창은 '.length).replace(/\.$/, '')})` : '## 2. 창';
  return [
    `# ${data.title}`, '',
    '> 생성 결과 — 보유·역할과 변경 이력의 단일 원본은 [`machines.yaml`](machines.yaml). 이 문서의 행·규칙·변경 이력은 직접 수정하지 않는다. YAML 수정 후 `bun bin/elanous.mjs --test machine render` 로 재생성하고 `bun bin/elanous.mjs --test machine render --check` 로 확인한다.',
    ...data.policy.filter((line) => !line.startsWith('창은 ')).map((line) => `> ${line.replace('`docs/ops/machines.yaml` 에', 'YAML 에')}`),
    '', '## 1. 계산 자원 (일하는 기계)',
    '| 이름(tailnet) | 기종 · 사양 | 위치 · 상태 | 자리 | 맡은 일 |',
    '|---|---|---|---|---|',
    ...data.machines.map((row) => `| ${names(row.name)} | ${row.specs} | ${row.locationStatus} | ${row.role} | ${row.duties} |`),
    '', portableHeading,
    '| 기기 | 상태 | 용도 |', '|---|---|---|',
    ...data.devices.map((row) => `| ${row.name} | ${row.status} | ${row.purpose} |`),
    '', '## 3. 규칙', ...data.rules.map((rule) => `- ${rule}`),
    '', '## 변경', ...data.changes.map((change) => `- ${change}`), '',
  ].join('\n');
}

export function setMachineField(root: string, id: string, field: string, value: string): MachineLedger {
  const ledger = loadMachineLedger(root);
  const row = [...ledger.machines, ...ledger.devices].find((item) => item.id === id);
  if (!row) throw new Error(`unknown machine id: ${id}`);
  if (field === 'id' || !(field in row)) throw new Error(`unknown or immutable field: ${field}`);
  text(value, field);
  const updated = { ...row, [field]: value };
  if ('specs' in row) ledger.machines[ledger.machines.findIndex((item) => item.id === id)] = updated as MachineRow;
  else ledger.devices[ledger.devices.findIndex((item) => item.id === id)] = updated as DeviceRow;
  validateMachineLedger(ledger);
  const yamlPath = machineLedgerPath(root);
  const original = readFileSync(yamlPath, 'utf8');
  const document = parseDocument(original, { uniqueKeys: true });
  const section = 'specs' in row ? 'machines' : 'devices';
  const index = section === 'machines' ? ledger.machines.findIndex((item) => item.id === id) : ledger.devices.findIndex((item) => item.id === id);
  document.setIn([section, index, field], value);
  validateMachineLedger(document.toJS());
  writeFileSync(yamlPath, document.toString(), 'utf8');
  writeFileSync(machineMarkdownPath(root), renderLedgerMarkdown(ledger), 'utf8');
  return ledger;
}
