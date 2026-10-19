// Fixture for test/native/vitest-env.test.mjs: runs specs inside the rsdom Vitest environment (the same path
// e2e/react-app/vitest.config.ts uses). Pool / isolation are varied from the command line by the driver test.
import { fileURLToPath } from 'node:url';

export default {
  test: {
    include: ['*.spec.mjs'],
    environment: fileURLToPath(new URL('../../../lib/vitest-environment.mjs', import.meta.url)),
    globals: true,
    setupFiles: ['./setup.mjs'],
    environmentOptions: { rsdom: { url: 'http://localhost:3000/start?q=1#top' } },
  },
};
