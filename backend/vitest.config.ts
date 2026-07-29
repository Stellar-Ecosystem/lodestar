import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.js'],
      exclude: [
        'src/**/*.test.js',
        'scripts/**',
        'node_modules/**',
        'test/**',
      ],
      // Low initial thresholds — ratchet upward as coverage improves.
      // These values are intentionally minimal: they exist to make untested
      // modules visible without blocking CI on day one.
      //
      // Known zero-coverage modules (as of initial setup):
      //   src/middleware/ownerAuth.js
      //   src/lib/activityFeed.js
      //   src/lib/reputationHistory.js
      //
      // When tests are added for these files, remove them from this list
      // and consider raising the thresholds.
      thresholds: {
        lines: 10,
        functions: 10,
        branches: 5,
        statements: 10,
      },
    },
  },
});
