# Solar-only demo handoff · 2026-11-16

The Solar profile owns the three-line user instruction and runs Solar Pro4 with the design domain pack. This plugin consumes the resulting ticketing design file. It never selects a provider or model, overrides `roleLlm`, or calls a second LLM. R-SOLAR owns the live profile invocation; the committed design JSON is a **synthetic fixture**, not a claimed Solar response.

## Input contract

Pass a JSON design result with the fields shown in [the fixture](fixtures/ticketing-design.json): title, summary, at least three requirements, local components, the offload workload, retry/checkpoint capability, export data and classification, region, and expected vCPU/GiB usage. The demo accepts a retryable non-PII `batch` offload only. Purchase, inventory, and payment paths remain local. Unsupported or unclassified data fails closed.

A deterministic pressure fixture is used only for the fake-world rehearsal. The production `detect` node still reads the repository's existing host and queue observations.

## One-roundtrip command

From the repo root, with Playwright/Chromium available to the existing render scripts:

```bash
python scripts/gcp-architect-expand/demo/run.py \
  --ticket-design plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json \
  --pressure plugins/gcp-architect-expand/demo/fixtures/pressure.json \
  --output plugins/gcp-architect-expand/sim/sample-output
```

For the live Solar profile, replace only `--ticket-design` with the Solar design result path. The plugin command has no provider/model flags. `demo-result.json` verifies the input hash, proposal ID, output gate, synthetic approval, idle-stop ledger, and zero real GCP calls. The synthetic approval is solely for the isolated fake world; the production graph retains its HITL spending gate and fail-closed real provisioning recipe.

## Graph v2 fake-world approval rehearsal

Pass a structured design JSON and pressure fixture. Keep the two decisions in separate output directories:

```bash
bun scripts/gcp-architect-expand/demo/run-graph-test-world.ts /tmp/gcpx-scene5-yes /ABS/PATH/structured-design.json plugins/gcp-architect-expand/demo/fixtures/pressure.json y
bun scripts/gcp-architect-expand/demo/run-graph-test-world.ts /tmp/gcpx-scene5-no /ABS/PATH/structured-design.json plugins/gcp-architect-expand/demo/fixtures/pressure.json N
```

The receipt records the graph's approval decision. `y` permits only fake project creation, scheduling, and virtual idle stop, with a cost and resource ledger and zero real GCP calls. `N` ends without creating a fake project. This driver injects the decision through the graph HITL API; the integrated scene 5 receipt still requires the actual TUI keypress and absorb-build graph.

## Legacy standalone preview (not the integrated demo)

```bash
python scripts/gcp-architect-expand/demo/tui.py --test-universe \
  --ticket-design plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json
```

The screen shows the three-line brief, the design result and its source label, all four capacity signals, the unpriced cost formula, savings, and security grade. At `y/N`, `N` writes a receipt and stops before any fake project. `y` binds the displayed proposal SHA-256 to the fake-world run, renders the diagram and PDF, verifies outputs, and offers `d` (PNG), `p` (PDF), or `e` (editable source) to open. The opener uses the system `gio`/`xdg-open`; headless runs still display absolute artifact paths and record opener failure. Each run gets an isolated `.elanous-test/gcp-architect-demo/run-*` directory with `receipt.json`.

This is a standalone preview, not an 11-14/11-16 demo receipt. The integrated acceptance path is **actual classic TUI → `ToolSearch({query:"route:GCP 확장안"})` → selected `gcp_architect_expand` tool → `runGraph` → inline `y/N` → board-card attachments**. A high-risk plugin route is deferred, so its absence from the initial model tool list is expected. The plugin has a Graph v2 declaration and fail-closed real provisioning; it does not own the board consumer.

In a **real `bun bin/elanous.mjs --test=… --legacy` PTY** on #36517 head, a local fake model requested `ToolSearch({query:"route:GCP 확장안"})` first. The classic browse turn's initial 50 tools did not include `ToolSearch`, so that request returned `INVALID TOOL` before GCP route selection. The [PTY seam receipt](classic-pty-seam-receipt.json) records this specific boundary; no `runGraph`, inline `y/N`, or board-card attachment was observed. The earlier forced direct `gcp_architect_expand` call was an invalid probe of a deferred route and is not treated as a routing defect.

OP's 16:00 stack check repeated the actual classic PTY with #36536 head `f0bcee66` merged onto #36517 head `d1a46cd` in a test-only worktree. The [stack receipt](classic-pty-toolsearch-stack-receipt.json) records the same missing model-facing `ToolSearch` entry and `INVALID TOOL` result. #36536's surface-dispatch unit tests passed 2/2, which verifies hydration after dispatch but does not establish that this classic browse turn advertises ToolSearch to the model.

