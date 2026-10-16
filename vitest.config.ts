import { configDefaults, defineConfig } from "vitest/config";

// hub/ is a separate Next.js app with its own deps and test run (`npm test` inside hub/).
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "hub/**"] },
});
