import { withBaseUrl } from "./base-url";

export function redirectIfMaintenance(response: Response): void {
  if (response.status !== 503 || response.headers.get("X-Batty-Maintenance") !== "1") return;
  window.location.replace(withBaseUrl("/maintenance/"));
  throw new Error("Batty is under maintenance");
}
