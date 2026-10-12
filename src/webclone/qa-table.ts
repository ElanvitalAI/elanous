import {
  compareLayoutAcrossViewports,
  renderResponsiveSection,
  type ViewportSample,
} from './responsive-layout.js';

const QA_WIDTHS = [390, 768, 1280] as const;

export function siteQaTable(samples: readonly ViewportSample[]): {
  widths: number[];
  lines: string[];
  realDevice: '미확인';
} {
  const qaSamples = samples.filter((sample) => QA_WIDTHS.some((width) => width === sample.width));
  const report = compareLayoutAcrossViewports(qaSamples);
  const lines = [`폭 ${QA_WIDTHS.join(' · ')}`];
  for (const width of QA_WIDTHS) {
    if (!qaSamples.some((sample) => sample.width === width)) lines.push(`${width} 못 잼`);
  }
  lines.push(...renderResponsiveSection(report), '실기기: 미확인');
  return { widths: [...QA_WIDTHS], lines, realDevice: '미확인' };
}
