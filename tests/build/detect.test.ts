import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs');

import fs from 'fs';
import { detectRunner } from '../../src/build/detect.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

describe('detectRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns "jest" when --runner=jest is passed', () => {
    expect(detectRunner('/any', 'jest')).toBe('jest');
  });

  it('returns "vitest" when --runner=vitest is passed', () => {
    expect(detectRunner('/any', 'vitest')).toBe('vitest');
  });

  it('flag overrides config files — jest flag beats vitest.config.ts', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('vitest.config.ts'));
    expect(detectRunner('/project', 'jest')).toBe('jest');
  });

  it('detects jest from jest.config.js', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('jest.config.js'));
    expect(detectRunner('/project')).toBe('jest');
  });

  it('detects jest from jest.config.ts', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('jest.config.ts'));
    expect(detectRunner('/project')).toBe('jest');
  });

  it('detects jest from "jest" key in package.json', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('package.json'));
    mockReadFileSync.mockImplementation((p: string | Buffer | number) => {
      if (String(p).endsWith('package.json')) return JSON.stringify({ jest: {} });
      return '';
    });
    expect(detectRunner('/project')).toBe('jest');
  });

  it('detects vitest from vitest.config.ts', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('vitest.config.ts'));
    expect(detectRunner('/project')).toBe('vitest');
  });

  it('defaults to vitest when no config found', () => {
    mockExistsSync.mockReturnValue(false);
    expect(detectRunner('/project')).toBe('vitest');
  });

  it('jest config takes priority over vitest config when both present', () => {
    mockExistsSync.mockImplementation(p =>
      String(p).endsWith('jest.config.js') || String(p).endsWith('vitest.config.ts')
    );
    expect(detectRunner('/project')).toBe('jest');
  });

  it('returns "gradle" when --runner=gradle is passed', () => {
    expect(detectRunner('/any', 'gradle')).toBe('gradle');
  });

  it('gradle flag beats build.gradle.kts when both present', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('build.gradle.kts'));
    expect(detectRunner('/project', 'gradle')).toBe('gradle');
  });

  it('detects gradle from build.gradle.kts', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('build.gradle.kts'));
    expect(detectRunner('/project')).toBe('gradle');
  });

  it('returns "play" when --runner=play is passed', () => {
    expect(detectRunner('/any', 'play')).toBe('play');
  });

  it('auto-detects play when conf/routes and app/controllers/ both exist', () => {
    mockExistsSync.mockImplementation(p =>
      String(p).endsWith('conf/routes') || String(p).endsWith('app/controllers'),
    );
    expect(detectRunner('/project')).toBe('play');
  });

  it('does not auto-detect play from conf/routes alone (no app/controllers)', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('conf/routes'));
    expect(detectRunner('/project')).not.toBe('play');
  });

  it('detects gradle from build.gradle', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('build.gradle'));
    expect(detectRunner('/project')).toBe('gradle');
  });

  it('jest config takes priority over build.gradle.kts when both present', () => {
    mockExistsSync.mockImplementation(p =>
      String(p).endsWith('jest.config.js') || String(p).endsWith('build.gradle.kts')
    );
    expect(detectRunner('/project')).toBe('jest');
  });
});
