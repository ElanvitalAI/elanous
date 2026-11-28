// KIT mail-route — one place for how seat mail is folded, windowed, rerouted and signed (CEO 11-27 «중복된 내용들 정리»).
//   policy     one window/cadence policy (30-min default · P0 never waits) from the policy file, not constants
//   digest     the one digest builder (line · block · fold) the TUI bundle, the repl path and the diverted ledgers use
//   fold-once  a mail id is listed in a seat's turn once, whichever path lists it first
//   dormant    dormant-address reroute with the live probe both sender entrances share
//   sender     `--from` = the caller's seat for child `eln msg post`
//   hand-route a ✋ block goes ONCE to the owner of its root — the table is DATA: hand-routes.yaml (WIP → TC · JUD verdict /
//              HOLD → JUDGE-BUTLER · env/host/lease → GUARDIAN · cell scope → the cell's owner · design → the old rung)
//   hand-dedupe the same ✋ ask (seat · root · cell) inside 30 min is answered by reference to its first row
//   dormant-watch rerouted dormant-seat mail unanswered for 10 min → one OP card
//   steward-mail 우정 행정관 steward:mail — wake-now · digest · record-only per coordinator mail (steward-mail.yaml) · SHADOW:
//              records «would have woken» next to the router (`eln msg steward-shadow` · graphs/triggers/steward-mail.yaml)
export * from './policy.js';
export * from './digest.js';
export * from './fold-once.js';
export * from './dormant.js';
export * from './sender.js';
export * from './hand-route.js';
export * from './entrance.js';
export * from './hand-classifier.js';
export * from './hand-routes.js';
export * from './hand-cells.js';
export * from './hand-dedupe.js';
export * from './dormant-watch.js';
export * from './steward-mail.js';
