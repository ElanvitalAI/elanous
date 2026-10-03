#!/usr/bin/env bun
// 종합 아침 브리핑: 밤사이 소스 종합 → 에센셜(텔레그램) + 상세(S3 md+html 링크).
//   bun run scripts/morning-report.ts             # compose + send
//   bun run scripts/morning-report.ts --dry        # compose only (stdout, no send)
//   bun run scripts/morning-report.ts --no-narrate # skip the LLM 시장서사 layer
//   bun run scripts/morning-report.ts --no-upload  # skip S3 상세 업로드(로컬 미리보기)

import { composeMorningReport } from '../src/domains/morning-report.js';
import { sendTelegramReport, sendReportPhoto } from '../src/telegram-report.js';
import { getUserConfig } from '../src/user-config.js';
import { getFirecrawlConfig } from '../src/registry/discovery/config.js';
import { captureFinvizMapImageUrl } from '../src/domains/finviz-image.js';

const dry = process.argv.includes('--dry');
const cfg = getUserConfig();
const narrate = cfg.finance.morningNarrative !== false && !process.argv.includes('--no-narrate');
const upload = !process.argv.includes('--no-upload');

// finviz S&P 히트맵 이미지 — HTML 상세 리포트에 임베드 + 텔레그램 포토로도 발송. 키 있을 때만.
let heatmapImageUrl: string | undefined;
if (cfg.finance.morningHeatmapImage !== false) {
  try {
    const apiKey = getFirecrawlConfig(cfg).apiKey;
    if (apiKey) heatmapImageUrl = (await captureFinvizMapImageUrl(apiKey)) || undefined;
    else console.error('[morning-report] heatmap skipped — firecrawl API key 없음 (user-config registry.discovery.firecrawl.apiKey 또는 FIRECRAWL_API_KEY 설정 필요)');
  } catch (e) { console.error(`[morning-report] heatmap capture error: ${e instanceof Error ? e.message : String(e)}`); }
}

const report = await composeMorningReport(new Date(), { narrate, heatmapImageUrl, upload });

if (dry) {
  console.log(report);
} else {
  const sent = await sendTelegramReport(cfg, report, { markdown: true, kind: 'report' });
  console.error(sent
    ? '[morning-report] sent to report channel ✓'
    : '[morning-report] no report channel configured — skipped');

  // 히트맵 이미지 첨부(위에서 캡처한 URL 재사용). fail-soft.
  if (heatmapImageUrl) {
    try {
      const ok = await sendReportPhoto(cfg, heatmapImageUrl, { caption: '🗺️ S&P 500 히트맵 (finviz)', kind: 'report' });
      console.error(ok ? '[morning-report] heatmap image sent ✓' : '[morning-report] heatmap: no report channel');
    } catch (e) { console.error(`[morning-report] heatmap image error: ${e instanceof Error ? e.message : String(e)}`); }
  }
}
