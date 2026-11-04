import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Command } from 'commander';
import { buildTrainThroughput, collectTrainSummaryEvents, isValidTrainDate, parseTrainThroughputLogs, trainIdentityFromBatchDirectory, trainKeysFromManifest, trainRejectionsFromSummary, type TrainSummaryEvent } from '../nexus/api/train-throughput.js';

export interface TrainThroughputCliDeps {
  readFile?: (path: string) => string;
}

export function summarizeTrainThroughputFiles(logPaths: readonly string[], summaryPaths: readonly string[], date: string,
  readFile: (path: string) => string = path => readFileSync(path, 'utf8'), getMtime: (path: string) => Date = path => statSync(path).mtime,
  fileExists: (path: string) => boolean = path => existsSync(path)) {
  const events = logPaths.flatMap(path => parseTrainThroughputLogs(readFile(path).split(/\r?\n/), {
    date, anchorDate: getMtime(path).toISOString().slice(0, 10),
  }));
  let sourceIncomplete = false;
  const summaries: TrainSummaryEvent[] = summaryPaths.flatMap(path => {
    const value: unknown = JSON.parse(readFile(path));
    let manifest: unknown;
    const manifestPath = path.replace(/summary[^/]*\.json$/, 'manifest.json');
    if (fileExists(manifestPath)) {
      try { manifest = JSON.parse(readFile(manifestPath)); } catch { sourceIncomplete = true; }
    }
    const identity = trainIdentityFromBatchDirectory(basename(dirname(path)), manifest);
    return [...collectTrainSummaryEvents(value), ...(identity ? [
      ...trainKeysFromManifest(manifest, identity.host, identity.runId),
      ...trainRejectionsFromSummary(value, identity.host, identity.runId, manifest),
    ] : [])];
  });
  return { ...buildTrainThroughput(events, summaryPaths.length ? summaries : undefined, date), sourceIncomplete };
}

export function formatTrainThroughputText(result: ReturnType<typeof summarizeTrainThroughputFiles>): string {
  const lines = [
    ...(result.sourceIncomplete ? ['⚠ 일부 로그/요약 파일을 읽지 못해 수치가 불완전합니다.'] : []),
    `열차 처리량 · ${result.date} · KST`,
    '호스트\t배정\tPR\t완료\t성공\t거부\t실행실패\t측정불가\t착지\t배정→완료(초)\t거부 사유',
  ];
  for (const [host, row] of Object.entries(result.hosts).sort(([a], [b]) => a.localeCompare(b))) {
    const reasons = Object.entries(row.rejectedByReason).filter(([, count]) => count).map(([reason, count]) => `${reason}=${count}`).join(',');
    lines.push(`${host}\t${row.assigned}\t${row.assignedPrs}\t${row.completed}\t${row.succeeded}\t${row.rejected}\t${row.failed}\t${row.unmeasured}\t${row.landed ?? '미측정'}\t${row.averageWaitSeconds ?? '미측정'}\t${reasons || '—'}`);
  }
  lines.push('', '시간별(KST)\t배정\t완료\t성공\t거부\t착지\t배정→완료 평균(초)');
  for (const [hour, row] of Object.entries(result.hours).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${hour}\t${row.assigned}\t${row.completed}\t${row.succeeded}\t${row.rejected}\t${row.landed ?? '미측정'}\t${row.averageWaitSeconds ?? '미측정'}`);
  }
  return lines.join('\n');
}

export function registerTrainThroughputCommands(resources: Command, deps: TrainThroughputCliDeps = {}): void {
  resources.command('throughput').description('호스트·시간별 열차 배정, 거부, 대기, 착지 통계 (읽기 전용)')
    .requiredOption('--date <yyyy-mm-dd>', '로그 날짜(KST)')
    .option('--log <path>', 'train-auto-loop 로그 파일 (반복 가능)', (value: string, previous: string[] = []) => [...previous, value], [])
    .option('--summary <path>', '열차 요약 JSON (반복 가능)', (value: string, previous: string[] = []) => [...previous, value], [])
    .option('--json', 'JSON 출력')
    .action((opts: { date: string; log: string[]; summary: string[]; json?: boolean }) => {
      if (!isValidTrainDate(opts.date)) {
        console.error('날짜는 YYYY-MM-DD 형식이어야 합니다.');
        process.exitCode = 2;
        return;
      }
      try {
        const result = summarizeTrainThroughputFiles(opts.log, opts.summary, opts.date, deps.readFile);
        if (opts.json) console.log(JSON.stringify(result));
        else console.log(formatTrainThroughputText(result));
      } catch (error) {
        console.error(`열차 처리량을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
