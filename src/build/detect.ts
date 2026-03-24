import fs from 'fs';
import path from 'path';
import { JEST_CONFIG_NAMES, VITEST_CONFIG_NAMES, GRADLE_BUILD_NAMES } from './runners/common.js';

export type RunnerType = 'vitest' | 'jest' | 'gradle' | 'play';

export function detectRunner(projectRoot: string, runnerFlag?: string): RunnerType {
  if (runnerFlag === 'jest') return 'jest';
  if (runnerFlag === 'vitest') return 'vitest';
  if (runnerFlag === 'gradle') return 'gradle';
  if (runnerFlag === 'play') return 'play';

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

  // Check for Play Framework (conf/routes + app/controllers/ — must precede Gradle check
  // since Play projects also have build.gradle)
  if (
    fs.existsSync(path.join(projectRoot, 'conf', 'routes')) &&
    fs.existsSync(path.join(projectRoot, 'app', 'controllers'))
  ) return 'play';

  // Check for Gradle build files
  for (const name of GRADLE_BUILD_NAMES) {
    if (fs.existsSync(path.join(projectRoot, name))) return 'gradle';
  }

  return 'vitest';
}
