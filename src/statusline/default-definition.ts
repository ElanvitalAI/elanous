/** Bundled default (STATUSLINE-WIRE 11-17). Priority (OP 11-17): ① exceptions (a failed turn, red) ② the turn as a
 *  short clause (`● running 3m`) ③ the cwd (folder) ④ the version · channel (`261117_1925·dev`) ⑤ the model ⑥ the
 *  counters. xs/sm/md are that short line; lg is the old full footer (`facts`, src/tui/chat/status-line.ts) followed by
 *  the cwd and the version — the Next TUI uses it from 120 columns only while both still fit (next-tui.ts).
 *  turn/model/elapsed/tokens/queue/background stay defined for user layouts.
 *  STATUSLINE-SOURCES-RESPONSIVE slice 1: `fleet` (source machines · sources/machines.ts) — one exception-first value
 *  for the hosts («●» healthy · «⚑ node-c 1.4×» hot in red · «▲ …» warm in amber · «node-b ?» unknown), in md and lg
 *  after the version and dropped first; drawn only when a poller feeds it. provider / alerts stay for later slices. */
// #38392 (대표): model_lg is the model on its own in the wide layout, drawn only when the turn sentence (facts, which
// already names the model) is left out of the bottom line during a turn — so the model shows idle and running, once.
export const DEFAULT_STATUSLINE_YAML = `
segments:
  - { id: facts, source: session, field: facts }
  - { id: turn_short, source: session, field: turn_short }
  - { id: model_short, source: session, field: model_short }
  - { id: model_lg, source: session, field: model_short, when: "session_turn_hidden == yes" }
  - { id: rest_short, source: session, field: rest_short }
  - { id: turn, source: session, field: turn, label: "Turn" }
  - { id: model, source: session, field: model, label: "Model" }
  - { id: elapsed, source: session, field: elapsed, label: "Elapsed" }
  - { id: tokens, source: session, field: tokens, label: "Tokens" }
  - { id: queue, source: session, field: queue, label: "Queue" }
  - { id: background, source: session, field: background, label: "Bg", format: count }
  - { id: cwd, source: session, field: cwd }
  - { id: cwd_leaf, source: session, field: cwd_leaf }
  - { id: version, source: build, field: label }
  - { id: version_short, source: build, field: short }
  - { id: fleet, source: machines, field: text, when: "machines_level != none" }
  - { id: provider_usage, source: provider, field: usage, label: "Usage", format: ratio }
  - { id: provider_dot, source: provider, field: status, format: dot }
  - { id: alerts, source: alerts, field: count, label: "Alerts", format: count }
rules:
  - { id: turn-exception, when: session_exception == yes, color: red, segments: [turn_short] }
  - { id: build-official, when: build_channel == official, color: green, segments: [version, version_short] }
  - { id: build-dev, when: build_channel == dev, color: yellow, segments: [version, version_short] }
  - { id: fleet-hot, when: machines_level == danger, color: red, segments: [fleet] }
  - { id: fleet-warm, when: machines_level == warn, color: amber, segments: [fleet] }
  - { id: provider-hot, when: provider_usage > 0.85, color: amber, glyph: "!", segments: [provider_usage] }
  - { id: alerts-hide-clear, when: alerts_count == 0, hide: true, segments: [alerts] }
layouts:
  - band: xs
    lines: 1
    segments: [turn_short, cwd_leaf, version_short, model_short, rest_short]
    drop: [rest_short, model_short, version_short]
  - band: sm
    lines: 1
    segments: [turn_short, cwd_leaf, version_short, model_short, rest_short]
    drop: [rest_short, model_short]
  - band: md
    lines: 1
    segments: [turn_short, cwd_leaf, version_short, fleet, model_short, rest_short]
    drop: [rest_short, model_short, fleet]
  - band: lg
    lines: 1
    segments: [facts, model_lg, cwd, version, fleet]
    drop: [fleet, cwd, version]
    shorten: { cwd: cwd_leaf, version: version_short }
`;
