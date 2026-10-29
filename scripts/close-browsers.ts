import { loadConfig, resolveBattyDir } from "../src/server/config";
import { stateDirPath } from "../src/server/options";
import { closeBrowserProcesses } from "../src/server/browser-maintenance";

const config = await loadConfig(resolveBattyDir());
const count = await closeBrowserProcesses(stateDirPath(config.battyDir));
console.log(`Closed ${count} stored browser sessions; profiles retained.`);
