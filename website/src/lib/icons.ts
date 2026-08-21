export const DOC_ICONS: Record<string, string> = {
  introduction: "lucide:info",
  install: "lucide:download",
  "quick-start": "lucide:rocket",
  sites: "lucide:server",
  models: "lucide:boxes",
  "apply-claude": "lucide:bot",
  "apply-codex": "lucide:terminal",
  routes: "lucide:git-branch",
  "import-link": "lucide:link",
  backups: "lucide:archive",
  settings: "lucide:settings",
  security: "lucide:shield",
  faq: "lucide:circle-help",
};

export function docIcon(slug: string): string {
  return DOC_ICONS[slug] ?? "lucide:file-text";
}
