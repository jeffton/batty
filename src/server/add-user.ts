import { loadConfig, resolveBattyDir } from "./config";
import { PasskeyAuthService } from "./passkeys";

const config = await loadConfig(resolveBattyDir());
const passkeys = new PasskeyAuthService(config.battyDir, config.authSecret);
const setup = await passkeys.issueSetupCode("add-user");

console.log(`Setup code: ${setup.code}`);
console.log(`Expires at: ${new Date(setup.expiresAt).toISOString()}`);
