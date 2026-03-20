import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Mock all heavy dependencies before importing cli
vi.mock('../src/build/index.js', () => ({
  build: vi.fn(),
}));
vi.mock('../src/build/detect.js', () => ({
  detectRunner: vi.fn().mockReturnValue('vitest'),
}));
vi.mock('../src/build/runners/vitest.js', () => ({ vitestRunner: {} }));
vi.mock('../src/build/runners/jest.js',   () => ({ jestRunner: {} }));
vi.mock('../src/analyse.js', () => ({
  analyse: vi.fn(),
}));
vi.mock('../src/report/console.js', () => ({
  consoleReport: vi.fn(),
}));
vi.mock('../src/report/html.js', () => ({
  htmlReport: vi.fn(),
}));

import { main } from '../src/cli.js';
import { build } from '../src/build/index.js';
import { detectRunner } from '../src/build/detect.js';
import { analyse } from '../src/analyse.js';
import { consoleReport } from '../src/report/console.js';
import { htmlReport } from '../src/report/html.js';

const mockBuild = vi.mocked(build);
const mockDetectRunner = vi.mocked(detectRunner);
const mockAnalyse = vi.mocked(analyse);
const mockConsoleReport = vi.mocked(consoleReport);
const mockHtmlReport = vi.mocked(htmlReport);

const FAKE_MAP = {};
const FAKE_SUMMARY = {};
const FAKE_REPORT = {
  highOverlapPairs: [],
  zeroContributionTests: [],
  hotLines: [],
  consolidationGroups: [],
  fragileLines: [],
  uncoveredFunctions: [],
  lowCoverageFiles: [],
};

describe('CLI main() (unit — no real subprocesses)', () => {
  let outDir: string;
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-unit-'));
    originalArgv = process.argv;
    vi.clearAllMocks();

    mockBuild.mockResolvedValue({ map: FAKE_MAP, summary: FAKE_SUMMARY });
    mockDetectRunner.mockReturnValue('vitest');
    mockAnalyse.mockReturnValue(FAKE_REPORT as ReturnType<typeof analyse>);
    mockConsoleReport.mockReturnValue(undefined);
    mockHtmlReport.mockReturnValue('<html>report</html>');

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    fs.rmSync(outDir, { recursive: true, force: true });
    exitSpy.mockRestore();
  });

  it('calls build with the provided --root and --out', async () => {
    process.argv = ['node', 'cli.js', `--root=${outDir}`, `--out=${outDir}/out`];
    await main();
    expect(mockBuild).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: outDir,
      outDir: path.join(outDir, 'out'),
    }), expect.anything());
  });

  it('calls analyse and consoleReport after building', async () => {
    process.argv = ['node', 'cli.js', `--root=${outDir}`, `--out=${outDir}/out`];
    await main();
    expect(mockAnalyse).toHaveBeenCalledWith(FAKE_MAP, FAKE_SUMMARY, expect.any(Object));
    expect(mockConsoleReport).toHaveBeenCalledWith(FAKE_REPORT, expect.any(Object));
  });

  it('writes report.html by default', async () => {
    process.argv = ['node', 'cli.js', `--root=${outDir}`, `--out=${outDir}/out`];
    await main();
    expect(mockHtmlReport).toHaveBeenCalled();
    expect(fs.existsSync(path.join(outDir, 'out', 'report.html'))).toBe(true);
  });

  it('does not write report.html when --no-html is passed', async () => {
    process.argv = ['node', 'cli.js', `--root=${outDir}`, `--out=${outDir}/out`, '--no-html'];
    await main();
    expect(mockHtmlReport).not.toHaveBeenCalled();
  });

  it('passes --concurrency to build when specified', async () => {
    process.argv = ['node', 'cli.js', `--root=${outDir}`, `--out=${outDir}/out`, '--concurrency=2'];
    await main();
    expect(mockBuild).toHaveBeenCalledWith(expect.objectContaining({ concurrency: 2 }), expect.anything());
  });

  it('passes undefined concurrency when --concurrency is not specified (lets build default)', async () => {
    process.argv = ['node', 'cli.js', `--root=${outDir}`, `--out=${outDir}/out`];
    await main();
    expect(mockBuild).toHaveBeenCalledWith(expect.objectContaining({ concurrency: undefined }), expect.anything());
  });

  it('exits non-zero when --root does not exist', async () => {
    process.argv = ['node', 'cli.js', '--root=/nonexistent/path/xyz', `--out=${outDir}/out`];
    await expect(main()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('passes --threshold to analyse opts', async () => {
    process.argv = ['node', 'cli.js', `--root=${outDir}`, `--out=${outDir}/out`, '--threshold=0.5'];
    await main();
    expect(mockAnalyse).toHaveBeenCalledWith(FAKE_MAP, FAKE_SUMMARY, expect.objectContaining({ threshold: 0.5 }));
  });

  it('passes --source filter to analyse opts', async () => {
    process.argv = ['node', 'cli.js', `--root=${outDir}`, `--out=${outDir}/out`, '--source=src/'];
    await main();
    expect(mockAnalyse).toHaveBeenCalledWith(FAKE_MAP, FAKE_SUMMARY, expect.objectContaining({ sourceFilter: 'src/' }));
  });

  it('passes --runner=jest flag to detectRunner', async () => {
    process.argv = ['node', 'cli.js', `--root=${outDir}`, `--out=${outDir}/out`, '--runner=jest'];
    await main();
    expect(mockDetectRunner).toHaveBeenCalledWith(outDir, 'jest');
  });
});
