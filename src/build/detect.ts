import fs from 'fs';
import path from 'path';
import { JEST_CONFIG_NAMES, VITEST_CONFIG_NAMES } from './runners/common.js';

export type RunnerType = 'vitest' | 'jest';

export function detectRunner(projectRoot: string, runnerFlag?: string): RunnerType {
  if (runnerFlag === 'jest') return 'jest';
  if (runnerFlag === 'vitest') return 'vitest';

  // Check for jest config files
  for (const name of JEST_CONFIG_NAMES) {
    if (fs.existsSync(path.join(projectRoot, name))) return 'jest';
  }

  // Check for "jest" key in package.json
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8') as string) as Record<string, unknown>;
      if ('jest' in pkg) return 'jest';
    } catch { /* malformed package.json — ignore */ }
  }

  // Check for vitest config files
  for (const name of VITEST_CONFIG_NAMES) {
    if (fs.existsSync(path.join(projectRoot, name))) return 'vitest';
  }

  return 'vitest';
}
