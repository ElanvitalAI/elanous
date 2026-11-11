import { recordHotspotStartForecast, type HotspotStartObservation } from '../cli/hotspot-start-forecast.js';
import { simulateTrainManagerWorld, type TrainManagerWorldInput } from './train-manager-world.js';

/** Reuse the MVP-B train world while capturing the work-start supervisor's ledger writes. */
export async function simulateHotspotFileLeaseWorld(input: TrainManagerWorldInput & {
  plannedStart: HotspotStartObservation;
  owner: string;
}) {
  const rows = recordHotspotStartForecast({
    base: input.base, owner: input.owner, verdict: input.plannedStart,
    now: () => new Date(input.now ?? '2026-11-10T00:00:00.000Z'), append: () => {},
  });
  const train = await simulateTrainManagerWorld(input);
  return { rows, train, conflictForecastJsonl: rows.map(row => JSON.stringify(row)).join('\n')
    + (rows.length ? '\n' : '') + train.conflictForecastJsonl };
}
