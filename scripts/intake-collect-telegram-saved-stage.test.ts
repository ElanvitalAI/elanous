import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('TG-SAVED-ZERO mock stage: a saved message is ingested on the next collect', () => {
  const stage = resolve(import.meta.dir, 'intake-collect-telegram-saved-stage.ts');
  const result = spawnSync(process.execPath, ['run', stage], { encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;

  expect(result.status).toBe(0);
  expect(output).toContain('사흘 0 관측 그대로');
  expect(output).toContain('판정 — 대표가 저장한 메시지 1건(id 9200)이 다음 흡수에 원장으로 들어감');
  expect(output).toContain('[verdict] 판정선 통과 — 저장 메시지 1건이 다음 흡수에 원장으로 들어갔다');
  expect(output).toContain('[ledger] 원장 링크 ["https://example.com/first","https://example.com/next"] · 커서 9200');
});
