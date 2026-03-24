/**
 * Integration test for the --no-build pipeline with a pre-built fixture.
 * Verifies: fixture loading, HTML report generation, --open behaviour,
 * and that the recent improvements are present in the generated report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// vi.mock is hoisted, so spawnMock must be declared with vi.hoisted()
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(''),
    execFile: vi.fn().mockImplementation((_p: unknown, _a: unknown, _o: unknown, cb: (err: null) => void) => { cb(null); return {} as ReturnType<typeof actual.execFile>; }),
    spawn: spawnMock,
  };
});

import { main } from '../src/cli.js';

const FIXTURE_MAP = path.resolve(__dirname, 'fixtures/gradle-report/test-line-map.json');
const PLAY_ROOT   = path.resolve(__dirname, 'fixtures/play-project');

let outDir: string;
let originalArgv: string[];

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-fixture-'));
  originalArgv = process.argv;
  spawnMock.mockClear();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.argv = originalArgv;
  fs.rmSync(outDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function runWithFixture(extraArgs: string[] = []): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(FIXTURE_MAP, path.join(outDir, 'test-line-map.json'));
  process.argv = ['node', 'cli.js', '--no-build', `--out=${outDir}`, '--no-aggregate', ...extraArgs];
  return main();
}

describe('CLI --no-build --runner=play with play fixture', () => {
  it('report.html includes Dead Controllers section when runner=play', async () => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'test-line-map.json'), '{}', 'utf8');
    process.argv = ['node', 'cli.js', '--no-build', `--root=${PLAY_ROOT}`, `--out=${outDir}`, '--runner=play'];
    await main();
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(html).toContain('Dead controllers');
  });
});

describe('CLI --no-build with gradle fixture', () => {
  it('generates report.html from the fixture without running Gradle', async () => {
    await runWithFixture();
    expect(fs.existsSync(path.join(outDir, 'report.html'))).toBe(true);
  });

  it('report.html is valid HTML starting with <!DOCTYPE html>', async () => {
    await runWithFixture();
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('opens the browser by default', async () => {
    await runWithFixture();
    const htmlPath = path.join(outDir, 'report.html');
    expect(spawnMock).toHaveBeenCalledWith('open', [htmlPath], expect.objectContaining({ detached: true }));
  });

  it('--no-open suppresses browser launch', async () => {
    await runWithFixture(['--no-open']);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // ── Recent improvements ──────────────────────────────────────────────────────

  it('report contains toolbar with search input', async () => {
    await runWithFixture();
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(html).toContain('type="search"');
  });

  it('report contains category filter buttons', async () => {
    await runWithFixture();
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(html).toContain('Zero-contribution');
    expect(html).toContain('Hot lines');
    expect(html).toContain('Fragile lines');
  });

  it('report contains a single unified table', async () => {
    await runWithFixture();
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(html).toContain('id="ci-table"');
  });

  it('report uses data-cat attributes for row filtering', async () => {
    await runWithFixture();
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(html).toMatch(/data-cat="/);
  });

  it('report detects consolidation candidates (identical line coverage in same describe)', async () => {
    await runWithFixture();
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    // testAdd and testAddAlias cover identical lines in same describe → consolidation candidate
    expect(html).toContain('data-cat="consolidate"');
    expect(html).toContain('badge-blue');
  });

  it('report detects fragile lines (BazHelper lines covered by only one test)', async () => {
    await runWithFixture();
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(html).toContain('data-cat="fragile"');
    expect(html).toContain('badge-amber');
    expect(html).toContain('Add a second for safety');
  });

  it('report is self-contained (no external scripts or stylesheets)', async () => {
    await runWithFixture();
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link\s+rel="stylesheet"/i);
  });
});
