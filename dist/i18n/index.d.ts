import { type MessageKey } from "./catalogs";
export type SupportedLocale = "en" | "zh-TW";
export declare function canonicalizeLocale(locale: string | undefined): SupportedLocale | undefined;
export declare function resolveLocale(input: {
    explicit?: string;
    openCode?: string;
    system?: string;
}): SupportedLocale;
export declare function translate(locale: SupportedLocale, key: MessageKey): string;
//# sourceMappingURL=index.d.ts.map