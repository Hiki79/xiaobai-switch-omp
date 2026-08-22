import type { TargetKind } from "@/types/domain";

/** i18n keys that vary per apply-center target; keeps call sites record-based
 * instead of nested ternaries as targets grow. */
export const TARGET_LABEL_KEY: Record<TargetKind, string> = {
  claude_code: "apply.targetClaude",
  codex: "apply.targetCodex",
  omp: "apply.targetOmp",
  zcode: "apply.targetZcode",
  dsh: "apply.targetDsh",
};

export const RESTORE_OFFICIAL_HINT_KEY: Record<TargetKind, string> = {
  claude_code: "apply.restoreOfficialClaudeHint",
  codex: "apply.restoreOfficialCodexHint",
  omp: "apply.restoreOfficialOmpHint",
  zcode: "apply.restoreOfficialZcodeHint",
  dsh: "apply.restoreOfficialDshHint",
};

export const RESTORE_OFFICIAL_OK_KEY: Record<TargetKind, string> = {
  claude_code: "apply.restoreOfficialClaudeOk",
  codex: "apply.restoreOfficialCodexOk",
  omp: "apply.restoreOfficialOmpOk",
  zcode: "apply.restoreOfficialZcodeOk",
  dsh: "apply.restoreOfficialDshOk",
};

export const APPLY_RESULT_OK_KEY: Record<TargetKind, string> = {
  claude_code: "apply.resultClaudeOk",
  codex: "apply.resultCodexOk",
  omp: "apply.resultOmpOk",
  zcode: "apply.resultZcodeOk",
  dsh: "apply.resultDshOk",
};
