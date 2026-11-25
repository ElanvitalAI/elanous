/**
 * Federation Board top area — composition only. The board today is `els status-board` (a seat table plus one-line
 * tails); this scene turns the numbers it already has into StatRow + Gauges + the release StepList. No data plumbing.
 */
import { renderGauge, renderStatRow, renderStepList, type GaugeProps, type StatProps, type Step } from '../index.js';
import { fit } from '../text.js';

export interface FederationBoardSnapshot {
  /** e.g. «0.3.37». */
  readonly release: string;
  readonly landedPerHour: number;
  readonly landTarget: number;
  readonly greenPerHour: number;
  readonly greenTarget: number;
  readonly seats: { readonly working: number; readonly idle: number; readonly blocked: number };
  readonly handsOpen: number;
  readonly hostLoad: { readonly host: string; readonly value: number; readonly max: number; readonly threshold: number };
  readonly releaseSteps: readonly Step[];
}

const toneOf = (value: number, target: number): StatProps['tone'] => (value >= target ? 'good' : value >= target / 2 ? 'warn' : 'bad');

export function renderFederationBoard(snapshot: FederationBoardSnapshot, width: number): string[] {
  const stats: StatProps[] = [
    { label: 'Landed/h', value: snapshot.landedPerHour, target: snapshot.landTarget, tone: toneOf(snapshot.landedPerHour, snapshot.landTarget) },
    { label: 'Green/h', value: snapshot.greenPerHour, target: snapshot.greenTarget, tone: toneOf(snapshot.greenPerHour, snapshot.greenTarget) },
    { label: 'Seats', value: `${snapshot.seats.working} working · ${snapshot.seats.idle} idle`, ...(snapshot.seats.blocked ? { tone: 'warn' as const } : {}) },
    { label: 'Hands open', value: snapshot.handsOpen, tone: snapshot.handsOpen > 0 ? 'warn' : 'good' },
  ];
  const gauges: GaugeProps[] = [
    { label: 'Landings', value: snapshot.landedPerHour, max: Math.max(snapshot.landTarget, snapshot.landedPerHour) * 1.5, threshold: snapshot.landTarget, unit: '/h' },
    { label: `Load ${snapshot.hostLoad.host}`, value: snapshot.hostLoad.value, max: snapshot.hostLoad.max, threshold: snapshot.hostLoad.threshold },
  ];
  return [
    fit(`Federation Board · ${snapshot.release}`, width),
    ...renderStatRow(stats, width),
    ...gauges.map((gauge) => renderGauge(gauge, width)),
    ...renderStepList({ steps: snapshot.releaseSteps }, width),
  ];
}
