// Vitest 5 reporter for the end-to-end benchmark (bench/e2e/run.mjs): absolute per-file phase durations (the
// v5 `Duration` line only prints percentages, and the JSON reporter has no phases; docs/lab/research/vitest-env.md
// §8). Writes JSON to $RSDOM_PHASES_OUT.
//
// Phases per file (ms), as Vitest 5 defines them (reporters/durationBreakdown.ts):
//   environment = environmentLoad (env module import + setup(); see Pitfall A for isolate: false)
//   worker      = prepareDuration
//   transform   = setupFetchDuration + collectFetchDuration (waiting on Vite)
//   setup       = setupDuration - setupFetchDuration
//   import      = collectDuration - collectFetchDuration
//   tests       = the file's test + hook time
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const r1 = (x) => Math.round((x ?? 0) * 10) / 10;

export default class PhaseReporter {
  onInit(vitest) {
    this.vitest = vitest;
    this.t0 = performance.now();
  }

  onTestRunEnd(testModules) {
    const wall = performance.now() - this.t0;
    const files = testModules.map((m) => {
      const d = m.diagnostic();
      const f = m.task;
      const fetchS = f.setupFetchDuration ?? 0;
      const fetchC = f.collectFetchDuration ?? 0;
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      for (const t of m.children.allTests()) {
        const s = t.result().state;
        if (s === 'passed') passed++;
        else if (s === 'failed') failed++;
        else skipped++;
      }
      return {
        file: path.relative(this.vitest.config.root, m.moduleId),
        workerId: d.workerId,
        environment: r1(d.environmentSetupDuration),
        worker: r1(d.prepareDuration),
        transform: r1(fetchS + fetchC),
        setup: r1(d.setupDuration - fetchS),
        import: r1(d.collectDuration - fetchC),
        tests: r1(d.duration),
        state: m.state(),
        passed,
        failed,
        skipped,
      };
    });
    const state = this.vitest.state;
    const out = {
      wall: r1(wall),
      startupTime: r1(state.startupTime),
      workersSpawned: state.workersSpawned,
      pool: this.vitest.config.pool,
      isolate: this.vitest.config.isolate,
      maxWorkers: this.vitest.config.maxWorkers,
      files,
    };
    if (process.env.RSDOM_PHASES_OUT) writeFileSync(process.env.RSDOM_PHASES_OUT, JSON.stringify(out));
  }
}
