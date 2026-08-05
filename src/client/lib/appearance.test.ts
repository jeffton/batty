import { beforeEach, describe, expect, it } from "vite-plus/test";
import { applyAppAppearance } from "./appearance";

beforeEach(() => {
  document.head.innerHTML = `
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#172128" media="(prefers-color-scheme: dark)" />
  `;
  document.documentElement.removeAttribute("style");
});

describe("applyAppAppearance", () => {
  it("updates the title, paired surface colors, and PWA theme colors", () => {
    applyAppAppearance({ title: "Office Batty", color: "blue" });

    expect(document.title).toBe("Office Batty");
    expect(document.documentElement.style.getPropertyValue("--color-instance-light")).toBe(
      "#eaf2ff",
    );
    expect(document.documentElement.style.getPropertyValue("--color-instance-dark")).toBe(
      "#172640",
    );
    expect(
      document.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"][media="(prefers-color-scheme: light)"]',
      )?.content,
    ).toBe("#eaf2ff");
    expect(
      document.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"][media="(prefers-color-scheme: dark)"]',
      )?.content,
    ).toBe("#172640");
  });
});
