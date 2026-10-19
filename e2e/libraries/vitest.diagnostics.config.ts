// Same environments as vitest.config.ts, but runs diagnostics/ (root-cause facts + counterfactuals).
import base from './vitest.config'

export default { ...base, test: { ...base.test, include: ['diagnostics/**/*.test.{ts,tsx}'] } }
