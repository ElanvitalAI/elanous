# System architecture public pack

For an isolated on/off evaluation of automatic pack selection, run the off arm with `ELANOUS_SYSTEM_ARCH_PACK=off` and the on arm with the variable unset. Keep the KGS empty in both arms. This switch affects automatic selection of this architecture pack; an explicit pack ID request remains an explicit user choice.

A question-only KnowledgeQuery call searches knowledge packs only. If no pack matches, it returns an empty result with a reason and does not discover or create an Obsidian vault. Vault search remains available through explicit vault filter inputs.

Version `0.2.0` · 73 KPACK1 cards · Korean authored decision summaries. `CC-BY-4.0` applies to these original cards only. The pack links to public references; it does not redistribute their prose, diagrams, examples, or source files. Check each linked work's own terms before using that source outside the cited decision context.

## Component and pattern references

The 16 component records in [component-knowledge.json](references/component-knowledge.json) contain a description, when to use, an alternative, AWS and GCP service mappings, exact official icon registry paths, and direct official source URLs. The five records in [pattern-library.json](references/pattern-library.json) cover local single node, local with relay, cloud three tier, serverless, and event driven systems. Each has a placement rule and a layout example. The generated diagram must select nodes and flows from the request; the examples are not templates to copy. The [workflow](references/workflow.json) links requirements, architecture, FE, BE, DB, testing and deployment documents. These 22 records are also indexed as KPACK1 cards so a requested knowledge query can cite them. A successful pack query emits `pack.load` with document ID and SHA-256, while a request that does not query the pack emits no such event.

## Source map

| Public source | Pack use | Boundary |
|---|---|---|
| [System Design Primer](https://github.com/donnemartin/system-design-primer) | Workload decomposition, scaling choices, caching, partitioning, search and capacity tradeoffs | Educational framework; no source text or solution copied |
| [Google Cloud Architecture Center](https://cloud.google.com/architecture) · [Scalable and resilient apps](https://docs.cloud.google.com/architecture/scalable-and-resilient-apps) · [MLOps pipeline](https://docs.cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning) | GCP service mapping, resilient deployment, data and ML serving decisions | Product mapping only; validate region, service limits, and current pricing before adoption |
| [AWS Architecture Center](https://aws.amazon.com/architecture/) · [Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html) · [Serverless multi-tier architectures](https://docs.aws.amazon.com/whitepapers/latest/serverless-multi-tier-architectures-api-gateway-lambda/serverless-multi-tier-architectures-api-gateway-lambda.html) · [SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/welcome.html) · [GuardDuty S3 malware protection](https://docs.aws.amazon.com/guardduty/latest/ug/how-malware-protection-for-s3-gdu-works.html) | Failure isolation, serverless, media scanning and tenant isolation concepts | Vendor-neutral questions and GCP mappings are authored here; no AWS architecture is prescribed |
| [Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/) · [Queue-based load leveling](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling) · [Cache-aside](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside) · [Sharding](https://learn.microsoft.com/en-us/azure/architecture/patterns/sharding) · [Rate limiting](https://learn.microsoft.com/en-us/azure/architecture/patterns/rate-limiting-pattern) | Queue, cache, shard, quota and resilience pattern comparisons | Patterns describe tradeoffs, not default product choices |
| [microservices.io](https://microservices.io/) · [CQRS](https://microservices.io/patterns/data/cqrs.html) · [Event sourcing](https://microservices.io/patterns/data/event-sourcing.html) · [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) | Service boundaries, CQRS, event sourcing, idempotent delivery and outbox decisions | Summaries are original; follow each source's terms and context |

## Card contract

Every card has one primary `source` URL and a Korean decision summary with four consistent fields: when to use, qualitative capacity stage, GCP mapping, and cost axis. Numeric capacity limits are intentionally omitted because they must be measured for the target workload. The final line states a decision boundary or a falsification test.
