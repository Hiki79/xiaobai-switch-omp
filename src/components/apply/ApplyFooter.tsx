import { useState } from "react";
import { App, Button, Modal, theme } from "antd";
import { Check, History, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isAppError } from "@/lib/invoke";
import type { TargetKind } from "@/types/domain";
import { TargetBackupList } from "./TargetBackupList";

interface Props {
  loading: boolean;
  disabled: boolean;
  target: TargetKind;
  onApply: () => void;
  onRestoreOfficial: () => void | Promise<void>;
}

export function ApplyFooter({ loading, disabled, target, onApply, onRestoreOfficial }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { modal, message } = App.useApp();
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const handleRestoreOfficial = () => {
    modal.confirm({
      centered: true,
      title: t("apply.restoreOfficialConfirm"),
      content:
        target === "claude_code"
          ? t("apply.restoreOfficialClaudeHint")
          : t("apply.restoreOfficialCodexHint"),
      okText: t("apply.restoreOfficialOk"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true, loading: restoring },
      onOk: async () => {
        setRestoring(true);
        try {
          await onRestoreOfficial();
          modal.success({
            centered: true,
            title: t("apply.restoreOfficialSuccess"),
            content: (
              <div>
                <div>
                  {target === "claude_code"
                    ? t("apply.restoreOfficialClaudeOk")
                    : t("apply.restoreOfficialCodexOk")}
                </div>
                <div className="mt-2">{t("apply.restartHint")}</div>
              </div>
            ),
            okText: t("common.confirm"),
          });
        } catch (e) {
          message.error(isAppError(e) ? e.message : t("apply.restoreOfficialFailed"));
          throw e;
        } finally {
          setRestoring(false);
        }
      },
    });
  };

  return (
    <div
      data-testid="apply-footer"
      className="shrink-0 px-6 py-3"
      style={{
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        backgroundColor: token.colorBgContainer,
      }}
    >
      <div className="flex items-center gap-2">
        <Button icon={<History size={14} />} onClick={() => setBackupOpen(true)}>
          {t("apply.backupRecords")}
        </Button>
        <Button
          type="primary"
          className="flex-1"
          icon={<Check size={14} />}
          loading={loading}
          disabled={disabled || restoring}
          onClick={onApply}
        >
          {loading ? t("apply.applying") : t("apply.apply")}
        </Button>
        <Button
          icon={<RotateCcw size={14} />}
          loading={restoring}
          disabled={loading}
          onClick={handleRestoreOfficial}
        >
          {t("apply.restoreOfficial")}
        </Button>
      </div>
      <Modal
        open={backupOpen}
        centered
        destroyOnHidden
        mask={{ enabled: true, blur: true }}
        width={560}
        title={t("apply.backupRecords")}
        footer={null}
        onCancel={() => setBackupOpen(false)}
      >
        <TargetBackupList target={target} />
      </Modal>
    </div>
  );
}
