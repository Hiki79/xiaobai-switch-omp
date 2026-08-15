import { Select } from "antd";
import type { Site } from "@/types/domain";
import { SiteAvatar } from "@/components/sites/SiteAvatar";

interface SiteOption {
  value: string;
  label: string;
  site: Site;
}

interface Props {
  sites: Site[];
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (siteId: string) => void;
}

function SiteOptionLabel({ site, size = 18 }: { site: Site; size?: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <SiteAvatar siteId={site.id} name={site.name} baseUrl={site.baseUrl} size={size} />
      <span className="min-w-0 truncate">{site.name}</span>
    </span>
  );
}

export function SiteSelect({ sites, value, placeholder, disabled, onChange }: Props) {
  const options: SiteOption[] = sites.map((site) => ({
    value: site.id,
    label: site.name,
    site,
  }));

  return (
    <Select
      className="w-full"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      options={options}
      onChange={onChange}
      showSearch
      optionFilterProp="label"
      optionRender={(option) => {
        const site = (option.data as SiteOption).site;
        return <SiteOptionLabel site={site} />;
      }}
      labelRender={(props) => {
        const site = sites.find((s) => s.id === props.value);
        if (!site) return props.label;
        return <SiteOptionLabel site={site} />;
      }}
    />
  );
}
