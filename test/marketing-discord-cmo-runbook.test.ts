import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSeatAddress, resolveSeat } from '../src/seat-address/seat-address.js';

const root = resolve(import.meta.dir, '..');
const runbook = readFileSync(resolve(root, 'docs/marketing/RUNBOOK-discord-cmo-demo-2026-10-04.md'), 'utf8');
const source = readFileSync(resolve(root, 'docs/marketing/RUNBOOK-marketers-night-demo-2026-10-02.md'), 'utf8');
const sourceCard = source.split('\n').find(line => line.startsWith('| ③ |'))!;
const sourceVideo = source.split('\n').find(line => line.startsWith('| ② |'))!;
const sourcePlugin = source.split('\n').find(line => line.startsWith('| ④ |'))!;
const table = runbook.match(/^\| 장면 \|[^\n]+\n\|[-|]+\|\n((?:\|[^\n]+\n)+)/m)?.[1];
const rows = table?.trimEnd().split('\n').map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));

// The table is the operator's single copy surface: test its actual cells, not a second list of sample prompts.
test('five demo rows carry copyable CMO seat instructions and traceable intake evidence', () => {
  expect(rows?.map(row => row[0])).toEqual([
    '처음 왕복 `@cmo 테스트`', '명함 팔로업', 'AEO·GEO 점검', '즉석 영상', '라이브 플러그인',
  ]);
  for (const row of rows!) {
    expect(row).toHaveLength(6);
    const [scene, command, route, result, time, boundary] = row;
    expect(command, `${scene}: one copyable line`).toMatch(/^`@cmo [^`\n]+`$/);
    const address = parseSeatAddress(command!.slice(1, -1));
    expect(address?.seats, `${scene}: parsed seat`).toEqual(['cmo']);
    expect(resolveSeat(address!.seats[0]!)?.title, `${scene}: resolved seat`).toBe('CMO');
    expect(address?.body.trim(), `${scene}: instruction`).toBeTruthy();
    expect(route, `${scene}: graph route`).toContain('그래프 인테이크');
    expect(result, `${scene}: first reply`).toContain('@CMO 접수번호:');
    expect(boundary, `${scene}: stopping boundary`).toBeTruthy();
    const references = [...route!.matchAll(/`(src\/[\w./-]+\.ts):([\d,-]+)`/g)];
    expect(references.length, `${scene}: code citations`).toBeGreaterThan(0);
    expect(route!.match(/`src\/[\w./-]+\.ts:[^`]+`/g)).toHaveLength(references.length);
    for (const [, file, spans] of references) {
      const path = resolve(root, file!);
      expect(existsSync(path), `${scene}: ${file} exists`).toBe(true);
      const lines = readFileSync(path, 'utf8').split('\n');
      for (const span of spans!.split(',')) {
        const [start, end = start] = span.split('-').map(Number);
        expect(start, `${scene}: ${file}:${span} start`).toBeGreaterThan(0);
        expect(end, `${scene}: ${file}:${span} end`).toBeLessThanOrEqual(lines.length);
        expect(start, `${scene}: ${file}:${span} range`).toBeLessThanOrEqual(end!);
        expect(lines[start! - 1]?.trim(), `${scene}: ${file}:${span} exists`).toBeTruthy();
      }
    }
    if (scene === '명함 팔로업') {
      expect(sourceCard).toContain('약 2분');
      expect(sourceCard).toContain('124초');
      expect(time).toBe('약 2분 (0.2.0 실측 124초 · `docs/marketing/RUNBOOK-marketers-night-demo-2026-10-02.md:13`; 디스코드 왕복 안 쟀다)');
    } else if (scene === '즉석 영상') {
      expect(sourceVideo).toContain('렌더만 42초');
      expect(sourceVideo).toContain('업로드→영상 51초');
      expect(time).toBe('앱 실측: 렌더만 42초 · 수동 업로드→영상 51초 (`docs/marketing/RUNBOOK-marketers-night-demo-2026-10-02.md:12`); 디스코드 왕복 안 쟀다');
    } else if (scene === '라이브 플러그인') {
      expect(sourcePlugin).toContain('7분 50초 ~ 9.5분');
      expect(time).toBe('터미널 실측 두 번: 7분 50초 ~ 9.5분 (`docs/marketing/RUNBOOK-marketers-night-demo-2026-10-02.md:14`); 디스코드 왕복 안 쟀다');
    } else expect(time, `${scene}: Discord duration has not been measured`).toBe('안 쟀다');
  }
});

