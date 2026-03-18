import {
  ensureOptionsFile,
  migrateLegacyStateDirectory,
  optionsFilePath,
} from "../src/server/options";

const projectRoot = process.cwd();

await migrateLegacyStateDirectory(projectRoot);
await ensureOptionsFile(projectRoot);

console.log(`Prepared pi-face state in ${optionsFilePath(projectRoot)}`);
