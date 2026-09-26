// `elanous where`: 우주와 판정 근거를 실제 resolver 결과로 표시한다.
import type { Command } from 'commander';
import { resolveSelfTree } from '../instance/leader.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { effectiveInstanceRoot, normRoot, type InstanceResolution } from '../instance/resolve.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';

const LAYER_LABEL: Record<InstanceResolution['layer'], string> = {
  'explicit-flag': '명시 루트',
  'parent-stamp': '부모 스탬프',
  installed: '설치본',
  'tree-derived': '소스 트리(격리)',
  default: '소스 트리 밖 실행(격리)',
};

export function renderWhere(r: InstanceResolution, extra: { selfTree: string; configDir: string }): string {
  return [
    '━━ 지금 어느 우주인가 ━━',
    `  인스턴스   : ${r.kind === 'prod' ? '🔴 prod (운영)' : '🟢 test (격리)'}`,
    `  뿌리       : ${r.root}`,
    `  config-dir : ${extra.configDir}${normRoot(extra.configDir) === normRoot(r.root) ? '  ✓ 같은 뿌리' : '  ⚠️ 뿌리와 다름(축 어긋남)'}`,
    `  왜         : ${LAYER_LABEL[r.layer]} — ${r.why}`,
    `  실행 트리  : ${extra.selfTree}`,
  ].join('\n');
}

export interface WhereDeps {
  out?: { log: (s: string) => void };
  cwd?: () => string;
  configDir?: () => string;
}

export function registerWhereCommand(program: Command, deps: WhereDeps = {}): void {
  const out = deps.out ?? { log: (s: string) => console.log(s) };
  program.command('where')
    .description('지금 이 프로세스가 어느 인스턴스(prod/test)에 속하는지와 그 이유를 보여준다 (READ-ONLY)')
    .option('--json', 'JSON 출력')
    .action((o: { json?: boolean }) => {
      const cwd = (deps.cwd ?? (() => process.cwd()))();
      const configDir = (deps.configDir ?? getElanousConfigDir)();
      const r = resolveCurrentInstance({ cwd: () => cwd });
      const actualRoot = effectiveInstanceRoot();
      const mismatch = normRoot(actualRoot) !== normRoot(r.root) ? actualRoot : null;
      const selfTree = resolveSelfTree();
      if (o.json) {
        out.log(JSON.stringify({ ...r, selfTree, configDir, actualRoot, mismatch }, null, 2));
        return;
      }
      if (mismatch) out.log(`  ⚠️ 진단 불일치 — 해석=${r.root} 이나 실제 스토어 뿌리=${mismatch} (버그로 보고해 주세요)`);
      out.log(renderWhere(r, { selfTree, configDir }));
    });
}
