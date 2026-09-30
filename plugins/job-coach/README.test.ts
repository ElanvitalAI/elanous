import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readme = readFileSync(join(import.meta.dir, 'README.md'), 'utf8');
const graph = readFileSync(join(import.meta.dir, 'graphs/report-enterprise.yaml'), 'utf8');

test('enterprise README documents the executable graph, input, output and delivery boundary', () => {
  expect(graph).toContain('graph_id: job-coach-report-enterprise');
  expect(readme).toContain('elanous graph run /absolute/path/to/installed/job-coach/graphs/report-enterprise.yaml --input');
  expect(readme).toContain('"interview":"/private/path/to/fictional-enterprise.md"');
  expect(readme).toContain('statePath');
  expect(readme).toContain('<run-id>/report.md');
  expect(readme).toContain('No-send boundary:');
  expect(readme).toContain('`--no-send` 플래그를 지원한다고 가정하지 않는다');
  expect(readme).toContain('NCS API 조회 및 외부 과정 조사는 네트워크 요청');
  expect(readme).toContain('마켓 게시/시장 출시는 이 플러그인 README의 범위 밖');
  expect(readme).toContain('런 상태와 컨텍스트 JSON에 저장');
});

test('enterprise README sample has fictional people and companies and only a placeholder image', () => {
  const sample = readme.match(/### 기업 모드 샘플 입력[^]*?```markdown\n([^]*?)\n```/);
  expect(sample).not.toBeNull();
  const text = sample![1]!;
  for (const heading of ['기업 개요', '교육 대상', '현업 과제', '교육 목표', '현재 역량', '교육 제약']) {
    expect(text).toContain(`## ${heading}\n`);
  }
  expect(text).toContain('푸른달 스튜디오 (가상 회사)');
  expect(text).toContain('민서 하 (가상 인물)');
  expect(text).toContain('/placeholder/images/fictional-company.png');
  expect(text).not.toMatch(/https?:\/\/|@|\/Users\/|\/home\//);
});
