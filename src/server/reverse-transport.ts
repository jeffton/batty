/** Only the existing agent API is bridgeable, never arbitrary HTTP or owner routes. */
export function isNodeRoute(route: string, method: string): boolean {
  if (method === "POST") return route === "commands" || route === "unpair";
  if (method !== "GET") return false;
  if (["identity", "workspaces", "catalog/events"].includes(route)) return true;
  if (/^assignments\/\d+$/.test(route)) return true;
  if (/^sessions\/\d+\/events(?:\?after=\d+)?$/.test(route)) return true;
  const file = /^files\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)$/.exec(route);
  return (
    !!file &&
    file.slice(1).every((part) => {
      try {
        const decoded = decodeURIComponent(part);
        return decoded !== "." && decoded !== ".." && !/[\\/\0]/.test(decoded);
      } catch {
        return false;
      }
    })
  );
}
