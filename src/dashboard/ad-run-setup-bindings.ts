import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAdRunSetup } from '../ad-pipeline/ad-run-setup.js';
import type { CommandRunner } from '../ad-pipeline/higgsfield-backend.js';
import type { ShootRunOptions } from '../ad-pipeline/shoot-run.js';
import type { QcThresholds } from '../ad-pipeline/qc.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import {
  createDashboardAdSlashRuntime as createAdSlashRuntime,
  type DashboardAdSlashRuntime,
  type DashboardAdSlashRuntimeDeps,
} from './ad-slash-runtime.js';

const dashboardDefaultShootRunOptions: Required<Pick<ShootRunOptions, 'pollIntervalMs' | 'maxPollsPerJob' | 'submitStaggerMs'>> = {
  pollIntervalMs: 3_000,
  // 2026-09-12 seedance_2_0 measured 330–400s; 174 polls = 522s, leaving 402s after six 20s staggers.
  maxPollsPerJob: 174,
  submitStaggerMs: 20_000,
};

/**
 * ⛔ `src/ad-pipeline/ad-run-setup.ts` 의 `optionalProductionInputs` «사본»이다 — 그 목록은 export 가 아니다.
 * 여기서 다시 세는 이유: 이 파일이 `buildAdRunSetup` «뒤»에 `assemblyMaterials` 를 덧붙이므로,
 * 그 함수가 «입력» 기준으로 낸 목록은 최종 `production` 과 어긋난다(`#17880`).
 * ⚠️ 사본이라 «늙는다» — `src/dashboard/index.test.ts` 가 권위 목록과 같은지 단언한다.
 */
export const dashboardOptionalProductionInputs = [
  'assembly',
  'assemblyMaterials',
  'captionFontPath',
  'musicBedPath',
  'qcThresholds',
  'voiceover',
  'soundtrack',
  'referenceAssets',
  'shootRunOptions',
  'ground',
  'invariants',
] as const;

export interface DashboardAdAssetPreset {
  readonly captionFontPath?: string;
  readonly musicBedPath?: string;
  readonly referenceAssets?: Readonly<Record<string, string[]>>;
  readonly shootRunOptions?: ShootRunOptions;
  readonly qcThresholds?: QcThresholds;
}

/** Operator-owned, instance-scoped optional asset preset; never a repository asset path. */
export function dashboardAdAssetPresetPath(stateRoot = elanousStateRoot()): string {
  return join(stateRoot, 'ad-assets.json');
}

/** Reads optional operator-owned asset paths without inventing local defaults. */
export function loadDashboardAdAssetPreset(path: string): DashboardAdAssetPreset {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`dashboard ad asset preset unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: expected an object`);
  }

  const preset = parsed as Record<string, unknown>;
  for (const key of ['captionFontPath', 'musicBedPath'] as const) {
    if (preset[key] !== undefined && typeof preset[key] !== 'string') {
      throw new Error(`dashboard ad asset preset malformed at ${path}: ${key} must be a string`);
    }
  }
  if (preset.referenceAssets !== undefined && (
    preset.referenceAssets === null
    || typeof preset.referenceAssets !== 'object'
    || Array.isArray(preset.referenceAssets)
    || Object.values(preset.referenceAssets).some((value) => !Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
  )) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: referenceAssets must be a record of string arrays`);
  }
  if (preset.shootRunOptions !== undefined && (
    preset.shootRunOptions === null
    || typeof preset.shootRunOptions !== 'object'
    || Array.isArray(preset.shootRunOptions)
  )) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: shootRunOptions must be an object`);
  }
  const shootRunOptions = preset.shootRunOptions as Record<string, unknown> | undefined;
  for (const key of ['pollIntervalMs', 'maxPollsPerJob', 'maxPollElapsedMs', 'submitStaggerMs', 'submitRetries'] as const) {
    if (shootRunOptions?.[key] !== undefined && (typeof shootRunOptions[key] !== 'number' || !Number.isFinite(shootRunOptions[key]))) {
      throw new Error(`dashboard ad asset preset malformed at ${path}: shootRunOptions.${key} must be a finite number`);
    }
  }
  if (preset.qcThresholds !== undefined && (
    preset.qcThresholds === null
    || typeof preset.qcThresholds !== 'object'
    || Array.isArray(preset.qcThresholds)
  )) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds must be an object`);
  }
  const qcThresholds = preset.qcThresholds as Record<string, unknown> | undefined;
  for (const key of ['dialogueLufsTolerance', 'colorDistance', 'frameDiffVariance'] as const) {
    if (qcThresholds?.[key] !== undefined && (typeof qcThresholds[key] !== 'number' || !Number.isFinite(qcThresholds[key]))) {
      throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.${key} must be a finite number`);
    }
  }
  if (qcThresholds?.durationRanges !== undefined && (
    qcThresholds.durationRanges === null
    || typeof qcThresholds.durationRanges !== 'object'
    || Array.isArray(qcThresholds.durationRanges)
  )) {
    throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges must be an object`);
  }
  const durationRanges = qcThresholds?.durationRanges as Record<string, unknown> | undefined;
  for (const scope of ['cut', 'master'] as const) {
    if (durationRanges?.[scope] !== undefined && (
      durationRanges[scope] === null
      || typeof durationRanges[scope] !== 'object'
      || Array.isArray(durationRanges[scope])
    )) {
      throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.${scope} must be an object`);
    }
    const range = durationRanges?.[scope] as Record<string, unknown> | undefined;
    if (range !== undefined) {
      const minimumSeconds = range.minimumSeconds;
      const maximumSeconds = range.maximumSeconds;
      if (typeof minimumSeconds !== 'number' || !Number.isFinite(minimumSeconds)) {
        throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.${scope}.minimumSeconds must be a finite number`);
      }
      if (typeof maximumSeconds !== 'number' || !Number.isFinite(maximumSeconds)) {
        throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.${scope}.maximumSeconds must be a finite number`);
      }
      if (minimumSeconds > maximumSeconds) {
        throw new Error(`dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.${scope}.minimumSeconds must be less than or equal to maximumSeconds`);
      }
    }
  }
  return {
    ...(typeof preset.captionFontPath === 'string' ? { captionFontPath: preset.captionFontPath } : {}),
    ...(typeof preset.musicBedPath === 'string' ? { musicBedPath: preset.musicBedPath } : {}),
    ...(preset.referenceAssets === undefined ? {} : { referenceAssets: preset.referenceAssets as Record<string, string[]> }),
    ...(shootRunOptions === undefined ? {} : { shootRunOptions: shootRunOptions as ShootRunOptions }),
    ...(qcThresholds === undefined ? {} : { qcThresholds: qcThresholds as QcThresholds }),
  };
}

