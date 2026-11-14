# Solar Decide — beta

P6 from `UPSTAGE-PLUGIN-INVENTORY.md` SHA256 `aeae762d361a38fe9830dc3501b40c59ba78ca7c318bf8d21d2d64a665c51729`.

The known endpoint is `POST /v1/systemone` and the model is `solar-decide`. Request and response field names are not confirmed. This plugin supplies an explicit normalization boundary, **not a default graph provider**. Its internal `choice` and `probability` fields are not claims about the upstream API.

The installed entry is the explicit `SolarDecideBeta` tool in `plugin.ts`. After plugin discovery and activation, `PluginHost.dispatchTool` supplies a scoped host action through `PluginContext.solarDecide`. The action creates `createSharedSolarDecideTransport({ signal, maxResponseBytes })` and passes it into `createSolarDecideProvider`. User arguments provide `state`, `question`, `choices`, `enableBeta`, `consentToSend`, `timeoutMs` and `maxResponseBytes`; they cannot supply executable wire adapters. Host configuration may supply an evidenced `solarDecideWire`; by default it is absent and the action fails closed. The installed package has no runtime relative import into a neighboring core source tree.

U-0 Q10 owns the single shared `cred:upstage.api_key` resolver and fake server. The host adapter delegates to merged U-0 PR #37565’s `resolveUpstageApiKeyAsync` and `upstageBaseUrl`, without another slot, resolver or server. The caller supplies positive timeout and response-byte limits. The deadline bounds credential lookup, HTTP and body reading; redirects are rejected and non-OK response bodies are cancelled. No default graph provider is selected.

A caller must opt into beta use and consent to sending the input to Upstage. Without a credential, the result gives shared-key setup guidance. Without an explicit wire adapter and confirmation evidence, it returns `wire-contract-required` before any POST. Production use requires an owner-confirmed adapter; fake contracts work only with a test-universe transport. There is no implicit request body or guessed response mapping.

Tests use U-0’s single `startFakeUpstageServer` for `/v1/systemone` and an env-only fake credential; unit transport doubles also check a fixed choice/probability pair. All fixture field mappings describe only local test data. The existing U-0 fixture has one P6 additive `fixture_probability` field. Only the explicit fixture decoder maps it; missing or nonnumeric probability remains an error, with no invented default. No real key, browser login, second fake-server listener or upstream request is used. Stable choices are checked against the offered choices and probabilities must be finite in [0,1]. Raw responses, request content and transport errors are never returned or logged by this provider.

Observation: a typed status, model and beta marker are returned for every branch. Recovery: key setup, shared-transport readiness or an owner-confirmed wire adapter is required before retry. A successful fake result does not establish upstream schema compatibility or calibrated live accuracy.

JUD #36833 FULL FAIL at `0b8a126b6adce9ed819b118e3f6b6c08a5194558` remains the prior review result (raw SHA256 `fdab07f57dd34386559ac95a71b704033f787ea2b07431760a7b2638e5badbf9`). The correction adds installed discovery/activation/tool-dispatch coverage and non-OK body cancellation; it does not verify the real wire schema or probability calibration.
