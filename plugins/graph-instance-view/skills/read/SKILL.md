# Graph instance view

Read one graph, harness, release, or resource instance as the JSON v1 view model.
Use `GET /v1/graph-instance-view` with `source` and the source's run identity.
The endpoint is owner authenticated and read-only. Keep source ledger paths and
raw tool data out of the response. A missing measurement stays unknown.
