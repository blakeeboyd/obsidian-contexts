import { describe, expect, it } from "vitest";
import { looksClipped } from "./main";

describe("looksClipped", () => {
  it("labels a born-full note with source-URL frontmatter", () => {
    const body = "word ".repeat(30);
    expect(looksClipped(`---\nsource: "https://example.com/article"\n---\n${body}`)).toBe(true);
    expect(looksClipped(`---\nclipped: https://example.com\n---\n${body}`)).toBe(true);
  });

  it("refuses notes without a URL, and template stubs that only carry the field", () => {
    expect(looksClipped(`---\nsource: "[[Some Book]]"\n---\n${"word ".repeat(30)}`)).toBe(false);
    expect(looksClipped('---\nsource: "https://example.com"\n---\nshort stub')).toBe(false);
    expect(looksClipped("no frontmatter at all, just prose ".repeat(5))).toBe(false);
  });
});
