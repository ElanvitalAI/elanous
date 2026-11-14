---
name: upstage-information-extract
description: Extract named fields from a document with a caller supplied JSON schema after explicit consent.
---

# Upstage Information Extract

Ask the user to approve sending the document to Upstage before setting `consentToUpstage: true`.
Run the `upstage-information-extract` graph with one base64 `documentDataUrl`, a `schemaName`, and a JSON `schema`.
The graph reads the shared `cred:upstage.api_key` slot at invocation time. If the key is missing, report that Upstage setup is needed.
Only the schema checked result is usable. Invalid JSON, a schema mismatch, or an unsupported schema fails the graph.
The plugin does not register or write a credential slot. U-0 owns the shared slot and fake server contract.
