import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('fs');

import { execFileSync } from 'child_process';
import fs from 'fs';

const mockExecFileSync = vi.mocked(execFileSync);
const mockFs = vi.mocked(fs);

const CACHE_DIR = path.join(os.homedir(), '.coverage-insights');
const JAR_PATH = path.join(CACHE_DIR, 'listener.jar');
const HASH_PATH = path.join(CACHE_DIR, 'listener.jar.hash');

// The module uses an inlined LISTENER_SOURCE — the hash is fixed at build time.
// We derive the expected hash by doing one build run and capturing what the module
// writes to the hash file. See 'ACTUAL_LISTENER_HASH' below.
// Helper: set up mocks for a fresh build scenario and capture the hash written
async function getActualListenerHash(): Promise<string> {
  vi.clearAllMocks();
  mockFs.existsSync.mockReturnValue(false);
  mockFs.mkdirSync.mockReturnValue(undefined);
  mockFs.writeFileSync.mockReturnValue(undefined);
  mockFs.copyFileSync.mockReturnValue(undefined);
  mockFs.rmSync.mockReturnValue(undefined);
  mockFs.mkdtempSync.mockReturnValue('/tmp/fake-listener-build');
  mockExecFileSync.mockReturnValue(Buffer.from(''));

  const mod = await import('../../src/setup/gradle-listener.js?t=hash-probe');
  mod.ensureListenerJar('/project');

  const hashWrite = mockFs.writeFileSync.mock.calls.find(c =>
    String(c[0]).endsWith('listener.jar.hash')
  );
  return hashWrite ? String(hashWrite[1]) : '';
}

let ACTUAL_LISTENER_HASH = '';

beforeEach(async () => {
  vi.clearAllMocks();

  if (!ACTUAL_LISTENER_HASH) {
    ACTUAL_LISTENER_HASH = await getActualListenerHash();
    vi.clearAllMocks();
  }

  // Default: readFileSync returns the correct hash for cache-hit scenarios.
  // The module no longer reads PerTestCoverageListener.java from disk (it's inlined).
  mockFs.readFileSync.mockImplementation((p: unknown) => {
    const filePath = String(p);
    if (filePath.endsWith('listener.jar.hash')) {
      return ACTUAL_LISTENER_HASH;
    }
    return '';
  });

  // Default fs mocks
  mockFs.existsSync.mockReturnValue(false);
  mockFs.mkdirSync.mockReturnValue(undefined);
  mockFs.writeFileSync.mockReturnValue(undefined);
  mockFs.copyFileSync.mockReturnValue(undefined);
  mockFs.rmSync.mockReturnValue(undefined);
  mockFs.mkdtempSync.mockReturnValue('/tmp/fake-listener-build');

  // Default: execFileSync succeeds
  mockExecFileSync.mockReturnValue(Buffer.from(''));
});

// Lazy import so mocks are set up first
async function importModule() {
  const mod = await import('../../src/setup/gradle-listener.js?t=' + Date.now());
  return mod;
}

describe('ensureListenerJar', () => {
  it('returns cached path without calling execFileSync when JAR exists and hash matches', async () => {
    // JAR exists and hash file exists with matching hash
    mockFs.existsSync.mockImplementation((p: unknown) => {
      const filePath = String(p);
      return filePath === JAR_PATH || filePath === HASH_PATH;
    });

    const { ensureListenerJar } = await importModule();
    const result = ensureListenerJar('/project');

    expect(result).toBe(JAR_PATH);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('builds when JAR does not exist', async () => {
    // JAR does not exist
    mockFs.existsSync.mockReturnValue(false);

    const { ensureListenerJar } = await importModule();
    const result = ensureListenerJar('/project');

    expect(result).toBe(JAR_PATH);
    expect(mockExecFileSync).toHaveBeenCalledOnce();
    const call = mockExecFileSync.mock.calls[0];
    const args = call[1] as string[];
    expect(args).toContain('jar');
    expect(args).toContain('--no-daemon');
  });

  it('rebuilds when JAR exists but hash does not match', async () => {
    // JAR exists, hash file exists but contains stale hash
    mockFs.existsSync.mockImplementation((p: unknown) => {
      const filePath = String(p);
      return filePath === JAR_PATH || filePath === HASH_PATH;
    });
    mockFs.readFileSync.mockImplementation((p: unknown) => {
      const filePath = String(p);
      if (filePath.endsWith('listener.jar.hash')) {
        return 'stale-hash-that-does-not-match';
      }
      return '';
    });

    const { ensureListenerJar } = await importModule();
    const result = ensureListenerJar('/project');

    expect(result).toBe(JAR_PATH);
    expect(mockExecFileSync).toHaveBeenCalledOnce();
  });

  it('always returns path to ~/.coverage-insights/listener.jar', async () => {
    mockFs.existsSync.mockReturnValue(false);

    const { ensureListenerJar } = await importModule();
    const result = ensureListenerJar('/project');

    expect(result).toBe(JAR_PATH);
    expect(result).toContain(os.homedir());
    expect(result).toContain('.coverage-insights');
    expect(result).toContain('listener.jar');
  });

  it('writes the new hash after a successful build', async () => {
    mockFs.existsSync.mockReturnValue(false);

    const { ensureListenerJar } = await importModule();
    ensureListenerJar('/project');

    const hashWrite = mockFs.writeFileSync.mock.calls.find(
      c => String(c[0]).endsWith('listener.jar.hash')
    );
    expect(hashWrite).toBeDefined();
    // The written hash must be a valid sha256 hex string
    expect(hashWrite![1]).toMatch(/^[0-9a-f]{64}$/);
    // And it must match what the module consistently computes (ACTUAL_LISTENER_HASH)
    expect(hashWrite![1]).toBe(ACTUAL_LISTENER_HASH);
  });

  it('writes the required gradle build files into temp dir', async () => {
    mockFs.existsSync.mockReturnValue(false);

    const { ensureListenerJar } = await importModule();
    ensureListenerJar('/project');

    const writtenPaths = mockFs.writeFileSync.mock.calls.map(c => String(c[0]));
    expect(writtenPaths.some(p => p.endsWith('build.gradle'))).toBe(true);
    expect(writtenPaths.some(p => p.endsWith('settings.gradle'))).toBe(true);
    expect(writtenPaths.some(p => p.endsWith('PerTestCoverageListener.java'))).toBe(true);
  });

  it('writes the RunListener service file', async () => {
    mockFs.existsSync.mockReturnValue(false);

    const { ensureListenerJar } = await importModule();
    ensureListenerJar('/project');

    const serviceWrite = mockFs.writeFileSync.mock.calls.find(c =>
      String(c[0]).includes('META-INF') && String(c[0]).includes('services')
    );
    expect(serviceWrite).toBeDefined();
    expect(serviceWrite![1]).toBe('com.coverageinsights.PerTestCoverageListener');
  });

  it('cleans up the temp directory after build', async () => {
    mockFs.existsSync.mockReturnValue(false);

    const { ensureListenerJar } = await importModule();
    ensureListenerJar('/project');

    expect(mockFs.rmSync).toHaveBeenCalledWith('/tmp/fake-listener-build', {
      recursive: true,
      force: true,
    });
  });

  it('cleans up temp dir on build failure', async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('gradle build failed');
    });

    const { ensureListenerJar } = await importModule();

    expect(() => ensureListenerJar('/project')).toThrow('gradle build failed');

    expect(mockFs.rmSync).toHaveBeenCalledWith('/tmp/fake-listener-build', {
      recursive: true,
      force: true,
    });
  });
});
