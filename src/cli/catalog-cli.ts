import type { Command } from 'commander';
import { refreshServerCatalog } from '../registry/catalog-server.js';
import { reloadCatalog } from '../registry/loader.js';

export interface CatalogCliDeps {
  refresh?: typeof refreshServerCatalog;
  reload?: typeof reloadCatalog;
  write?: (line: string) => void;
  setExitCode?: (code: number) => void;
}

export function registerCatalogCommands(program: Command, deps: CatalogCliDeps = {}): void {
  const catalog = program.command('catalog').description('서명된 LLM 모델 카탈로그 관리');
  catalog.command('refresh')
    .description('서버 카탈로그를 서명·판 검증 후 로컬 캐시에 갱신')
    .option('--json', '구조화 결과')
    .option('--url <url>', '카탈로그 서버 주소 재정의(검증된 서명만 수용)')
    .action(async (opts: { json?: boolean; url?: string }) => {
      const result = await (deps.refresh ?? refreshServerCatalog)(opts.url ? { url: opts.url } : {});
      const write = deps.write ?? ((line: string) => console.log(line));
      if (result.ok) {
        (deps.reload ?? reloadCatalog)();
        const output = { outcome: 'updated', catalogVersion: result.payload.catalogVersion };
        write(opts.json ? JSON.stringify(output) : `카탈로그 갱신 완료 · v${output.catalogVersion}`);
        return;
      }
      const output = { outcome: 'failed', reason: result.reason };
      write(opts.json ? JSON.stringify(output) : `카탈로그 갱신 실패 · ${output.reason}`);
      (deps.setExitCode ?? ((code: number) => { process.exitCode = code; }))(1);
    });
}
