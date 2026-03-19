import fs from "node:fs/promises";
import path from "node:path";

interface OptionsFile {
  username?: string;
  password?: string;
}

export async function readE2eCredentials(): Promise<{ username: string; password: string }> {
  const optionsPath = path.join(process.cwd(), ".batty", "options.json");
  const options = JSON.parse(await fs.readFile(optionsPath, "utf8")) as OptionsFile;

  if (!options.username || !options.password) {
    throw new Error(`Missing username/password in ${optionsPath}`);
  }

  return {
    username: options.username,
    password: options.password,
  };
}
