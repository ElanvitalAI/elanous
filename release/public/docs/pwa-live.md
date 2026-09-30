# Live — watch your harness runs think

The **Live** menu of the web app shows your harness runs as they happen: which stage each run is in, what it decided, why, and where it sent the work next. Everything on the page comes from what elanous has actually recorded; there is no demo data.

The page's labels are in Korean today, so this page gives each label as it appears on screen, for example **런** (Runs).

## What is on the page

**Gauges** across the top:

| Gauge | What it counts |
|---|---|
| **LIVE** | Runs in progress |
| **DECISIONS/MIN** | Decisions per minute in the time window |
| **SHIPPED** | Pull requests opened or merged |
| **SELF-HEAL** | Share of runs that hit a problem and went through a repair round |
| **BURN** | Model tokens per minute |
| **BLOCKED** | Runs that are stuck |

**런** (Runs): one row per run in the time window. Each row is a bar of six stages: **저작** (writing the goal), **분해** (splitting it into pieces), **구현** (implementing), **게이트** (checks), **리뷰** (unattended review) and **착지** (merging). A stage lights up when the run reaches it and turns red when something fails there. Click a row to open that run's drawer: its screen and log lines, **Trace 로 →** (open it in Trace), **MAX 이 런만** (Full show for this run only), **⏹ 멈춤** (stop, after one confirmation) and, when it waits for you, **승인 카드로 →** (to its approval card). Click the row again, or **✕**, to close it.

**판단 스트림** (Decision stream): one line per decision, newest first, tagged with its kind:

| Kind | Meaning | Example |
|---|---|---|
| `PLAN` | Planning | The goal was split into pieces |
| `ROUTE` | Sending work somewhere | Switched to the next account; sent a piece to a worker machine; refused a write outside the sandbox |
| `VERIFY` | Checking | Gates passed; review verdict |
| `HEAL` | Repairing | Gate failed, repair round started |
| `ESCALATE` | Asking you | The run stopped for a human decision |
| `SHIP` | Landing | Pull request opened or merged |

**모델 성적표** (Model scorecard) and **리뷰 판정** (Review verdicts) summarize which models answered and how reviews went. **흐르는 로그** (Scrolling log) shows the raw signals behind it all. **빈 칸 표** (Missing fields) lists decisions whose log line has no reason or destination yet, so you can see what elanous does not record.

At the bottom the page names its sources (the log and the harness run records) and refreshes every 5 seconds. Anything that looks like a secret is masked.

## Controls

- **시간 창** (Time window): how far back to look.
- **신호 출처** (Signal source): which elanous instance to read. **이 인스턴스** (this instance) is the default; **전체(연합 · 최근 24시간에 쓰인 우주)** (all — every instance written to in the last 24 hours) reads them together, and an isolated test instance appears here too.
- **공개 캡처** (Recording mode): for screenshots and recordings. It replaces account names with `account-N`, hides credits and dollar amounts, and masks home-folder paths and machine names. `?capture=public` in the address turns it on too.
- **화려함 MAX** (Full show): see below.

## Everyday and Full show

By default the page shows the summary signals elanous always records. That costs almost nothing, so you can leave the tab open.

**화려함 MAX** (Full show) is for demos, recordings and digging into one strange run. It adds motion to the page, and it asks the harness to record more: for every decision, *why* it was made, *what for*, and *where the work went*. Recording that costs something, so:

1. The page asks first and shows how many signals per minute it is receiving right now.
2. You choose **전체로 켜기** (turn on for all runs) or **이 런만 켜기** (only this run — pick a run first).
3. It switches itself off after 30 minutes. While it is on, a line under the header shows the scope, the signals per minute, the payload size and the minutes left.
4. The switch lives on the server, so every device you open sees the same state. Turn it off with **화려함 MAX 켜짐 · 끄기**.

If your system asks for reduced motion, Full show keeps the extra detail but drops the animation.

## Troubleshooting

- **신호를 못 읽었다** (could not read the signals): the web app cannot reach the daemon's log. Check that the daemon is running (`elanous nexus status`).
- **MAX 스위치를 못 바꿨다** (could not change the switch): usually the daemon rejected the request; sign in again or reload.
- An empty **런** list means no run started in the time window. Widen the window, or start one with `elanous harness say "<one sentence>"`.
