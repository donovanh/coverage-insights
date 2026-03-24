import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs');
import fs from 'fs';

import { generateInitScript, detectJacoco } from '../../../src/build/runners/gradle/init-script.js';

beforeEach(() => vi.clearAllMocks());

describe('generateInitScript', () => {
  it('standard variant includes plugins.withId("jacoco")', () => {
    expect(generateInitScript(false)).toContain('plugins.withId("jacoco")');
  });

  it('standard variant redirects XML output via coverage.insights.xmlDir property', () => {
    expect(generateInitScript(false)).toContain('coverage.insights.xmlDir');
    expect(generateInitScript(false)).toContain('jacoco.xml');
  });

  it('injection variant also applies jacoco plugin', () => {
    expect(generateInitScript(true)).toContain('apply(plugin = "jacoco")');
  });

  it('injection variant wires finalizedBy', () => {
    expect(generateInitScript(true)).toContain('finalizedBy');
  });

  it('uses TCP server mode and ExecDumpClient when pertest.dir property is present', () => {
    const script = generateInitScript(false);
    expect(script).toContain('coverage.insights.pertest.dir');
    expect(script).toContain('TCP_SERVER');
    expect(script).toContain('ExecDumpClient');
    expect(script).toContain('batchConvert(');
  });

  it('wires TestListener afterTest to dump exec data per test', () => {
    const script = generateInitScript(false);
    expect(script).toContain('addTestListener');
    expect(script).toContain('afterTest');
    expect(script).toContain('afterSuite');
  });

  it('injection variant also includes pertest TCP server support', () => {
    const script = generateInitScript(true);
    expect(script).toContain('coverage.insights.pertest.dir');
    expect(script).toContain('TCP_SERVER');
    expect(script).toContain('ExecDumpClient');
  });

  it('without pertest property, existing behaviour includes finalizedBy', () => {
    const script = generateInitScript(false);
    expect(script).toContain('finalizedBy("jacocoTestReport")');
  });
});

describe('detectJacoco', () => {
  it('returns true when build.gradle.kts contains "jacoco"', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('apply plugin: "jacoco"');
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).endsWith('build.gradle.kts'));
    expect(detectJacoco('/project', ['/project/api'])).toBe(true);
  });

  it('returns false when no build files contain "jacoco"', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('apply plugin: "java"');
    vi.mocked(fs.existsSync).mockImplementation(p =>
      String(p).endsWith('build.gradle.kts') || String(p).endsWith('build.gradle')
    );
    expect(detectJacoco('/project', [])).toBe(false);
  });

  it('returns false when build files do not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(detectJacoco('/project', [])).toBe(false);
  });
});
