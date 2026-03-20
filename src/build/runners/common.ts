/** Escape a string so test runner -t / --testNamePattern treats it as a literal, not a regex. */
export function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const JEST_CONFIG_NAMES   = ['jest.config.js',   'jest.config.ts',   'jest.config.mjs',   'jest.config.cjs']   as const;
export const VITEST_CONFIG_NAMES = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'] as const;
