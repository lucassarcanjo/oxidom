// One worker thread at a time, one fresh worker per file: every file loads the addon on a NEW thread after
// the previous one exited (the pattern that crashed with mimalloc v3 as the global allocator).
export default {
  test: { include: ['*.spec.mjs'], pool: 'threads', maxWorkers: 1, isolate: true },
};
