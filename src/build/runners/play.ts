import fs from 'fs';
import path from 'path';
import type { Runner, TestCase } from '../index.js';
import { gradleRunner } from './gradle.js';
import { discoverITestCases, type PlayITestCase } from './play/itest-analysis.js';

function isITest(tc: TestCase): tc is PlayITestCase {
  return tc.filePath.endsWith('ITest.java');
}

/**
 * Play Framework runner — wraps the Gradle runner and adds:
 * - ITest discovery via static route + import analysis
 * - Static coverage estimation for ITests (no Gradle invocation needed)
 * Dead controller detection is available via analyseControllers() for companion scripts.
 */
export const playRunner: Runner = {
  defaultConcurrency: gradleRunner.defaultConcurrency,

  async discover(projectRoot, fileFilter, configPath) {
    // Real UTest cases from Gradle source scanning
    const uTestCases = await gradleRunner.discover(projectRoot, fileFilter, configPath);
    // ITest cases via static analysis of *ITest.java files + routes
    const iTestCases = discoverITestCases(projectRoot, fileFilter);
    return [...uTestCases, ...iTestCases];
  },

  async runOne(tc, projectRoot, workerDir, configPath) {
    if (isITest(tc)) {
      // ITests can't run in isolation — write static coverage instead
      fs.mkdirSync(workerDir, { recursive: true });
      writeStaticCoverage(tc, workerDir, projectRoot);
    } else {
      await gradleRunner.runOne(tc, projectRoot, workerDir, configPath);
    }
  },

  async runAll(projectRoot, workDir, testCases) {
    // Split: UTests via Gradle batch, ITests via static analysis
    const uTests = testCases?.filter(tc => !isITest(tc));
    const iTests = testCases?.filter(isITest) ?? [];

    // Run Gradle batch for UTests (non-empty only — Gradle errors on no tests)
    if (uTests && uTests.length > 0) {
      await gradleRunner.runAll!(projectRoot, workDir, uTests);
    }

    // Write static coverage JSON for each ITest method directly into workDir
    for (const tc of iTests) {
      const key = (tc.describePath + '.' + tc.title).replace(/[^a-zA-Z0-9._-]/g, '_');
      const outFile = path.join(workDir, `${key}.json`);
      const coverage = buildStaticCoverageMap(tc, projectRoot);
      if (Object.keys(coverage).length > 0) {
        fs.writeFileSync(outFile, JSON.stringify(coverage), 'utf8');
      }
    }
  },

  aggregate: gradleRunner.aggregate,
};

/** Build a compact coverage map { [absPath]: lineNumbers[] } from static targets. */
function buildStaticCoverageMap(tc: PlayITestCase, projectRoot: string): Record<string, number[]> {
  const coverage: Record<string, number[]> = {};
  for (const target of tc.staticTargets ?? []) {
    const absPath = path.isAbsolute(target) ? target : path.join(projectRoot, target);
    if (!fs.existsSync(absPath)) continue;
    // Estimate: mark all non-blank, non-comment lines as "covered"
    const lines = estimateCoveredLines(absPath);
    if (lines.length > 0) coverage[absPath] = lines;
  }
  return coverage;
}

/** Write a coverage-final.json for an ITest into workerDir. */
function writeStaticCoverage(tc: PlayITestCase, workerDir: string, projectRoot: string): void {
  const coverage = buildStaticCoverageMap(tc, projectRoot);
  fs.writeFileSync(path.join(workerDir, 'coverage-final.json'), JSON.stringify(coverage), 'utf8');
}

/** Return line numbers that are likely executable (non-blank, non-comment, non-brace-only). */
function estimateCoveredLines(filePath: string): number[] {
  const lines: number[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8').split('\n');
    for (let i = 0; i < content.length; i++) {
      const trimmed = content[i].trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (trimmed === '{' || trimmed === '}' || trimmed === '};') continue;
      lines.push(i + 1);
    }
  } catch { /* ignore */ }
  return lines;
}