export const dashboardAdCommandRunner: CommandRunner = {
  async run(argv, options) {
    const process = Bun.spawn([...argv], {
      stdout: 'pipe',
      stderr: 'pipe',
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    const [raw, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).bytes(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { stdout: new TextDecoder().decode(raw), stderr, exitCode, raw };
  },
};

export function createDashboardAdRunSetupFactory(input: {
  readonly home: string;
  readonly date: string;
  readonly contractsJson: string;
  readonly runner: CommandRunner;
  readonly assetPresetPath?: string;
}): (allowSpend: boolean) => ReturnType<typeof buildAdRunSetup> {
  let runSequence = 0;
  let activeRunSlug: string | undefined;

  return (allowSpend) => {
    if (!allowSpend) {
      const runStart = new Date();
      const time = [runStart.getHours(), runStart.getMinutes(), runStart.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join('');
      activeRunSlug = `dashboard-ad-${time}-${++runSequence}`;
    }
    const slug = activeRunSlug ?? (() => {
      const runStart = new Date();
      const time = [runStart.getHours(), runStart.getMinutes(), runStart.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join('');
      return `dashboard-ad-${time}-${++runSequence}`;
    })();
    const assetPreset = input.assetPresetPath === undefined ? {} : loadDashboardAdAssetPreset(input.assetPresetPath);
    let setup = buildAdRunSetup({
      home: input.home,
      slug,
      date: input.date,
      version: 1,
      aspect: '9x16',
      contractsJson: input.contractsJson,
      runner: input.runner,
      ...assetPreset,
      referenceAssets: assetPreset.referenceAssets ?? {},
      shootRunOptions: { ...dashboardDefaultShootRunOptions, ...assetPreset.shootRunOptions },
      soundtrack: input.runner,
      voiceover: { runner: input.runner, lines: [] },
      allowSpend,
    });
    if (!('error' in setup) && setup.production) {
      const production = {
        ...setup.production,
        assemblyMaterials: { options: { workDir: setup.workDir, outputName: setup.outputName } },
      };
      setup = {
        ...setup,
        production,
        missingProductionInputs: dashboardOptionalProductionInputs.filter((key) => production[key] === undefined),
      };
    }
    return setup;
  };
}

/** Builds the /ad runtime bindings used by showDashboard for each invocation's spend intent. */
export function createDashboardAdRunSetupBindings(
  buildDashboardAdRunSetup: ReturnType<typeof createDashboardAdRunSetupFactory>,
) {
  let adRunSetup: ReturnType<typeof buildAdRunSetup> | undefined;
  let outputSetupError: string | undefined;
  try {
    adRunSetup = buildDashboardAdRunSetup(false);
    outputSetupError = 'error' in adRunSetup ? adRunSetup.error : undefined;
  } catch (error) {
    outputSetupError = error instanceof Error ? error.message : String(error);
  }

  return {
    production: adRunSetup && !('error' in adRunSetup) ? adRunSetup.production : undefined,
    productionForSpend: (allowSpend: boolean) => {
      try {
        const setup = buildDashboardAdRunSetup(allowSpend);
        if ('error' in setup) {
          outputSetupError = setup.error;
          return undefined;
        }
        return setup.production;
      } catch (error) {
        outputSetupError = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    },
    missingProductionInputs: adRunSetup && !('error' in adRunSetup) ? adRunSetup.missingProductionInputs : undefined,
    get outputSetupError() {
      return outputSetupError;
    },
  };
}

/** Connects the dashboard's setup state to the actual /ad runtime. */
export function createDashboardAdSlashRuntime(
  input: Omit<DashboardAdSlashRuntimeDeps, 'production' | 'productionForSpend' | 'missingProductionInputs' | 'outputSetupError'> & {
    readonly adRunSetupBindings?: ReturnType<typeof createDashboardAdRunSetupBindings>;
    readonly adRunSetupError?: string;
  },
): DashboardAdSlashRuntime {
  const { adRunSetupBindings, adRunSetupError, ...deps } = input;
  return createAdSlashRuntime({
    ...deps,
    production: adRunSetupBindings?.production,
    productionForSpend: adRunSetupBindings?.productionForSpend,
    missingProductionInputs: adRunSetupBindings?.missingProductionInputs,
    get outputSetupError() {
      return adRunSetupBindings?.outputSetupError ?? adRunSetupError;
    },
  });
}

