# mss-instrument-agent

Read-only subagent that audits code for missing `debug.log` sites per MSS PLAN §11.5.

- Body: [`./agents/mss-instrument-reviewer.md`](./agents/mss-instrument-reviewer.md)
- Plan reference: [`내부 문서 `PLAN-memory-and-signal-substrate`` §11.5](../../내부 문서 `IDEAS`)
- Phase: M0 scaffolding (manual invocation only; PR-hook wire lands in M2.2+)

## Usage

```text
Agent({
  subagent_type: 'mss-instrument-reviewer',
  prompt: '이 PR diff 에 debug.log 누락 site 있나? <paste diff>'
})
```

The agent returns a proposal table — file / line / category / event / fields / rationale. The caller applies edits.
