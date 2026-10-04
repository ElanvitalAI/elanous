#!/usr/bin/env bun
// omni-crawl monitor — Firecrawl Monitors 관리 CLI (specs/firecrawl/monitor-*.md 기준)
//
// 페이지 변경감지 모니터(뉴스룸/IR/공시 등)를 생성·조회·삭제한다.
// 알림 경로: 웹훅은 public URL 필요 → 우리는 **폴링** — elanous 크론
// (scripts/firecrawl-monitor-alert.ts)이 checks를 주기 조회해 변경분을
// /v1/outbound(텔레그램)로 발송한다. 여기는 셋업/디버그 표면.
//
// 사용:
//   bun scripts/monitor.ts create --name "삼성 뉴스룸" --urls "https://news.samsung.com/kr" \
//       --schedule "every 1 hours" --goal "새 기사/공지 등장 시 알림"
//   bun scripts/monitor.ts list
//   bun scripts/monitor.ts checks <monitorId> [--limit 5]
//   bun scripts/monitor.ts check <monitorId> <checkId>
//   bun scripts/monitor.ts run <monitorId>          # 즉시 1회 체크
//   bun scripts/monitor.ts delete <monitorId>

import { parseArgs } from 'node:util';
import { initEnv, env } from '../src/env.js';
import { validatePublicHttpUrl } from '../src/url-safety.js';
import { writeStdoutJson } from '../src/stdout-json.js';

initEnv();

const BASE = 'https://api.firecrawl.dev/v2';

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const key = env('FIRECRAWL_API_KEY');
  if (!key) { console.error('FIRECRAWL_API_KEY 미설정 (.env)'); process.exit(1); }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`HTTP ${res.status}: ${text.slice(0, 300)}`); process.exit(1); }
  try { return JSON.parse(text); } catch { return text; }
}

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name:     { type: 'string' },
    urls:     { type: 'string' },                 // comma-separated
    schedule: { type: 'string' },                 // 자연어 ("every 1 hours") 또는 cron
    goal:     { type: 'string' },                 // 판정 목표 (변경 페이지당 judge 1cr)
    timezone: { type: 'string' },
    limit:    { type: 'string' },
    json:     { type: 'boolean', default: false },
  },
});

const cmd = positionals[0];

async function main() {
  switch (cmd) {
    case 'create': {
      if (!flags.name || !flags.urls || !flags.schedule) {
        console.error('필수: --name --urls --schedule'); process.exit(1);
      }
      const monUrls = flags.urls.split(',').map(u => u.trim()).filter(Boolean);
      for (const u of monUrls) {
        const err = await validatePublicHttpUrl(u, { action: 'monitor' });
        if (err) { console.error(`URL 거부(${u}): ${err}`); process.exit(1); }
      }
      const body: Record<string, unknown> = {
        name: flags.name,
        schedule: /^[\d*/, -]+$/.test(flags.schedule)
          ? { cron: flags.schedule, timezone: flags.timezone ?? 'Asia/Seoul' }
          : { text: flags.schedule, timezone: flags.timezone ?? 'Asia/Seoul' },
        targets: [{ type: 'scrape', urls: monUrls }],
        ...(flags.goal ? { goal: flags.goal } : {}),
      };
      const r = await api('POST', '/monitor', body);
      const m = r?.data ?? r;
      console.log(`생성됨: ${m.id}`);
      console.log(`  name: ${m.name}`);
      console.log(`  cron: ${m.schedule?.cron ?? '?'} (${m.schedule?.timezone ?? ''}) · next: ${m.nextRunAt ?? '?'}`);
      console.log(`  예상 크레딧/월: ${m.estimatedCreditsPerMonth ?? '?'}`);
      break;
    }
    case 'list': {
      const r = await api('GET', '/monitor');
      const items: any[] = r?.data ?? r ?? [];
      if (flags.json) { await writeStdoutJson(JSON.stringify(items, null, 2) + '\n'); break; }
      for (const m of items) {
        console.log(`${m.id}  [${m.enabled === false ? 'OFF' : 'ON'}] ${m.name}`);
        console.log(`   cron ${m.schedule?.cron ?? '?'} · next ${m.nextRunAt ?? '?'} · ~${m.estimatedCreditsPerMonth ?? '?'}cr/월`);
      }
      if (!items.length) console.log('(모니터 없음)');
      break;
    }
    case 'checks': {
      const id = positionals[1];
      if (!id) { console.error('사용: checks <monitorId>'); process.exit(1); }
      const r = await api('GET', `/monitor/${id}/checks?limit=${flags.limit ?? '5'}`);
      const items: any[] = r?.data ?? r ?? [];
      if (flags.json) { await writeStdoutJson(JSON.stringify(items, null, 2) + '\n'); break; }
      for (const c of items) {
        const s = c.summary ?? {};
        console.log(`${c.id}  ${c.status ?? '?'} @ ${c.finishedAt ?? c.startedAt ?? '?'}`);
        console.log(`   same ${s.same ?? '?'} · changed ${s.changed ?? '?'} · new ${s.new ?? '?'} · removed ${s.removed ?? '?'} · credits ${c.actualCredits ?? '?'}`);
      }
      if (!items.length) console.log('(체크 없음)');
      break;
    }
    case 'check': {
      const [ , id, checkId ] = positionals;
      if (!id || !checkId) { console.error('사용: check <monitorId> <checkId>'); process.exit(1); }
      const r = await api('GET', `/monitor/${id}/checks/${checkId}`);
      await writeStdoutJson(JSON.stringify(r?.data ?? r, null, 2) + '\n');
      break;
    }
    case 'run': {
      const id = positionals[1];
      if (!id) { console.error('사용: run <monitorId>'); process.exit(1); }
      const r = await api('POST', `/monitor/${id}/run`);
      await writeStdoutJson(JSON.stringify(r?.data ?? r, null, 2) + '\n');
      break;
    }
    case 'update': {
      // 부분 업데이트 (PATCH): --schedule (cron 또는 자연어) / --goal / --name
      const id = positionals[1];
      if (!id) { console.error('사용: update <monitorId> [--schedule "<cron|text>"] [--goal ...] [--name ...]'); process.exit(1); }
      const body: Record<string, unknown> = {};
      if (flags.schedule) {
        body.schedule = /^[\d*/, -]+$/.test(flags.schedule)
          ? { cron: flags.schedule, timezone: flags.timezone ?? 'Asia/Seoul' }
          : { text: flags.schedule, timezone: flags.timezone ?? 'Asia/Seoul' };
      }
      if (flags.goal) body.goal = flags.goal;
      if (flags.name) body.name = flags.name;
      if (!Object.keys(body).length) { console.error('변경할 필드 없음 (--schedule/--goal/--name)'); process.exit(1); }
      const r = await api('PATCH', `/monitor/${id}`, body);
      const m = r?.data ?? r;
      console.log(`갱신됨: ${m.id ?? id} · cron ${m.schedule?.cron ?? '?'} (${m.schedule?.timezone ?? ''}) · next ${m.nextRunAt ?? '?'} · ~${m.estimatedCreditsPerMonth ?? '?'}cr/월`);
      break;
    }
    case 'delete': {
      const id = positionals[1];
      if (!id) { console.error('사용: delete <monitorId>'); process.exit(1); }
      await api('DELETE', `/monitor/${id}`);
      console.log(`삭제됨: ${id}`);
      break;
    }
    default:
      console.log('사용: monitor.ts create|list|checks|check|run|delete ...  (헤더 주석 참조)');
      process.exit(cmd ? 1 : 0);
  }
}

main().catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
