import type { CloudBrowserCredentials, CloudBrowserLogin } from "@/shared/cloud-browser";

type Fields = { username?: HTMLInputElement; password?: HTMLInputElement };
interface CredentialDocument extends Document {
  __battyLogin?: Fields & { id: string; url: string; signature: string };
  __battyCredentials?: Fields & { token: string; url: string; signature: string };
}

// Runs entirely in one top-level document. Never reads existing credential values
// for discovery, follows frames, or submits a form.
export function credentialDocumentOperation(
  command: { id: string } & (
    | { action: "detect" }
    | { action: "prepare"; token: string }
    | { action: "fill"; credentials: CloudBrowserCredentials }
  ),
): { login?: CloudBrowserLogin; filled?: boolean } {
  const doc = document as CredentialDocument;
  const visible = (input: HTMLInputElement) =>
    !input.disabled &&
    !input.readOnly &&
    input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const inputs = [...document.querySelectorAll<HTMLInputElement>("input")].filter(visible);
  const words = (input: HTMLInputElement) => input.autocomplete.split(/\s+/);
  const passwords = inputs.filter((input) => input.type === "password");
  const loginButton = (scope: ParentNode) =>
    [...scope.querySelectorAll('button, input[type="submit"]')].some((button) =>
      /^(?:sign in|log in|login|logga in)$/i.test(
        (button.textContent || button.getAttribute("value") || "").trim(),
      ),
    );
  let fields: Fields | undefined;
  if (passwords.length === 1 && !words(passwords[0]!).includes("new-password")) {
    const password = passwords[0]!;
    const scope = password.form ?? document;
    // Explicit account-creation/reset forms are not sign-in forms.
    const purpose = `${password.form?.getAttribute("action") ?? ""} ${password.form?.id ?? ""}`;
    if (
      !/sign.?up|register|registration|create.?account|reset.?password/i.test(purpose) &&
      (words(password).includes("current-password") ||
        /login|signin|sign-in|\/ax\/claim/i.test(purpose) ||
        loginButton(scope))
    ) {
      const candidates = inputs.filter(
        (input) =>
          scope.contains(input) &&
          ["text", "email", "tel"].includes(input.type) &&
          !!(input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
      const marked = candidates.filter((input) => words(input).includes("username"));
      const usernames = marked.length ? marked : candidates;
      if (usernames.length <= 1) fields = { username: usernames[0], password };
    }
  } else if (!passwords.length) {
    // Email alone is not evidence of login. Require a sign-in form action/identity
    // (including Amazon's /ax/claim) or username semantics plus a sign-in button.
    const candidates = inputs.filter((input) => {
      if (
        !["text", "email", "tel"].includes(input.type) ||
        !input.form ||
        words(input).some((word) => ["one-time-code", "new-password"].includes(word)) ||
        /otp|one.?time|verification|security.?code|newsletter|subscribe|search/i.test(
          `${input.name} ${input.id}`,
        )
      )
        return false;
      const form = input.form;
      const purpose = `${form.getAttribute("action") ?? ""} ${form.id} ${form.getAttribute("aria-label") ?? ""}`;
      if (
        /sign.?up|register|registration|newsletter|subscribe|search|reset|recover|forgot/i.test(
          purpose,
        )
      )
        return false;
      const loginPurpose =
        /(?:^|[\s/_-])(?:login|signin|sign-in|log-in|authenticate)(?:$|[\s/_.-])|\/ax\/claim/i.test(
          purpose,
        );
      return loginPurpose || (words(input).includes("username") && loginButton(form));
    });
    if (candidates.length === 1) fields = { username: candidates[0] };
  }
  const active = document.activeElement;
  if (
    (active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable)) &&
    active !== fields?.username &&
    active !== fields?.password
  )
    fields = undefined;
  const signature = fields
    ? JSON.stringify([
        fields.username?.type,
        fields.username?.autocomplete,
        fields.password?.autocomplete,
        (fields.password ?? fields.username)?.form?.getAttribute("action"),
      ])
    : "";
  const old = doc.__battyLogin;
  if (!fields) delete doc.__battyLogin;
  else if (
    !old ||
    old.url !== location.href ||
    old.signature !== signature ||
    old.username !== fields.username ||
    old.password !== fields.password
  )
    doc.__battyLogin = { ...fields, id: command.id, url: location.href, signature };
  const current = doc.__battyLogin;
  if (command.action === "detect")
    return {
      login: current
        ? { id: current.id, username: !!current.username, password: !!current.password }
        : undefined,
    };
  if (command.action === "prepare") {
    delete doc.__battyCredentials;
    if (!current) return {};
    doc.__battyCredentials = { ...current, token: command.token };
    return {
      login: { id: current.id, username: !!current.username, password: !!current.password },
    };
  }
  const stored = doc.__battyCredentials;
  delete doc.__battyCredentials;
  const { target, username, password } = command.credentials;
  if (
    !stored ||
    !current ||
    current.id !== target.loginId ||
    stored.token !== target.token ||
    stored.url !== target.url ||
    location.href !== target.url ||
    location.origin !== target.origin ||
    stored.signature !== current.signature ||
    stored.username !== current.username ||
    stored.password !== current.password ||
    (current.username && !username) ||
    (current.password && !password)
  )
    return { filled: false };
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const fill = (input: HTMLInputElement, value: string) => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (stored.username) fill(stored.username, username);
  // Controlled forms can replace the password field or navigate on username input.
  if (
    location.href !== target.url ||
    location.origin !== target.origin ||
    (stored.username && !stored.username.isConnected) ||
    (stored.password &&
      (!stored.password.isConnected ||
        stored.password.ownerDocument !== document ||
        stored.password.type !== "password" ||
        !visible(stored.password)))
  )
    return { filled: false };
  if (stored.password) fill(stored.password, password);
  return {
    filled:
      (!stored.username || (stored.username.isConnected && stored.username.value === username)) &&
      (!stored.password || (stored.password.isConnected && stored.password.value === password)),
  };
}
