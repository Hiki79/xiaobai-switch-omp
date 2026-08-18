import { useEffect, useState } from "react";
import { App, Collapse, Form, Input, Modal, Select } from "antd";
import { useTranslation } from "react-i18next";
import type { Site, SiteCapabilities, SiteProtocol } from "@/types/domain";
import { useSiteStore } from "@/stores";
import { UrlWritePreviewIcon } from "./UrlWritePreview";
import { BaseUrlListInput } from "./BaseUrlListInput";
import { isAppError } from "@/lib/invoke";
import { invalidateSiteIconCache } from "@/lib/siteIcon";
import { normalizeBaseUrls, siteBaseUrls } from "@/lib/urlNormalize";
import {
  anyCodexCapabilityOn,
  capabilitiesFromCodexFlags,
  codexFlagsFromCapabilities,
  EMPTY_CODEX_FLAGS,
  mergeCodexCapabilities,
  type CodexCapabilityFlags,
} from "@/lib/siteCapabilities";
import { CodexCapabilitySwitchList } from "@/components/apply/CodexCapabilitySwitchList";

export interface SiteFormInitialValues {
  name?: string;
  baseUrls?: string[];
  apiKey?: string | null;
  protocol?: SiteProtocol;
  notes?: string | null;
  capabilities?: SiteCapabilities;
}

interface Props {
  open: boolean;
  site?: Site | null;
  initialValues?: SiteFormInitialValues | null;
  onClose: () => void;
  onSaved?: (site: Site, isCreate: boolean) => void;
}

export function SiteFormModal({ open, site, initialValues, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const createSite = useSiteStore((s) => s.createSite);
  const updateSite = useSiteStore((s) => s.updateSite);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [codexFlags, setCodexFlags] = useState<CodexCapabilityFlags>(EMPTY_CODEX_FLAGS);
  const [capOpen, setCapOpen] = useState<string[]>([]);
  const watchedUrls = Form.useWatch("baseUrls", form) as string[] | undefined;
  const previewUrl = watchedUrls?.find((u) => String(u ?? "").trim()) ?? "";

  useEffect(() => {
    if (!open) return;
    const caps = site?.capabilities ?? initialValues?.capabilities ?? {};
    const flags = codexFlagsFromCapabilities(caps);
    setCodexFlags(flags);
    setCapOpen(anyCodexCapabilityOn(caps) ? ["codex"] : []);
    if (site) {
      form.setFieldsValue({
        name: site.name,
        baseUrls: siteBaseUrls(site),
        apiKey: "",
        protocol: site.protocol,
        notes: site.notes ?? "",
      });
    } else {
      form.resetFields();
      form.setFieldsValue({
        protocol: initialValues?.protocol ?? "openai_compatible",
        baseUrls: initialValues?.baseUrls?.length ? initialValues.baseUrls : [""],
        name: initialValues?.name,
        apiKey: initialValues?.apiKey ?? "",
        notes: initialValues?.notes ?? "",
      });
    }
  }, [open, site, form, initialValues]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const baseUrls = normalizeBaseUrls(values.baseUrls as string[]);
      const capabilities = mergeCodexCapabilities(
        site?.capabilities ?? initialValues?.capabilities ?? {},
        capabilitiesFromCodexFlags(codexFlags),
      );
      setSaving(true);
      let saved: Site;
      const isCreate = !site;
      if (site) {
        saved = await updateSite(site.id, {
          name: values.name,
          baseUrls,
          baseUrl: baseUrls[0],
          apiKey: values.apiKey || null,
          protocol: values.protocol as SiteProtocol,
          notes: values.notes || null,
          capabilities,
        });
        invalidateSiteIconCache(site.id);
      } else {
        if (!values.apiKey) {
          message.error(t("sites.apiKey"));
          return;
        }
        saved = await createSite({
          name: values.name,
          baseUrls,
          baseUrl: baseUrls[0],
          apiKey: values.apiKey,
          protocol: values.protocol,
          notes: values.notes || null,
          capabilities,
        });
      }
      message.success(isCreate ? t("sites.createSuccess") : t("sites.updateSuccess"));
      onSaved?.(saved, isCreate);
      onClose();
    } catch (e) {
      if (isAppError(e)) message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={site ? t("sites.edit") : t("sites.add")}
      onCancel={onClose}
      onOk={() => void handleOk()}
      confirmLoading={saving}
      okText={t("sites.save")}
      cancelText={t("sites.cancel")}
      width={560}
      destroyOnHidden
      centered
      mask={{ enabled: true, blur: true }}
    >
      <Form form={form} layout="vertical" className="mt-2" requiredMark="optional">
        <Form.Item name="name" label={t("sites.name")} rules={[{ required: true, message: t("sites.name") }]}>
          <Input placeholder="My Relay" allowClear />
        </Form.Item>
        <Form.Item
          label={
            <span className="inline-flex items-center gap-1.5">
              {t("sites.baseUrl")}
              <UrlWritePreviewIcon baseUrl={previewUrl} />
            </span>
          }
          extra={t("sites.baseUrlDefaultHint")}
          required
        >
          <BaseUrlListInput />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label={t("sites.apiKey")}
          rules={site ? [] : [{ required: true, message: t("sites.apiKey") }]}
          extra={site ? t("sites.apiKeyKeepHint") : undefined}
        >
          <Input.Password placeholder="sk-..." allowClear />
        </Form.Item>
        <Form.Item name="protocol" label={t("sites.protocol")}>
          <Select
            options={[
              { value: "openai_compatible", label: t("sites.protocolOpenai") },
              { value: "anthropic", label: t("sites.protocolAnthropic") },
            ]}
          />
        </Form.Item>
        <Form.Item name="notes" label={t("sites.notes")}>
          <Input.TextArea rows={2} allowClear />
        </Form.Item>
        <Collapse
          size="small"
          activeKey={capOpen}
          onChange={(keys) => setCapOpen(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
          items={[
            {
              key: "codex",
              label: t("sites.codexPrivateCapabilities"),
              children: (
                <CodexCapabilitySwitchList value={codexFlags} onChange={setCodexFlags} />
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
}
