export const DEFAULT_APP_TITLE = "Batty";
export const DEFAULT_APP_COLOR = "neutral";

export const APP_COLOR_OPTIONS = [
  { id: "neutral", label: "Neutral", light: "#ffffff", dark: "#172128" },
  { id: "blue", label: "Blue", light: "#eaf2ff", dark: "#172640" },
  { id: "teal", label: "Teal", light: "#e5f5f1", dark: "#12332f" },
  { id: "green", label: "Green", light: "#edf6e7", dark: "#203321" },
  { id: "amber", label: "Amber", light: "#fff3d6", dark: "#392a13" },
  { id: "rose", label: "Rose", light: "#fbecef", dark: "#3a2028" },
  { id: "violet", label: "Violet", light: "#f2edff", dark: "#2b2340" },
] as const;

export type AppColor = (typeof APP_COLOR_OPTIONS)[number]["id"];

export interface AppAppearance {
  title: string;
  color: AppColor;
}

export function appColorOption(color: AppColor): (typeof APP_COLOR_OPTIONS)[number] {
  return APP_COLOR_OPTIONS.find((option) => option.id === color)!;
}
