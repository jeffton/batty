import type { CloudBrowserCredentials } from "@/shared/cloud-browser";

interface CredentialDocument extends Document {
  __battyCredentials?: {
    token: string;
    url: string;
    username: HTMLInputElement;
    password: HTMLInputElement;
  };
}

// Executed in the top-level document, never across iframe origins.
export function prepareCredentialFields(token: string): boolean {
  const doc = document as CredentialDocument;
  delete doc.__battyCredentials;
  const visible = (input: HTMLInputElement) =>
    !input.disabled &&
    !input.readOnly &&
    input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const passwords = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')]
    .filter(visible)
    .filter((input) => !input.autocomplete.split(" ").includes("new-password"));
  if (passwords.length !== 1) return false;
  const password = passwords[0]!;
  const candidates = [...(password.form ?? document).querySelectorAll<HTMLInputElement>("input")]
    .filter(visible)
    .filter((input) => ["text", "email", "tel"].includes(input.type))
    .filter(
      (input) => !!(input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
  const marked = candidates.filter((input) => input.autocomplete.split(" ").includes("username"));
  const usernames = marked.length ? marked : candidates;
  if (usernames.length !== 1) return false;
  doc.__battyCredentials = { token, url: location.href, username: usernames[0]!, password };
  return true;
}

// Validate and write in one synchronous document operation. Navigation cannot move the
// credentials into another document between the check and either value assignment.
export function fillCredentialFields(command: CloudBrowserCredentials): boolean {
  const doc = document as CredentialDocument;
  const fields = doc.__battyCredentials;
  delete doc.__battyCredentials;
  if (
    !fields ||
    fields.token !== command.target.token ||
    fields.url !== command.target.url ||
    location.href !== command.target.url ||
    location.origin !== command.target.origin ||
    [fields.username, fields.password].some(
      (input) =>
        !input.isConnected ||
        input.ownerDocument !== document ||
        input.disabled ||
        input.readOnly ||
        !input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    ) ||
    fields.password.type !== "password" ||
    !["text", "email", "tel"].includes(fields.username.type)
  )
    return false;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const fill = (input: HTMLInputElement, value: string) => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  fill(fields.username, command.username);
  // Controlled forms may synchronously rerender in response to username events.
  // Do not target a detached/replaced password field or follow a navigation.
  if (
    location.href !== command.target.url ||
    location.origin !== command.target.origin ||
    !fields.username.isConnected ||
    !fields.password.isConnected ||
    fields.password.ownerDocument !== document ||
    fields.password.type !== "password" ||
    fields.password.disabled ||
    fields.password.readOnly ||
    !fields.password.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  )
    return false;
  fill(fields.password, command.password);
  return (
    fields.username.isConnected &&
    fields.password.isConnected &&
    fields.username.value === command.username &&
    fields.password.value === command.password
  );
}
