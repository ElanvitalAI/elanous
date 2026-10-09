// CFG-CLASSIFY — 파일의 잎만 분류한다. 운영 config 변경·시험 우주 동기화 없음.
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { flattenConfig, isSecretPath, isSecretValue, MASK } from './config-drift.js';

export type ConfigClass = 'secret' | 'product-default' | 'machine-fact' | 'operational';
export interface ClassifiedConfigLeaf {
  key: string;
  class: ConfigClass;
  rule: string;
  overridesDefault: boolean;
}

export interface ConfigClassifyReport {
  totalLeaves: number;
  overridesDefault: number;
  counts: Record<ConfigClass, number>;
  leaves: ClassifiedConfigLeaf[];
}

interface RuleInput {
  key: string;
  value: unknown;
  matchesDefault: boolean;
}

// 순서가 우선순위다. 비밀은 기본값·경로보다 먼저, 기본값 복사는 기계 사실보다 먼저 판정한다.
export const CLASSIFY_RULES: ReadonlyArray<{
  class: ConfigClass;
  rule: string;
  matches: (input: RuleInput) => boolean;
}> = [
  { class: 'secret', rule: '비밀 경로 또는 비밀 값', matches: ({ key, value }) => isSecretPath(key) || isSecretValue(value) },
  { class: 'product-default', rule: '코드 기본값 복사', matches: ({ matchesDefault }) => matchesDefault },
  {
    class: 'machine-fact', rule: '기계 경로·주소·포트',
    matches: ({ key, value }) => key.split('.').some((part) => /(?:^|[_-])(?:paths?|dirs?|directories|roots?|ports?|hosts?|urls?|bins?|sockets?|cwd)(?:$|[_-])/i.test(part)
      || /(?:Path|Dir|Directory|Root|Port|Host|URL|Url|Bin|Socket|Cwd)$/.test(part))
      || (typeof value === 'string' && (isAbsolute(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value))),
  },
  { class: 'operational', rule: '나머지 운영 정책·상태', matches: () => true },
];

/** raw 파일의 잎 수를 분모로 한다. 기본값에 키가 없으면 (값이 undefined 여도) 덮어쓰기다. */
export function classifyConfig(raw: Record<string, unknown>, codeDefaults: Record<string, unknown>): ConfigClassifyReport {
  const defaults = flattenConfig(codeDefaults);
  const leaves = [...flattenConfig(raw)].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    const matchesDefault = defaults.has(key) && isDeepStrictEqual(value, defaults.get(key));
    const rule = CLASSIFY_RULES.find((candidate) => candidate.matches({ key, value, matchesDefault }))!;
    return { key, class: rule.class, rule: rule.rule, overridesDefault: !matchesDefault };
  });
  const counts: ConfigClassifyReport['counts'] = {
    secret: 0, 'product-default': 0, 'machine-fact': 0, operational: 0,
  };
  for (const leaf of leaves) counts[leaf.class]++;
  return {
    totalLeaves: leaves.length,
    overridesDefault: leaves.filter((leaf) => leaf.overridesDefault).length,
    counts, leaves,
  };
}

export function renderClassify(report: ConfigClassifyReport): string {
  const labels: Record<ConfigClass, string> = {
    secret: '③ 비밀', 'product-default': '① 제품 기본값',
    'machine-fact': '② 기계 사실', operational: '④ 운영 정책·상태',
  };
  const lines = [`config classify — 잎 ${report.totalLeaves} · 운영 덮어쓰기 ${report.overridesDefault}`];
  for (const { class: kind } of CLASSIFY_RULES) {
    const leaves = report.leaves.filter((leaf) => leaf.class === kind);
    lines.push(`  ${labels[kind]} ${report.counts[kind]}`);
    const topKeys = new Map<string, number>();
    for (const leaf of leaves) {
      const top = leaf.key.split('.')[0]!;
      topKeys.set(top, (topKeys.get(top) ?? 0) + 1);
    }
    const leaders = [...topKeys].sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b)).slice(0, 10);
    if (leaders.length) lines.push(`    상위 키: ${leaders.map(([key, count]) => `${key} × ${count}`).join(' · ')}`);
    for (const leaf of leaves.slice(0, 10)) lines.push(`    ${leaf.key}${kind === 'secret' ? ` = ${MASK}` : ''}`);
    if (leaves.length > 10) lines.push(`    … ${leaves.length - 10}개 더 (--json)`);
  }
  return lines.join('\n');
}
