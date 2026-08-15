import { Button, Steps, theme } from "antd";
import { useTranslation } from "react-i18next";
import { useUIStore } from "@/stores";

interface Props {
  onAdd: () => void;
}

export function EmptyOnboarding({ onAdd }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const setWizardOpen = useUIStore((s) => s.setWizardOpen);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <div>
        <h2 className="text-xl font-semibold" style={{ color: token.colorText }}>
          {t("onboarding.welcome")}
        </h2>
        <p className="mt-2 max-w-md text-sm" style={{ color: token.colorTextSecondary }}>
          {t("onboarding.welcomeDesc")}
        </p>
      </div>
      <Steps
        direction="horizontal"
        size="small"
        className="max-w-lg"
        items={[
          { title: t("onboarding.step1") },
          { title: t("onboarding.step2") },
          { title: t("onboarding.step3") },
        ]}
      />
      <Button
        type="primary"
        size="large"
        onClick={() => {
          setWizardOpen(true);
          onAdd();
        }}
      >
        {t("sites.startWizard")}
      </Button>
    </div>
  );
}
