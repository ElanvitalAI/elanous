import { planAppScratchBootstrap, type AppScratchBootstrapPlan } from '../self-dev/app-scratch-bootstrap.js';

export interface AppScratchScenario {
  readonly request: string;
  readonly naturalLanguageDispatch?: boolean;
  readonly targetStatus?: string;
  readonly entries?: readonly string[];
}

export interface AppScratchObservation {
  readonly scenario: AppScratchScenario;
  readonly plan: AppScratchBootstrapPlan;
}

/** Exercises the production bootstrap policy without touching a real folder or running git. */
export function simAppScratchBootstrap(scenario: AppScratchScenario): AppScratchObservation {
  return {
    scenario,
    plan: planAppScratchBootstrap({
      request: scenario.request,
      naturalLanguageDispatch: scenario.naturalLanguageDispatch ?? true,
      targetStatus: scenario.targetStatus ?? 'non-git-dir',
      entries: scenario.entries ?? [],
    }),
  };
}

export function appScratchBootstrapSweep(): AppScratchObservation[] {
  return [
    simAppScratchBootstrap({ request: '앱 만들어줘' }),
    simAppScratchBootstrap({ request: 'Build a React web app' }),
    simAppScratchBootstrap({ request: '앱 만들어줘, frontend/ 아래에 작성' }),
    simAppScratchBootstrap({ request: '앱 만들어줘, frontend/, 아래에 작성' }),
    simAppScratchBootstrap({ request: '앱 만들어줘, README.md부터 작성' }),
    simAppScratchBootstrap({ request: 'make changes to the app' }),
    simAppScratchBootstrap({ request: '앱 만들어줘가 아니라 기존 앱 수정해줘' }),
    simAppScratchBootstrap({ request: 'Create a macOS app' }),
    simAppScratchBootstrap({ request: 'Create an Electron app' }),
    simAppScratchBootstrap({ request: '앱 만들어줘, Linux 네이티브 앱으로' }),
    simAppScratchBootstrap({ request: 'Build a beautiful app' }),
    simAppScratchBootstrap({ request: '앱 만들어줘, src/server.py에서 시작' }),
    simAppScratchBootstrap({ request: '앱 만들어줘, src/BUILD에서 시작' }),
    simAppScratchBootstrap({ request: '앱 만들어줘, Dockerfile부터 작성' }),
    simAppScratchBootstrap({ request: "don't create an app" }),
    simAppScratchBootstrap({ request: 'Create a desktop calculator app' }),
    simAppScratchBootstrap({ request: 'Build a new app instead of the existing app' }),
    simAppScratchBootstrap({ request: '앱 만들어줘', entries: ['notes.md'] }),
    simAppScratchBootstrap({ request: '앱 만들어줘', targetStatus: 'git-repo' }),
    simAppScratchBootstrap({ request: 'Fix the app startup bug' }),
    simAppScratchBootstrap({ request: '앱 만들어줘', naturalLanguageDispatch: false }),
  ];
}

export function renderAppScratchBootstrap(rows: readonly AppScratchObservation[]): string[] {
  return [
    'app-scratch-bootstrap · empty explicitly-selected folder only',
    ...rows.map(({ scenario, plan }) => `${JSON.stringify(scenario)} → git-init=${plan.autoInitGit ? 'yes' : 'no'} · 대상 경로=${plan.inferredTargetPaths.join(' · ') || '(ground normally)'}`),
  ];
}
