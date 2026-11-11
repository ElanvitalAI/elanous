import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mockSeatPtySequence } from "./mock-seat-pty-sequence.js";

test("next TUI PTY hides the empty transcript placeholder while keeping the draft prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "next-tui-empty-transcript-"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const repo = resolve(import.meta.dir, "..", "..");
  try {
    const receipt = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, "bin", "elanous.mjs"), "--test={root}", "--config-dir", "{root}", "--test-state-dir", "{root}", "--tui", "next"],
      root,
      rows: 24,
      cols: 80,
      env: { ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: "boot", until: (screen) => screen.includes("elanous next ·") && screen.includes("Ctrl+Q 종료") },
      steps: [{ label: "draft", keys: "x", until: (screen) => screen.includes("❯ x") }],
    });
    const boot = receipt.frames.find((frame) => frame.label === "boot")?.screen ?? "";
    const draft = receipt.frames.find((frame) => frame.label === "draft")?.screen ?? "";
    expect(boot).not.toContain("대화 기록 없음");
    expect(draft).not.toContain("대화 기록 없음");
    expect(draft).toContain("❯ x");
    expect(receipt.exitCode).toBe(0);
    console.log("next TUI empty transcript PTY:", JSON.stringify({ host: receipt.actualHost, rows: receipt.rows, cols: receipt.cols, bootHidesEmpty: !boot.includes("대화 기록 없음"), draftHidesEmpty: !draft.includes("대화 기록 없음"), exitCode: receipt.exitCode }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