With #36517 `d1a46cd` merged without a commit into a separate test worktree at #36536's newer `ab56c614` head, an isolated **actual classic TUI PTY** with a loopback fake model did advertise ToolSearch in its first request (53 tools). `ToolSearch({query:"route:GCP 확장안"})` returned one matching route, `gcp_architect_expand`; the next request exposed the route (54 tools). The TUI showed the inline `y/N` panel, and `elanous pty text … y --enter` delivered `y`. The route then returned `Error: graph route requires a verified owner context` before `runGraph`. The [new live receipt](classic-pty-live-ab56-receipt.json) records all boundaries: **no diagram or PDF was produced in this PTY, and no board attachment was observed**. `src/dashboard/index.ts` currently passes confirmation context without `verifiedOwner`, while the verified graph dispatcher requires it. The Graph v2 cloud-resource providers are also still absent from production. The test stack was kept outside PR #36512.

Use the short scene prompt `GCP 확장안 실행해줘`. The longer design phrasing containing `설계` activated the current deep-bloom nonresearch branch, which removed ToolSearch from that turn; the short prompt reached route search. The separate [scene 5 script](KCB-SCENE5-RECORDING-SCRIPT.md) has this operator wording. Until owner context and fake-world provider wiring are present in the actual TUI route, use the labeled fallback recording for the diagram/PDF scene rather than claiming a live roundtrip.

## Handoff to R-SOLAR

- Three-line instruction: [brief-3-lines.ko.txt](brief-3-lines.ko.txt)
- Input contract / fixture: [ticketing-design.json](fixtures/ticketing-design.json)
- CLI entry: [run.py](run.py)
- Output directory: `plugins/gcp-architect-expand/sim/sample-output/`
- Required final files: `proposal.json`, `.excalidraw`, `.png`, `.pdf`, `demo-result.json`
- Scene 6 board payload: [BOARD-HANDOFF](BOARD-HANDOFF.md) and `board-attachments.json` in each completed run

## Direct Graph v2 fake-world output proof · 2026-11-10

While #36517 and #36524 are pending, `bun scripts/gcp-architect-expand/demo/run-graph-test-world.ts <isolated-output-dir>` calls the **GCP plugin's own Graph v2 through `runGraph`** with an in-memory fake `cloud-resource` provider. `detect → design → deliverables` executes; `deliverables` calls #36522's shared architecture output graph. The run stops at `approve` with `awaiting-approval`: no spending nodes, GCP API calls, or fabricated human approval occur. The driver adapts the existing fake-world GCP diagram and HTML to the shared output contract, including the official icon registry and headings, without changing the cost formula or inventing a price.

[Checked receipt](graph-direct-test-world-receipt.json) and OP-host artifacts: `~/elanous-hq/seat-state/OP/evidence/20261110/gcpx-direct-graph-final/` (`artifacts/architecture.excalidraw`, `architecture.png`, `architecture.pdf`, `architecture.html`, `verification.json`). Shared verification passed with a six-page PDF and four attachment records whose hashes match the files. This proves direct Graph v2 artifact production in the isolated fake world; it is **not** a classic TUI or board-card receipt. Re-run the full PTY chain after #36517 and #36524 land.

## Scene 4 JSON → scene 5 input seam

Scene 4의 구조화 설계 JSON이 정본 입력이다. GCP `proposal.json`은 출력이며 입력으로 다시 넣으면 어댑터가 거부한다. R-TICKET run `4d4eed28`의 구조화 설계 원문은 `fixtures/scene4-structured-design.json`에 보존하고, SHA-256 `e469fcc57951d5cb0bf9451776ca6036a3a8ed3881f5d15c042ca613606c8b41`로 고정했다. 이는 실제 Scene 4 출력이지만 live Scene 2/3 acceptance 기록은 아니다.

The route's `ticketDesignPath` can point to the **actual structured #36522 design result JSON**: either a top-level `ticketDesign` object or a Graph run state whose `design` node output contains `result.ticketDesign`. `demo/design-result.ts` validates every field needed for a safe non-PII retryable batch proposal. It preserves a supplied session ID and Graph run ID in the normalized proposal; ambiguous booleans, missing classification, prose-only output, and invalid usage fail closed. `demo/run.py --design-result <JSON>` invokes the same adapter and writes `ticketing-design.normalized.json`, `proposal.json`, `demo-result.json`, diagram, PNG and PDF. `inputSha256` hashes the **original JSON bytes**, so the scene 4→5 link is auditable.

