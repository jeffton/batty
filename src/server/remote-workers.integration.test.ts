import { afterAll, beforeAll, vi } from "vite-plus/test";
import { registerRemoteWorkerPairingTests } from "./remote-workers.integration-pairing";
import { registerRemoteWorkerExecutionTests } from "./remote-workers.integration-execution";
import { registerRemoteWorkerCatalogTests } from "./remote-workers.integration-catalog";
import { registerRemoteWorkerFilesTests } from "./remote-workers.integration-files";

beforeAll(() => vi.stubEnv("PI_OFFLINE", "1"));
afterAll(() => vi.unstubAllEnvs());

registerRemoteWorkerPairingTests();
registerRemoteWorkerExecutionTests();
registerRemoteWorkerCatalogTests();
registerRemoteWorkerFilesTests();
