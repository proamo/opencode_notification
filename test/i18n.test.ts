import { describe, expect, test } from "bun:test";
import { canonicalizeLocale, resolveLocale, translate } from "../src/i18n";
import { en, zhTW } from "../src/i18n/catalogs";

describe("localization", () => {
  test("keeps catalog keys in parity", () => {
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
  });

  test.each([
    ["zh_TW.UTF-8", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["zh_HK", "zh-TW"],
    ["en_US.UTF-8", "en"],
    ["en-GB", "en"],
    ["zh-CN", undefined],
    ["ja-JP", undefined],
  ] as const)("canonicalizes %s", (input, expected) => {
    expect(canonicalizeLocale(input)).toBe(expected);
  });

  test("uses explicit, OpenCode, system, then English priority", () => {
    expect(resolveLocale({ explicit: "en", openCode: "zh-TW", system: "zh_TW" })).toBe("en");
    expect(resolveLocale({ explicit: "auto", openCode: "zh-TW", system: "en_US" })).toBe("zh-TW");
    expect(resolveLocale({ system: "zh_Hant_TW.UTF-8" })).toBe("zh-TW");
    expect(resolveLocale({ system: "ja_JP.UTF-8" })).toBe("en");
  });

  test("translates from the selected catalog", () => {
    expect(translate("en", "event.completed")).toBe("Task completed");
    expect(translate("zh-TW", "event.completed")).toBe("工作已完成");
  });
});
