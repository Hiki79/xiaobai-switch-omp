/** Frontend redaction helper — never log full secrets. */
export function redactSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
