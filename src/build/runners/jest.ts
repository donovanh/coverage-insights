import { execFileSync, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Runner, TestCase } from '../index.js';
import { escape, JEST_CONFIG_NAMES } from './common.js';

/** Resolve jest config: use provided path or auto-detect in project root. */
function resolveConfig(projectRoot: string, configPath: string | undefined): string[] {
  if (configPath) return [`--config=${configPath}`];
  for (const name of JEST_CONFIG_NAMES) {
    if (fs.existsSync(path.join(projectRoot, name))) return [`--config=${path.join(projectRoot, name)}`];
  }
  return [];
}

export const jestRunner: Runner = {
  async discover(projectRoot, fileFilter, configPath) {
    const configArgs = resolveConfig(projectRoot, configPath);
    let rawJson: string;
    try {
      rawJson = execFileSync(
        'npx',
        ['jest', '--json', '--forceExit', ...(fileFilter ? [`--testPathPattern=${fileFilter}`] : []), ...configArgs],
        { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 },
      );
    } catch (err: unknown) {
      rawJson = (err as { stdout?: string }).stdout ?? '';
    }
    if (!rawJson.trim()) return [];

    // Jest JSON format: testResults[].name is the file path, testResults[].assertionResults are the tests
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
        'jest',
        `--testPathPattern=${escape(tc.filePath)}`,
        `--testNamePattern=${escape(tc.fullName)}`,
        '--coverage',
        '--coverageReporters=json',
        `--coverageDirectory=${workerDir}`,
        '--forceExit',
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
        'jest',
        '--coverage',
        '--coverageReporters=json',
        `--coverageDirectory=${aggregateDir}`,
        '--forceExit',
        ...configArgs,
      ], { cwd: projectRoot, stdio: 'pipe', encoding: 'utf8' });
    } catch { /* test failures OK — coverage still written */ }
  },
};
