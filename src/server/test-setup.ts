import { afterEach } from "vite-plus/test";
import { cleanup } from "./test-cleanup";

afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Test fixture cleanup failed");
});
