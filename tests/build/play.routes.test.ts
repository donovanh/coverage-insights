import { describe, it, expect } from 'vitest';
import path from 'path';
import { parseRoutes, matchRoute } from '../../src/build/runners/play/routes.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/play-project/conf/routes');

describe('parseRoutes', () => {
  it('returns an array of route entries', () => {
    const routes = parseRoutes(FIXTURE);
    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBeGreaterThan(0);
  });

  it('skips comment lines, blank lines, and static file routes', () => {
    const routes = parseRoutes(FIXTURE);
    expect(routes.every(r => r.method && r.urlPattern && r.controllerFqn)).toBe(true);
    expect(routes.every(r => !r.controllerFqn.startsWith('staticDir'))).toBe(true);
  });

  it('parses GET /home → controllers.HomeController.index', () => {
    const routes = parseRoutes(FIXTURE);
    const home = routes.find(r => r.urlPattern === '/home' && r.method === 'GET');
    expect(home).toBeDefined();
    expect(home!.controllerFqn).toBe('controllers.HomeController');
    expect(home!.action).toBe('index');
  });

  it('parses POST /admin → controllers.AdminController.create', () => {
    const routes = parseRoutes(FIXTURE);
    const route = routes.find(r => r.urlPattern === '/admin' && r.method === 'POST');
    expect(route).toBeDefined();
    expect(route!.controllerFqn).toBe('controllers.AdminController');
    expect(route!.action).toBe('create');
  });

  it('parses parameterised routes like /admin/{id}', () => {
    const routes = parseRoutes(FIXTURE);
    const route = routes.find(r => r.urlPattern.startsWith('/admin/'));
    expect(route).toBeDefined();
    expect(route!.controllerFqn).toBe('controllers.AdminController');
    expect(route!.action).toBe('view');
  });
});

describe('matchRoute', () => {
  it('matches url segments ["home"] to HomeController', () => {
    const routes = parseRoutes(FIXTURE);
    const match = matchRoute(['home'], routes);
    expect(match).toBeDefined();
    expect(match!.controllerFqn).toBe('controllers.HomeController');
  });

  it('matches url segments ["admin"] to AdminController', () => {
    const routes = parseRoutes(FIXTURE);
    const match = matchRoute(['admin'], routes);
    expect(match).toBeDefined();
    expect(match!.controllerFqn).toBe('controllers.AdminController');
  });

  it('returns null for unmatched urls', () => {
    const routes = parseRoutes(FIXTURE);
    const match = matchRoute(['nonexistent', 'path'], routes);
    expect(match).toBeNull();
  });
});
