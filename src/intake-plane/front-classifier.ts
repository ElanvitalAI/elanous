import { debug } from '../debug/log.js';
import { detectUrlRoute, extractUrls, type UrlRouteDecision, type UrlRoutingConfig } from '../skills/url-router.js';
import { decideIntakeFrontRoute, INTAKE_FRONT_IMPLEMENT_WORDS, type DecideIntakeFrontRouteInput, type IntakeFrontRouteDecision } from './front-route-rules.js';

export const INTAKE_FRONT_QUESTION_WORDS = [
  '뭐', '무엇', '어떻게', '왜', '언제', '어디', '누구', '몇', '어느', '할까', '인가요',
  'what', 'how', 'why', 'when', 'where', 'who', 'which',
] as const;

type FrontInputKind = 'link' | 'instruction' | 'list' | 'question' | 'memo';

export interface FrontClassifierInput extends DecideIntakeFrontRouteInput {
  surface: 'pwa' | 'pwa-chat' | 'telegram' | 'tui' | 'external';
}

export interface FrontClassifierDecision extends IntakeFrontRouteDecision {
  kind: FrontInputKind;
  urlRoute: UrlRouteDecision | null;
}

/** Only Telegram links explicitly routed to saved/absorbed work enter the event lane. */
export function telegramAbsorbUrls(input: FrontClassifierInput, decision: FrontClassifierDecision): string[] {
  if (input.surface !== 'telegram' || decision.track !== 'absorb' || !decision.urlRoute) return [];
  return decision.urlRoute.urls;
}

const QUESTION_WORD_RE = new RegExp(
  `(?:${INTAKE_FRONT_QUESTION_WORDS.map((word) => /^[a-z]+$/i.test(word) ? `(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])` : word).join('|')})[.!?。？！]*$`,
  'iu',
);
const IMPLEMENT_WORD_RE = new RegExp(INTAKE_FRONT_IMPLEMENT_WORDS.join('|'), 'iu');

export function classifyFrontInput(
  input: FrontClassifierInput,
  deps: { urlRouting: UrlRoutingConfig },
): FrontClassifierDecision {
  const { text, surface, hint, consent } = input;
  const route = decideIntakeFrontRoute({ text, hint, consent });
  const urlRoute = detectUrlRoute(text, deps.urlRouting);
  const trimmed = text.trim();
  const urls = extractUrls(text);
  const kind: FrontInputKind = route.reason === 'imperative-implement' || route.reason === 'url-implement'
    || (urls.length > 0 && IMPLEMENT_WORD_RE.test(text.replace(/https?:\/\/\S+/gi, ' ')))
    ? 'instruction'
    : urls.length > 0
      ? 'link'
      : route.reason === 'list'
        ? 'list'
        : /[?？]$/.test(trimmed) || QUESTION_WORD_RE.test(trimmed)
          ? 'question'
          : 'memo';

  debug.log('intake.front-classifier', 'classified', {
    surface,
    kind,
    track: route.track,
    urlKind: urlRoute?.kind ?? null,
    textLength: text.length,
  });

  return { ...route, kind, urlRoute };
}
