LLM provider — Step 1 / 5

Pick the LLM elanous uses for chat / agent loops. Each provider needs
something different:

  · OpenAI Codex — sign in via ChatGPT OAuth (browser device-code
                   flow) OR paste an OpenAI API key. The model
                   list in the next step is the current one.
  · Local        — Ollama / LM Studio / MLX / Docker on this
                   machine or another Tailscale node. We auto-probe
                   and let you pick.
  · Grok         — paste an xAI API key (https://console.x.ai)
  · OpenAI       — paste an OpenAI key (sk-...)
  · Anthropic    — paste an Anthropic key (sk-ant-...)
  · Gemini       — paste a Google AI Studio key
  · Auto-detect  — leave the choice to the runtime; pick from the
                   first env var it finds at boot.

Remote host on a tailnet: set `llm.provider=hq-proxy`, `llm.baseUrl` to
the HQ Nexus HTTPS tailnet URL, and `llm.apiKey` to the existing Nexus
owner bearer. Set `ELANOUS_HQ_PROXY_MACHINE_TOKEN` to a host-specific
member token issued on HQ with `elanous control token issue <host>`;
tokens expire after 24 hours and can be revoked with
`elanous control token revoke <host>`. Set `ELANOUS_SEAT` and the required
`ELANOUS_LLM_PURPOSE` (`review`, `implement`, `research`, `plan`, or
`summarize`). Set `ELANOUS_PR_NUMBER` when available. The remote host receives only model
results and usage. Codex OAuth accounts and the fallback OpenAI API key
(`cred:openai.api_key`) stay on HQ.
The Nexus endpoint must see the caller's tailnet peer address directly;
a loopback forwarding proxy is rejected even if it preserves a `.ts.net` Host.

Cost-conscious: Local is free (your hardware), then Grok / Gemini
free tiers, then OpenAI / Anthropic pay-per-token. elanous doesn't
pin you to one provider — you can switch any time via
`elanous setup llm`.
