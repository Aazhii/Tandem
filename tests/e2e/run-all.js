'use strict';

/** Runs every browser test, one after another. `npm test` in tests/e2e. */
(async () => {
  const suites = [
    ['playback (plain)', () => require('./playback')('plain', 8160)],
    ['playback (nasty)', () => require('./playback')('nasty', 8170)],
    ['sync', () => require('./sync')(8600)],
    ['fullscreen', () => require('./fullscreen')(8400)],
    ['settings', () => require('./settings')(8500)],
  ];
  const failed = [];
  for (const [name, run] of suites) {
    const fails = await run();
    if (fails) failed.push(`${name} (${fails})`);
  }
  console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : '\nALL BROWSER TESTS PASSED');
  process.exit(failed.length ? 1 : 0);
})();
