import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs');
import fs from 'fs';

import {
  parseModules,
  moduleToPath,
  pathToModule,
  findGradleCommand,
} from '../../../src/build/runners/gradle/settings.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => vi.clearAllMocks());

describe('parseModules', () => {
  it('parses Kotlin DSL include with single module', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('settings.gradle.kts'));
    mockReadFileSync.mockReturnValue('include(":application")');
    expect(parseModules('/project')).toEqual([':application']);
  });

  it('parses Kotlin DSL include with multiple modules', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('settings.gradle.kts'));
    mockReadFileSync.mockReturnValue('include(":api", ":application", ":domain")');
    expect(parseModules('/project')).toEqual([':api', ':application', ':domain']);
  });

  it('parses Groovy DSL include', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('settings.gradle'));
    mockReadFileSync.mockReturnValue("include ':application'\ninclude ':domain'");
    expect(parseModules('/project')).toEqual([':application', ':domain']);
  });

  it('returns empty array when no settings file found', () => {
    mockExistsSync.mockReturnValue(false);
    expect(parseModules('/project')).toEqual([]);
  });

  it('returns empty array when no static includes found', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('settings.gradle.kts'));
    mockReadFileSync.mockReturnValue('// dynamic includes via buildSrc');
    expect(parseModules('/project')).toEqual([]);
  });
});

describe('moduleToPath', () => {
  it('converts :application to projectRoot/application', () => {
    expect(moduleToPath(':application', '/project')).toBe('/project/application');
  });

  it('converts nested module :db:fixtures', () => {
    expect(moduleToPath(':db:fixtures', '/project')).toBe('/project/db/fixtures');
  });
});

describe('pathToModule', () => {
  it('converts /project/application to :application', () => {
    expect(pathToModule('/project/application', '/project')).toBe(':application');
  });

  it('converts nested /project/db/fixtures to :db:fixtures', () => {
    expect(pathToModule('/project/db/fixtures', '/project')).toBe(':db:fixtures');
  });

  it('returns empty string when modulePath equals projectRoot', () => {
    expect(pathToModule('/project', '/project')).toBe('');
  });
});

describe('findGradleCommand', () => {
  it('returns ./gradlew when wrapper exists', () => {
    mockExistsSync.mockImplementation(p => String(p).endsWith('gradlew'));
    expect(findGradleCommand('/project')).toBe('./gradlew');
  });

  it('returns gradle when no wrapper found', () => {
    mockExistsSync.mockReturnValue(false);
    expect(findGradleCommand('/project')).toBe('gradle');
  });
});
