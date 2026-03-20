import { execFileSync, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Runner, TestCase } from '../index.js';
import { escape, VITEST_CONFIG_NAMES } from './common.js';

/** Resolve vitest config: use provided path or auto-detect in project root. */
function resolveConfig(projectRoot: string, configPath: string | undefined): string[] {
  if (configPath) return ['--config', configPath];
  for (const name of VITEST_CONFIG_NAMES) {
    if (fs.existsSync(path.join(projectRoot, name))) return ['--config', path.join(projectRoot, name)];
  }
  return [];
}

export const vitestRunner: Runner = {
  async discover(projectRoot, fileFilter, configPath) {
    const configArgs = resolveConfig(projectRoot, configPath);
    let rawJson: string;
    try {
      rawJson = execFileSync(
        'npx',
        ['vitest', 'run', ...(fileFilter ? [fileFilter] : []), '--reporter=json', ...configArgs],
        { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 },
      );
    } catch (err: unknown) {
      rawJson = (err as { stdout?: string }).stdout ?? '';
    }
    if (!rawJson.trim()) return [];

    const report = JSON.parse(rawJson) as {
      testResults?: Array<{
        name: string;
        assertionResults?: Array<{
          status: string;
          ancestorTitles?: string[];
          fullName: string;
          title?: string;
        }>;
      }>;
    };

    const testCases: TestCase[] = [];
    for (const fileResult of report.testResults ?? []) {
      const filePath = fileResult.name;
      if (fileFilter && !filePath.includes(fileFilter)) continue;
      for (const assertion of fileResult.assertionResults ?? []) {
        if (assertion.status === 'skipped' || assertion.status === 'todo') continue;
        const describePath = ((assertion.ancestorTitles ?? []) as string[]).join(' > ');
        testCases.push({ filePath, fullName: assertion.fullName, title: assertion.title ?? assertion.fullName, describePath });
      }
    }
    return testCases;
  },

  async runOne(tc, projectRoot, workerDir, configPath) {
    const configArgs = resolveConfig(projectRoot, configPath);
    return new Promise((resolve, reject) => {
      execFile('npx', [
        'vitest', 'run',
        tc.filePath,
        '-t', escape(tc.fullName),
        '--coverage',
        '--coverage.provider=istanbul',
        '--coverage.reporter=json',
        `--coverage.reportsDirectory=${workerDir}`,
        ...configArgs,
      ], { cwd: projectRoot, maxBuffer: 50 * 1024 * 1024 }, err => {
        if (err) reject(err); else resolve();
      });
    });
  },

  async aggregate(projectRoot, aggregateDir, configPath) {
    const configArgs = resolveConfig(projectRoot, configPath);
    try {
      execFileSync('npx', [
        'vitest', 'run',
        '--coverage',
        '--coverage.provider=istanbul',
        '--coverage.reporter=json',
        `--coverage.reportsDirectory=${aggregateDir}`,
        ...configArgs,
      ], { cwd: projectRoot, stdio: 'pipe', encoding: 'utf8' });
    } catch {
      // test failures are OK — coverage is still written
    }
  },
};
