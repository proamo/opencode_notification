import { en, type MessageKey, zhTW } from "./catalogs";

export type SupportedLocale = "en" | "zh-TW";

const catalogs: Record<SupportedLocale, Record<MessageKey, string>> = {
  en,
  "zh-TW": zhTW,
};

export function canonicalizeLocale(locale: string | undefined): SupportedLocale | undefined {
  if (!locale) return undefined;

  const normalized = locale.split(/[.@]/, 1)[0]?.replaceAll("_", "-").toLowerCase();
  if (
    normalized === "zh-tw" ||
    normalized === "zh-hk" ||
    normalized === "zh-mo" ||
    normalized === "zh-hant" ||
    normalized?.startsWith("zh-hant-")
  ) {
    return "zh-TW";
  }
  if (normalized === "en" || normalized?.startsWith("en-")) return "en";
  return undefined;
}

export function resolveLocale(input: {
  explicit?: string;
  openCode?: string;
  system?: string;
}): SupportedLocale {
  return (
    canonicalizeLocale(input.explicit) ??
    canonicalizeLocale(input.openCode) ??
    canonicalizeLocale(input.system) ??
    "en"
  );
}

export function translate(locale: SupportedLocale, key: MessageKey): string {
  return catalogs[locale][key];
}
