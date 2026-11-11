# System architecture public pack

Version `0.1.0` · 51 KPACK1 cards · Korean authored decision summaries. `CC-BY-4.0` applies to these original cards only. The pack links to public references; it does not redistribute their prose, diagrams, examples, or source files. Check each linked work's own terms before using that source outside the cited decision context.

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
