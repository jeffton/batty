import {
  ensureOptionsFile,
  migrateLegacyStateDirectory,
  optionsFilePath,
} from "../src/server/options";

const projectRoot = process.cwd();

await migrateLegacyStateDirectory(projectRoot);
const options = await ensureOptionsFile(projectRoot);

if (!options.password) {
  throw new Error(`Set "password" in ${optionsFilePath(projectRoot)} before starting pi-face.`);
}

console.log(`Prepared pi-face state in ${optionsFilePath(projectRoot)}`);
