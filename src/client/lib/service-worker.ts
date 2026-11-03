import { withBaseUrl } from "./base-url";

export function appServiceWorkerScope(): string {
  const base = withBaseUrl("/");
  return base.endsWith("/") ? base : `${base}/`;
}

export function getAppServiceWorkerController(): ServiceWorker | undefined {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return undefined;
  const scriptUrl = new URL(withBaseUrl("/sw.js"), window.location.origin).href;
  return controller?.scriptURL === scriptUrl ? controller : undefined;
}

export async function getAppServiceWorkerRegistration(): Promise<
  ServiceWorkerRegistration | undefined
> {
  if (!navigator.serviceWorker) return undefined;
  const scope = new URL(appServiceWorkerScope(), window.location.origin).href;
  const registration = await navigator.serviceWorker.getRegistration(scope);
  // getRegistration returns the longest matching ancestor, including a root
  // installation while this installation's worker is still being registered.
  return registration?.scope === scope ? registration : undefined;
}
