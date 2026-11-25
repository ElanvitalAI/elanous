/** Sparkline — «▁▂▃▅▆▇ 14 (target 20)» with a «✓ above target» mark once the last value crosses the target. */
import { fit, num } from './text.js';

const LEVELS = '▁▂▃▄▅▆▇█';

export function renderSparkline(props: { readonly label: string; readonly values: readonly number[]; readonly target?: number; readonly max?: number }, width: number): string {
  const values = props.values;
  const top = Math.max(1, props.max ?? 0, props.target ?? 0, ...values);
  const spark = values.map((v) => LEVELS[Math.min(7, Math.max(0, Math.round((v / top) * 7)))]).join('');
  const last = values.at(-1);
  const tail = last === undefined ? '—' : num(last);
  const target = props.target === undefined ? '' : last !== undefined && last >= props.target ? ` ✓ above target ${num(props.target)}` : ` (target ${num(props.target)})`;
  return fit(`${props.label} ${spark} ${tail}${target}`, width);
}
