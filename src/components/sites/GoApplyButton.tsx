import { useEffect, useState } from "react";
import { Button } from "antd";
import ClaudeCode from "@lobehub/icons/es/ClaudeCode";
import Codex from "@lobehub/icons/es/Codex";
import { useTranslation } from "react-i18next";
import type { ApplyTargetTab } from "@/stores";

const CYCLE_MS = 3000;
const FADE_MS = 180;

interface Props {
  disabled?: boolean;
  onApply: (tab: ApplyTargetTab) => void;
}

export function GoApplyButton({ disabled, onApply }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ApplyTargetTab>("claude_code");
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = window.setInterval(() => {
      if (reduce) {
        setTab((cur) => (cur === "claude_code" ? "codex" : "claude_code"));
        return;
      }
      setLeaving(true);
      window.setTimeout(() => {
        setTab((cur) => (cur === "claude_code" ? "codex" : "claude_code"));
        setLeaving(false);
      }, FADE_MS);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, []);

  const label = tab === "claude_code" ? t("sites.goApplyClaude") : t("sites.goApplyCodex");
  const icon = tab === "claude_code" ? <ClaudeCode size={14} /> : <Codex size={14} />;

  return (
    <Button type="primary" size="small" disabled={disabled} onClick={() => onApply(tab)}>
      <span
        className="go-apply-swap inline-flex items-center gap-1 whitespace-nowrap"
        data-leaving={leaving ? "true" : "false"}
      >
        {icon}
        {label}
      </span>
    </Button>
  );
}
