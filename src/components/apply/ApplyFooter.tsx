import { useState } from "react";
import { Button, Modal, theme } from "antd";
import { Check, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TargetKind } from "@/types/domain";
import { TargetBackupList } from "./TargetBackupList";

interface Props {
  loading: boolean;
  disabled: boolean;
  target: TargetKind;
  onApply: () => void;
}

export function ApplyFooter({ loading, disabled, target, onApply }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [backupOpen, setBackupOpen] = useState(false);

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
          disabled={disabled}
          onClick={onApply}
        >
          {loading ? t("apply.applying") : t("apply.apply")}
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
