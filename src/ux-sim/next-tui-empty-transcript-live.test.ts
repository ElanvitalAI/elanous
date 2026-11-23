import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mockSeatPtySequence } from "./mock-seat-pty-sequence.js";

test("next TUI PTY boots without the empty transcript placeholder and keeps the draft on the composer row", async () => {
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
      ready: { label: "boot", until: (screen) => screen.split("\n").includes("elanous") && screen.includes("Ctrl+Q quit") },
      steps: [{ label: "draft", keys: "x", until: (screen) => screen.includes("❯ x") }],
    });
    const boot = receipt.frames.find((frame) => frame.label === "boot")?.screen ?? "";
    const draft = receipt.frames.find((frame) => frame.label === "draft")?.screen ?? "";
    expect(boot).not.toContain("No chat history");
    // #39413 keeps one placeholder row on the compact primary screen once the welcome card is gone, so the composer
    // and cursor keep their places: the draft sits on the composer row and the placeholder is that single row.
    const draftLines = draft.split("\n");
    expect(draftLines.map((line) => line.trim()).filter((line) => line === "No chat history")).toEqual(["No chat history"]);
    expect(draftLines.at(-2)?.trimEnd()).toBe("❯ x");
    expect(receipt.exitCode).toBe(0);
    console.log("next TUI empty transcript PTY:", JSON.stringify({ host: receipt.actualHost, rows: receipt.rows, cols: receipt.cols, bootHidesEmpty: !boot.includes("No chat history"), draftOnComposer: draft.split("\n").at(-2)?.trimEnd() === "❯ x", exitCode: receipt.exitCode }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
