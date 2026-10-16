## stay
http | src/nexus/api/http-server.ts:startNexusHttpServer | HTTP
pwa | src/nexus/pwa-registration.ts:createPwaRegistration | PWA
workflow-dispatch | src/workflow-runtime/daemon.ts:dispatchWebhook | 발송/dispatch
outbound | src/notifications/outbound-boot.ts:buildOutboundSubstrate | 발송/dispatch
sse-bus | src/nexus/api/event-bus.ts:NexusEventBus | SSE
sse-events | src/nexus/api/events.ts:handleSseEvents | SSE
sse-heartbeat | src/nexus/api/sse-heartbeat.ts:SSE_HEARTBEAT_MS | SSE
task-cards | src/nexus/api/task-cards-api.ts:handleTaskCardsGet | cards
decision-cards | src/decisions/decision-cards.ts:DecisionCardService | cards
hitl-pending | src/nexus/api/hitl-runtime.ts:createHitlPendingCallbacks | cards

## leave
executor | src/workflow-runtime/executor.ts:runWorkflowToCompletion | judgment/executor; daemon emit awaits this in-process — ops rail must consume a short-lived run instead (process extraction is remaining work, out of stage 1)
harness | src/boot/daemon-tools/self-implement.ts:dispatchSelfImplement | harness/self-implement wired into TOX externalExec on this boot — already process-shaped; must leave the daemon
agent-loop | src/telegram-agent.ts:makeTelegramAgentRunTurn | agent loop started on this boot (telegram Q&A; discord makeDiscordAgentRunTurn and ACP createAgentTurnRunner siblings). AutopilotLoopDriver in src/autopilot/agent-loop.ts is not started here
tox | src/task-orchestrator/boot.ts:wireTox | TOX TaskFeedbackLoop + startToxLoop long-lived dispatcher started on this boot
continuation | src/dispatch/continuation-scheduler.ts:ContinuationScheduler.start | idle-continuation scheduler constructed on this boot (starts when dispatch.enabled)
workflow-schedule | src/workflow-runtime/daemon.ts:start | scheduleSource.start is a long-lived trigger scheduler; dispatch methods stay
intent-prediction | src/intent-prediction/index.ts:createIntentPredictionService | long-lived ranker tick / judgment scheduler
patcher | src/background-reasoning/patcher-boot.ts:buildPatcherSubstrate | self-improving patcher loop started on this boot
daily-reflection | src/notes/daily-reflection-scheduler.ts:startDailyReflectionScheduler | daily reflection scheduler
discovery-cron | src/registry/discovery/cron.ts:startDiscoveryCron | discovery cron scheduler
watch-default | src/domains/watch-default-scheduler.ts:startWatchDefaultScheduler | watch default scheduler

## removalOrder
executor
harness
agent-loop
tox
continuation
workflow-schedule
intent-prediction
patcher
daily-reflection
discovery-cron
watch-default