For OP relay, this host now has `~/elanous-hq/seat-state/OP/solar/brief-3-lines.ko.txt`, `fixtures/ticketing-design.json`, `fixtures/pressure.json`, `demo/run.py`, and `GCPX-SOLAR-HANDOFF.md`. The fixture is explicitly synthetic; it is a developer test only. The e9d06e7c Solar design session / 15617ca0 graph run JSON is not present on this host or in #36522's committed sample, so no live Solar linkage or hash is claimed. R-SOLAR should provide that raw JSON path to OP; once available, pass it as `--design-result` and use a measured capacity JSON instead of the fixed pressure fixture.

The direct Graph v2 fake provider runner also accepts the same structured design JSON: `bun scripts/gcp-architect-expand/demo/run-graph-test-world.ts <output-dir> <design-result.json> <capacity-signal.json>`. It regenerates a GCP proposal and diagram source from that JSON, invokes the shared output graph, and stops at the spending approval. A synthetic nested-envelope test reached `awaiting-approval` with a six-page verified PDF and four hashed attachments; this does not verify the unavailable e9d06e7c/15617ca0 source.

For measured pressure, run `bun scripts/gcp-architect-expand/demo/export-local-pressure.ts --output <capacity.json>` on the **user's machine**. This serializes the existing self-dev host and harness queue reading; it does not add a collector. The proposal and fake-world proof accept its physical units and statuses without pretending they are CPU/memory/disk usage percentages. Missing/unknown axes fail closed, and no shortage yields no expansion proposal. `--design-result` requires an explicit `--pressure`; the old fixed fixture is still available only when deliberately passed in a test.

## R-SOLAR 18:xx structured-design integration fix

The #36522 structured design may omit `offloadKind`, `retryable`, `checkpointable`, `containsPii`, `dataClass`, `exportData`, region and usage. The adapter projects such absent fields to **unconfirmed assumptions** with `source=gcp-adapter-default` and `requiresConfirmation=true`; explicit unsafe/conflicting values still fail closed. Both `proposal.json` and the PDF display the assumptions, and the direct Graph receipt records them. The output is a reviewable design proposal only; the Graph still stops at spending HITL and has no production GCP provider. The local-components diagram box now truncates each long service name visibly, wraps its label into two lines, and checks width before rendering. The regression cases are `demo/design-result.test.ts` and `sim/label-layout.test.ts`.

A minimal structured JSON with omitted batch fields and long service names completed the fake-world Graph v2 path to `awaiting-approval`: shared Excalidraw/PNG/PDF verified, 6 PDF pages, 4 attachment hashes. This input is a synthetic shape regression, **not** R-SOLAR's `structured-design.json` (SHA prefix `6c4a91bf`). The actual file and `SOLAR-INTEGRATED-REHEARSAL-2026-11-10.md` reside on node-c and were not present on this host at the time of this change. Re-run with that exact file and record its full SHA before claiming scene 4→5 integrated evidence.

## 2026-11-10 · #36522 원본 Solar 설계 재측정

- 원본: `~/elanous-hq/seat-state/OP/solar/structured-design.json`, SHA-256 `6c4a91bfd1beb76820a94049f76c09f937d12e80f61a90ef18f7077753a1285f`.
- 어댑터는 #36522 스키마 v1의 `requirements[].statement`와 `nodes[].label/layer/zone`을 직접 읽는다. 없는 GCP 반출·재시도·데이터 분류·사용량은 제안/PDF/영수증에 출처가 있는 미확인 가정으로 기록한다. 실제 반출·지출은 승인 전 차단한다.
- 실행: `bun scripts/gcp-architect-expand/demo/run-graph-test-world.ts ~/elanous-hq/seat-state/OP/solar/gcpx-solar-original-retest-1110 ~/elanous-hq/seat-state/OP/solar/structured-design.json plugins/gcp-architect-expand/demo/fixtures/pressure.json`.
- 결과: Graph run `eac3462a-be88-4c1e-8b28-16cdbfbbe55d`, shared output run `426e7e3b-bdcf-40e8-a2eb-851ddb32af50`, `approve` 승인 대기, 출력 검증 `verified`, PDF 6쪽, 첨부 4개, 지출 노드 0, 실 GCP 호출 0. [영수증](solar-original-retest-receipt.json). 산출 파일은 같은 호스트의 `seat-state/OP/solar/gcpx-solar-original-retest-1110/artifacts/`.
- 경계: 부족 신호는 명시적인 synthetic fixture다. Solar 구조화 원본을 재사용했으며 새로운 Solar LLM 호출, 실제 PC 용량 측정, 사용자 승인, classic TUI 또는 보드 첨부는 이번 재측정 범위가 아니다.
