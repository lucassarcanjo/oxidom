// Fixture for test/native/vitest-env.test.mjs: the same specs in Vitest's VM pools under the rsdom environment
// and under Vitest's own jsdom environment (jsdom 30), which must agree. VITEST_DOM=jsdom | jetdom picks the
// environment; the pool comes from the command line.
import { fileURLToPath } from 'node:url';

export default {
  test: {
    include: [process.env.VITEST_INCLUDE ?? '*.spec.mjs'],
    environment: process.env.VITEST_DOM === 'jsdom' ? 'jsdom' : fileURLToPath(new URL('../../../lib/vitest-environment.mjs', import.meta.url)),
    environmentOptions: { jsdom: { url: 'http://localhost:3000/vm' } },
    globals: true,
  },
};
