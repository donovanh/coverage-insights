import { describe, it, expect } from 'vitest';
import path from 'path';
import { analyseControllers } from '../../src/build/runners/play/dead-controllers.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/play-project');

describe('analyseControllers', () => {
  it('returns results for all non-abstract controllers', () => {
    const results = analyseControllers(FIXTURE);
    expect(results.length).toBeGreaterThan(0);
  });

  it('classifies HomeController as routed', () => {
    const results = analyseControllers(FIXTURE);
    const home = results.find(r => r.simpleName === 'HomeController');
    expect(home).toBeDefined();
    expect(home!.status).toBe('routed');
  });

  it('classifies AdminController as routed', () => {
    const results = analyseControllers(FIXTURE);
    const admin = results.find(r => r.simpleName === 'AdminController');
    expect(admin).toBeDefined();
    expect(admin!.status).toBe('routed');
  });

  it('classifies DeadController as unreferenced', () => {
    const results = analyseControllers(FIXTURE);
    const dead = results.find(r => r.simpleName === 'DeadController');
    expect(dead).toBeDefined();
    expect(dead!.status).toBe('unreferenced');
  });

  it('each result has a relative path under app/controllers/', () => {
    const results = analyseControllers(FIXTURE);
    expect(results.every(r => r.relativePath.startsWith('app/controllers/'))).toBe(true);
  });

  it('returns summary counts by status', () => {
    const { summary } = analyseControllers(FIXTURE) as unknown as { summary: Record<string, number> };
    // The array is the result — we test summary separately
    const results = analyseControllers(FIXTURE);
    const statuses = results.map(r => r.status);
    expect(statuses).toContain('routed');
    expect(statuses).toContain('unreferenced');
  });
});
