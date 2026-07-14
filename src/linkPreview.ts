export interface FormattedSourceDate {
  label: string;
  dateTime: string;
}

const comparableHost = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("und")
    .replace(/\.$/u, "")
    .replace(/^www\./u, "");

export function linkPreviewDomainLabel(siteName: string, displayHost: string): string {
  const site = siteName.trim();
  const host = displayHost.trim();
  if (!site) return host;
  if (!host || comparableHost(site) === comparableHost(host)) return site;
  return `${site} · ${host}`;
}

export function linkPreviewAriaLabel(title: string, sourced: boolean): string {
  const boundedTitle = title.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 180);
  return `${sourced ? "Open looked-up source" : "Open link preview"}: ${boundedTitle || "external link"} (opens in a new tab)`;
}

export function formatSourceDate(
  value: string | undefined,
  locales?: Intl.LocalesArgument,
): FormattedSourceDate | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return {
    label: new Intl.DateTimeFormat(locales, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date),
    dateTime: date.toISOString(),
  };
}
