# Ticketing architecture public pack

Version `0.2.0` · checked 2026-11-10 · 20 KPACK1 cards. The pack contains original Korean summaries and a decision table. `license: CC-BY-4.0` applies to these authored cards; linked works retain their own terms. No source article, transcript, diagram, or example implementation is redistributed.

## Source map

| Public source | Pack use | Boundary |
|---|---|---|
| [System Design Primer](https://github.com/donnemartin/system-design-primer) ([license](https://github.com/donnemartin/system-design-primer/blob/master/LICENSE.txt)) | Scope, assumptions, capacity estimates, bottleneck sequence; decision table method | Educational framework, not a ticketing implementation |
| [Google SRE Book: Handling Overload](https://sre.google/sre-book/handling-overload/) · [SRE Workbook: Implementing SLOs](https://sre.google/workbook/implementing-slos/) | Admission, overload, customer-facing SLI/SLO | Numerical limits need a local load test |
| [AWS Well-Architected reliability principles](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel-dp.html) | Recovery questions and failure injection | Vendor-neutral review questions only; no AWS dependency |
| [Azure Architecture Center: Queue-Based Load Leveling](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling) | Buffering bursty asynchronous work | User-facing fair admission needs separate ordering policy |
| [microservices.io: Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html) | Atomic DB change plus outbox and duplicate relay | Consumer idempotency remains required |
| [Martin Fowler site: Lease](https://martinfowler.com/articles/patterns-of-distributed-systems/lease.html) | Time-limited ownership as an analogy for a seat hold | A lease alone does not prove unique sale; DB is final |
| [The Twelve-Factor App: Processes](https://12factor.net/processes) | Stateless booking/API pods and external session state | Queue and order state must survive pod replacement |
| [PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html) · [Redis](https://redis.io/docs/latest/commands/set/) · [Kafka](https://kafka.apache.org/40/design/design/) | Row locks, prefilter/caching, at-least-once delivery | Exact behavior depends on deployed version/configuration |
| [Stripe](https://docs.stripe.com/webhooks) · [Kubernetes](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/) · [NGINX](https://docs.nginx.com/nginx/admin-guide/security-controls/controlling-access-proxied-http) | Payment callbacks, HPA, edge rate limits | Product and infrastructure choices remain assumptions |

## Decision rule

Begin with the user contract and write the invariant. Estimate separate arrival, polling, and seat-write rates. Select a state owner for each transition, state alternatives and failure behavior, then specify a falsification test. `content/14-decisions.json` holds the compact decision table; individual cards carry a primary `source` URL and additional links where a decision combines sources.

This is a source-based domain pack. It does not include the YouTube video's exact policy numbers or the 44-point evaluation rubric.
