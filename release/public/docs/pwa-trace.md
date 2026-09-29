# Trace — follow one run down to the log line

**Live** is the stage: everything that is happening, at a glance. **Trace** is the workbench next to it. You start from every run on every machine, narrow the view step by step, and end at a single decision and the exact log line behind it — with a command you can paste into a terminal to find that line again.

Trace reads the same data as Live (the log and the harness run records), so it never shows anything elanous did not record. It refreshes every 5 seconds.

The page's labels are in Korean today, so this page gives each label as it appears on screen, for example **런** (Run).

## Levels

Trace has four levels. The buttons at the top switch between them; a level you cannot reach yet (no run or decision picked) is greyed out.

| Level | Button | What you see |
|---|---|---|
| **L0** | **L0 플릿** (Fleet) | Every elanous instance ("universe") that wrote signals in the time window, with its runs around it |
| **L1** | **L1 런** (Runs) | The runs that match your lens, linked to the run that started them. The list is counted by the daemon across every instance, so quiet runs are not crowded out by busy ones. This is where the page opens |
| **L2** | **L2 런 한 개** (One run) | One run: its stage bar, a timeline of when each stage was busy, its chain of decisions and its raw signals |
| **L3** | **L3 판단** (Decision) | One decision from that run, with its evidence underneath (L4) |

Double-click a node in the graph to go one level down. Press **Esc** to go one level up.

## The lens

Every filter you add stacks up in a row of chips under the header, starting with **렌즈 ›** (Lens). For example:

`렌즈 › 시간: 10:20–10:45 · 우주: pod-worker · 상태: 막힘 · 런: 3a7a5625`

Click a chip to remove just that filter; the others stay. When nothing is filtered the row says **전체** (all). Next to it, a counter shows how many signals, runs and universes are in view, and warns **조회 상한에 닿음** when the query hit its size limit — widen the lens carefully, because some signals were not loaded.

Filters you can add:

- **Status chips** — **도는** (running), **착지** (landed: the run reached the merge stage), **막힘** (blocked) and **끊김·결과 모름** (gone quiet, result unknown). A run's status comes from the harness run records when they know it; otherwise a run that sent a signal in the last 15 minutes counts as running, and an older one as gone quiet — elanous does not call a run "running" just because nobody recorded how it ended. The number on each chip is how many runs would be left if you pressed it.
- **Universe chips** — one per instance, busiest first.
- **Search** (press **/**) — matches part of a run ID, a pull request number or a universe name.
- **Time** — drag across the timeline under the graph to keep only runs active in that stretch.
- **시간 창** (Time window) — 1, 6 or 24 hours back (24 hours by default).
- **신호 출처** (Signal source) — **전체(연합)** (all instances, the default) or **이 인스턴스** (this instance only).

## The graph

- **Click** a node to select it; only its direct neighbours stay bright.
- **Double-click** to go one level down into it.
- **Drag** a node to pin it in place; click it twice to release it.
- **Scroll** to zoom.

## One run (L2)

The run's six stages sit in a bar — **저작** (writing the goal), **분해** (splitting it), **구현** (implementing), **게이트** (checks), **리뷰** (review) and **착지** (merging) — lit when reached and red where something failed. Below it:

- a **timeline** of when each stage first and last sent a signal;
- the **decision chain**, oldest first, one card per decision with its kind (`PLAN`, `ROUTE`, `VERIFY`, `HEAL`, `ESCALATE`, `SHIP`) and its reason;
- the run's **raw signals**, newest first.

The chain's heading shows where it came from: **원천: 서버 /v1/trace** (green) means the daemon gathered the run's decisions across every instance, with pull request and commit attached; **원천: 이 창 조회 · …** means the page fell back to its own time-window query and says why (for example an older daemon). If the chain looks short on the fallback, widen the time window.

Click a decision card to open it at L3.

If a card's reason reads **계측 없음** (not recorded), elanous did not record that field for this decision. That is information, not an error: it shows you what the harness does not yet explain. To fill in the reasons for one run, turn on Full show for that run in Live (**화려함 MAX → 이 런만 켜기**).

## One decision (L3) and its evidence (L4)

The decision card shows:

| Field | Meaning |
|---|---|
| **무엇** (What) | What was decided |
| **왜** (Why) | The reason recorded with it |
| **목적** (Purpose) | What it was for |
| **어디로** (Where to) | Where the work went next |
| **PATHS** | How many options it weighed, when recorded |

Use **←** and **→** (on screen or on the keyboard) to step to the previous or next decision in the same run.

Under the card, **L4 증거** (evidence) shows:

1. **원 로그 줄** (the source log line) — the exact record the card was built from. **서버 원문(비밀 가림)** means it was fetched from the daemon by the line's key, with anything that looks like a secret masked, and it does not depend on the page's query limit; **이 창 조회** means it came from the page's own window.
2. **앞뒤 1분** — up to 20 other signals from the same run, one minute either side.
3. **A command to find it again**, with a copy button. It looks like:

   ```
   elanous logs --category harness.decision --since 2026-09-28T01:20:00.000Z --until 2026-09-28T01:22:00.000Z --grep run-3a7a5625-… --json --json-data
   ```

   The times are in UTC. If the run lives on another instance, the command includes `--instance <name>`.
4. When the decision records a commit, its short hash; when it names a pull request, a link to its card in **Approvals**.

If the source line is missing ("이 창의 조회에 원 줄이 없다"), the page is on its fallback and the query limit cut the line off or it belongs to another universe — narrow the time window or switch the signal source to **전체(연합)**.

## Share a view

Everything you set is kept in the address, for example `/trace?level=L3&run=run-3a7a5625-…&dec=4`. Send the link and the other person opens the same view on the same data.

From Live, open a run and click **Trace 로 →** to land on that run at L2. **무대로(Live) →** goes back.

## Keyboard

| Key | Action |
|---|---|
| **/** | Search |
| **Esc** | Up one level (or leave the search box) |
| **[** / **]** | Up one level / from Fleet to Runs |
| **←** / **→** | Previous / next decision (L3) |

## Troubleshooting

- **Connect to a NEXUS daemon to trace runs**: the web app is not connected to a daemon. Check `elanous nexus status`.
- **이 렌즈에 런이 없다** (no runs in this lens): remove chips from the lens row one at a time.
- **이 창에 런 … 가 없다** (the run is not in this window): the link points at a run older than the time window, or on another instance — widen the window or choose **전체(연합)**.
