import { defineConfig } from 'vitest/config';

// A zone with an offset, so a UTC timestamp read as local time fails a test (backlog B-5);
// Madrid is where the board is used. Set here so the test workers start with it.
process.env.TZ = 'Europe/Madrid';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/__tests__/setup.ts'],
  },
});