test('business-card and AEO prompts carry concrete rehearsal inputs and explicit preflight', () => {
  const card = rows?.find(row => row[0] === '명함 팔로업')?.[1] ?? '';
  const aeo = rows?.find(row => row[0] === 'AEO·GEO 점검')?.[1] ?? '';
  const ownSite = readFileSync(resolve(root, 'docs/marketing/EVENT-marketers-night-2026-10-02.md'), 'utf8');
  expect(card).toMatch(/회사 Elanvital AI, 직함 마케팅 담당자, 관심사 행사 후 팔로업 자동화/);
  expect(card).toContain('가상 시연용');
  expect(card).not.toContain('전달하겠습니다');
  expect(aeo).toContain('https://elanous.ai/');
  expect(ownSite).toContain('https://elanous.ai');
  expect(runbook).toContain('입력 검수 (MK · 리허설 전');
  expect(runbook).toContain('열리지 않거나 승인되지 않았으면 임의 페이지로 바꾸어 전송하지 않고 그 장면을 생략한다');
});

test('every file:line reference in the runbook names a real repository line', () => {
  const references = [...runbook.matchAll(/`((?:src|scripts|docs)\/[\w./-]+\.(?:ts|json|md)):([\d,-]+)`/g)];
  expect(references.length).toBeGreaterThan(0);
  for (const [, file, spans] of references) {
    const path = resolve(root, file!);
    expect(existsSync(path), `${file}: file exists`).toBe(true);
    const lines = readFileSync(path, 'utf8').split('\n');
    for (const span of spans!.split(',')) {
      const [start, end = start] = span.split('-').map(Number);
      expect(start, `${file}:${span}: valid start`).toBeGreaterThan(0);
      expect(start, `${file}:${span}: valid range`).toBeLessThanOrEqual(end!);
      expect(end, `${file}:${span}: valid end`).toBeLessThanOrEqual(lines.length);
    }
  }
});

test('fallbacks identify five failure modes and one existing observation command each', () => {
  const lines = runbook.split('## 막히면')[1]?.split('\n## ')[0]?.split('\n')
    .filter(line => /^\d+\. \*\*/.test(line)) ?? [];
  expect(lines).toHaveLength(5);
  expect(lines.map(line => line.match(/^\d+\. \*\*([^*]+)\*\*/)?.[1])).toEqual([
    '봇 무응답', '자리 주소 거부', '결과가 늦음', '결정 카드가 뜸', '디스코드 연결 끊김',
  ]);
  for (const line of lines) expect(line.match(/`elanous logs --category (?:discord\.trigger|discord\.core|intake\.seat-doc) --limit 20`/g)).toHaveLength(1);
  expect(readFileSync(resolve(root, 'src/discord.ts'), 'utf8')).toContain("debug.log('discord.trigger', 'dropped'");
  expect(readFileSync(resolve(root, 'src/intake-plane/seat-doc-route.ts'), 'utf8')).toContain("debug.log('intake.seat-doc'");
  expect(runbook).toContain('결정 카드 버튼은 누르지 않고');
  expect(runbook).toContain('게시는 승인 뒤에만');
});

test('runbook avoids unmeasured promises and other-company names', () => {
  expect(runbook).not.toMatch(/곧|완전 자율/);
  expect(runbook).not.toMatch(/삼성|네이버|카카오|구글|애플|마이크로소프트|OpenAI|Anthropic|Google|Microsoft|Samsung|Naver|Kakao/iu);
});
