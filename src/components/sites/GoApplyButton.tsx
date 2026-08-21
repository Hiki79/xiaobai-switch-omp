import { useEffect, useState } from "react";
import { Button } from "antd";
import ClaudeCode from "@lobehub/icons/es/ClaudeCode";
import Codex from "@lobehub/icons/es/Codex";
import { Code2, Pi as PiIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ApplyTargetTab } from "@/stores";

const CYCLE_MS = 3000;
const FADE_MS = 180;

/** Rotation order for the "go apply" button. */
const CYCLE: ApplyTargetTab[] = ["claude_code", "codex", "omp", "zcode"];

const TAB_ICONS: Record<ApplyTargetTab, React.ReactNode> = {
  claude_code: <ClaudeCode size={14} />,
  codex: <Codex size={14} />,
  omp: <PiIcon size={14} />,
  zcode: <Code2 size={14} />,
};

const GO_APPLY_KEY: Record<ApplyTargetTab, string> = {
  claude_code: "sites.goApplyClaude",
  codex: "sites.goApplyCodex",
  omp: "sites.goApplyOmp",
  zcode: "sites.goApplyZcode",
};

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
        setTab((cur) => CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length]);
        return;
      }
      setLeaving(true);
      window.setTimeout(() => {
        setTab((cur) => CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length]);
        setLeaving(false);
      }, FADE_MS);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, []);

  const label = t(GO_APPLY_KEY[tab]);
  const icon = TAB_ICONS[tab];

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
