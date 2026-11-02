import { appColorOption, type AppAppearance } from "@/shared/appearance";

export function applyAppAppearance(appearance: AppAppearance): void {
  const color = appColorOption(appearance.color);
  const root = document.documentElement;

  root.style.setProperty("--color-instance-light", color.light);
  root.style.setProperty("--color-instance-dark", color.dark);
  document.title = appearance.title;

  const lightThemeColor = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"][media="(prefers-color-scheme: light)"]',
  );
  const darkThemeColor = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"][media="(prefers-color-scheme: dark)"]',
  );
  lightThemeColor!.content = color.light;
  darkThemeColor!.content = color.dark;
}
