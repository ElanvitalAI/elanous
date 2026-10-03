import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, sep } from 'node:path';

const COMMANDS = {
  lines: 'git ls-files -z',
  prs: 'gh pr list --state merged --limit 100000 --json number',
  months: 'git log --reverse --format=%cs | head -1',
} as const;

const UNMEASURED = '못 잼' as const;
type Metric = number | typeof UNMEASURED;

interface SiteNumberRow {
  value: Metric;
  command: string;
  denominator: string;
  candidate: string;
  error?: string;
}

interface SiteNumbers {
  measuredAtKst: string;
  lines: SiteNumberRow;
  prs: SiteNumberRow;
  months: SiteNumberRow;
}

function command(binary: string, args: string[], cwd: string): Buffer {
  return execFileSync(binary, args, { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function siteNumberCandidate(value: number, kind: 'lines' | 'prs' | 'months'): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid measurement');
  if (kind === 'months') return value >= 1 ? `${value}개월+` : '큰 수 후보 없음';
  if (kind === 'lines' && value >= 1_000_000) return `${Math.floor(value / 100_000) * 10}만+`;
  return value >= 10_000 ? `${Math.floor(value / 10_000)}만+` : '큰 수 후보 없음';
}

export function completedMonths(firstDay: string, todayKst: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDay) || !/^\d{4}-\d{2}-\d{2}$/.test(todayKst)
    || !Number.isFinite(Date.parse(`${firstDay}T00:00:00Z`)) || !Number.isFinite(Date.parse(`${todayKst}T00:00:00Z`))) {
    throw new Error('invalid commit or measurement date');
  }
  const [year, month, day] = firstDay.split('-').map(Number);
  const [nowYear, nowMonth, nowDay] = todayKst.split('-').map(Number);
  const months = (nowYear - year) * 12 + nowMonth - month - Number(nowDay < day);
  if (months < 0) throw new Error('first commit is after measurement day');
  return months;
}

function trackedTextLines(cwd: string): { lines: number; included: number; excluded: number } {
  const paths = command('git', ['ls-files', '-z'], cwd).toString('utf8').split('\0').filter(Boolean);
  let lines = 0;
  let included = 0;
  let excluded = 0;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  for (const path of paths) {
    const name = basename(path);
    if (path.split(/[\\/]/).includes('node_modules') || name.endsWith('.lock')
      || ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'Pipfile.lock'].includes(name)) {
      excluded++;
      continue;
    }
    const fullPath = `${cwd}${sep}${path}`;
    try {
      if (!lstatSync(fullPath).isFile()) { excluded++; continue; }
      const fd = openSync(fullPath, 'r');
      let fileLines = 0;
      let lastByte: number | undefined;
      let binary = false;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        let n: number;
        while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
          for (let i = 0; i < n; i++) {
            const byte = chunk[i];
            if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12 && byte !== 27)) {
              binary = true;
              break;
            }
            if (byte === 10) fileLines++;
          }
          if (binary) break;
          lastByte = chunk[n - 1];
          try { decoder.decode(chunk.subarray(0, n), { stream: true }); }
          catch { binary = true; break; }
        }
        if (!binary) {
          try { decoder.decode(); } catch { binary = true; }
        }
      } finally { closeSync(fd); }
      if (binary) excluded++;
      else { lines += fileLines + Number(lastByte !== undefined && lastByte !== 10); included++; }
    } catch (error) {
      throw new Error(`tracked file cannot be read: ${path}`, { cause: error });
    }
  }
  return { lines, included, excluded };
}

function measured(value: number, commandText: string, denominator: string, kind: 'lines' | 'prs' | 'months'): SiteNumberRow {
  const candidate = siteNumberCandidate(value, kind);
  const unit = kind === 'lines' ? '줄' : 'PR';
  return { value, command: commandText, denominator,
    candidate: candidate === '큰 수 후보 없음' || kind === 'months' ? candidate : `${candidate} ${unit}` };
}

function unavailable(commandText: string, denominator: string, error: unknown): SiteNumberRow {
  return { value: UNMEASURED, command: commandText, denominator, candidate: UNMEASURED,
    error: error instanceof Error ? error.message : String(error) };
}

export function measureSiteNumbers(options: { cwd: string; now?: Date; ghCommand?: string }): SiteNumbers {
  const { cwd, now = new Date(), ghCommand = 'gh' } = options;
  const measuredAtKst = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(now).replace(' ', 'T') + '+09:00';
  const todayKst = measuredAtKst.slice(0, 10);
  let lines: SiteNumberRow;
  try {
    const result = trackedTextLines(cwd);
    lines = measured(result.lines, COMMANDS.lines,
      `git ls-files 추적 파일 ${result.included + result.excluded}개 중 UTF-8 일반 텍스트 ${result.included}개; 제외 ${result.excluded}개 (바이너리/제어 바이트·node_modules·잠금 파일·심볼릭 링크); 각 파일의 LF 개수 + 마지막 개행 없는 비어 있지 않은 파일의 마지막 줄`, 'lines');
  } catch (error) {
    lines = unavailable(COMMANDS.lines, 'git ls-files 추적 UTF-8 일반 텍스트 파일; 바이너리·node_modules·잠금 파일·심볼릭 링크 제외; LF 개수 + 마지막 개행 없는 비어 있지 않은 파일의 마지막 줄', error);
  }
  let prs: SiteNumberRow;
  const prDenominator = '현재 저장소에서 gh가 반환한 병합 PR 목록 (상한 100000개; 제작 주체 미분류)';
  try {
    const list: unknown = JSON.parse(command(ghCommand, ['pr', 'list', '--state', 'merged', '--limit', '100000', '--json', 'number'], cwd).toString('utf8'));
    if (!Array.isArray(list) || !list.every(item => item !== null && typeof item === 'object' && Number.isSafeInteger(item.number))) {
      throw new Error('invalid gh PR response');
    }
    prs = measured(list.length, COMMANDS.prs, prDenominator, 'prs');
  } catch (error) {
    prs = unavailable(COMMANDS.prs, prDenominator, error);
  }
  let months: SiteNumberRow;
  try {
    const firstDay = command('git', ['log', '--reverse', '--format=%cs'], cwd).toString('utf8').split('\n')[0];
    if (!firstDay) throw new Error('no commits');
    months = measured(completedMonths(firstDay, todayKst), COMMANDS.months,
      `첫 커밋 날짜 ${firstDay}부터 KST 오늘 ${todayKst}까지 완료된 달력 개월 (일 미도달이면 1개월 차감)`, 'months');
  } catch (error) {
    months = unavailable(COMMANDS.months, `첫 커밋 날짜부터 KST 오늘 ${todayKst}까지 완료된 달력 개월`, error);
  }
  return { measuredAtKst, lines, prs, months };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json') || args.length > 1) {
    console.error('Usage: bun scripts/marketing/measure-site-numbers.ts [--json]');
    process.exitCode = 2;
  } else {
    const result = measureSiteNumbers({ cwd: process.cwd() });
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`잰 시각: ${result.measuredAtKst} (KST)`);
      for (const [label, row] of [['줄 수', result.lines], ['병합 PR', result.prs], ['기간', result.months]] as const) {
        console.log(`${label}: ${row.value} · 후보 ${row.candidate}`);
        console.log(`  명령: ${row.command}\n  분모: ${row.denominator}`);
        if (row.error) console.log(`  못 잰 이유: ${row.error}`);
      }
    }
  }
}
