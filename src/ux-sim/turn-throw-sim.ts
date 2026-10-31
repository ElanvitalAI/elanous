export interface TurnThrowSimOptions {
  stage: string;
  delayMs?: number;
  error?: Error;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type TurnThrowSim = (stage: string) => Promise<void>;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createTurnThrowSim(options: TurnThrowSimOptions): TurnThrowSim {
  if (!options.stage.trim()) throw new Error('turn throw simulation stage must be non-empty');
  const delayMs = options.delayMs ?? 0;
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('turn throw simulation delayMs must be a non-negative finite number');
  return async (stage) => {
    if (stage !== options.stage) return;
    if (delayMs > 0) await (options.sleep ?? defaultSleep)(delayMs);
    throw options.error ?? new Error(`simulated turn body failure at ${stage}`);
  };
}

/** The production path remains inert unless the explicit simulation environment is configured. */
export const runConfiguredTurnThrowSim: TurnThrowSim = async (stage) => {
  const configuredStage = process.env.ELANOUS_UX_SIM_TURN_THROW_STAGE;
  if (!configuredStage) return;
  const parsedDelay = Number(process.env.ELANOUS_UX_SIM_TURN_THROW_DELAY_MS ?? '0');
  const simulate = createTurnThrowSim({ stage: configuredStage, delayMs: parsedDelay });
  await simulate(stage);
};
