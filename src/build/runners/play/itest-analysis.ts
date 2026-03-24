import fs from 'fs';
import path from 'path';
import type { TestCase } from '../../index.js';
import { parseRoutes, matchRoute, type Route } from './routes.js';

export interface PlayITestCase extends TestCase {
  file: string;
  staticTargets: string[];
}

/** Recursively find all *ITest.java files under dir. */
function findITestFiles(dir: string, results: string[] = []): string[] {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findITestFiles(full, results);
      else if (entry.isFile() && entry.name.endsWith('ITest.java')) results.push(full);
    }
  } catch { /* ignore */ }
  return results;
}

/** Extract public void test*() method names from a Java class body. */
function extractTestMethods(content: string): string[] {
  const methods: string[] = [];
  // Match "public void testFoo()" style (Play 1.x ITests don't use @Test)
  for (const m of content.matchAll(/\bpublic\s+void\s+(test\w+)\s*\(/g)) {
    methods.push(m[1]);
  }
  return methods;
}

/** Resolve a controller FQN to a source file path under app/. */
function resolveController(controllerFqn: string, appDir: string): string | null {
  // e.g. "controllers.HomeController" → "app/controllers/HomeController.java"
  const relPath = controllerFqn.replace(/\./g, '/') + '.java';
  const direct = path.join(appDir, relPath);
  if (fs.existsSync(direct)) return direct;

  // Strip leading "controllers." prefix
  const stripped = controllerFqn.replace(/^controllers\./, '');
  const fallback = path.join(appDir, 'controllers', stripped.replace(/\./g, '/') + '.java');
  if (fs.existsSync(fallback)) return fallback;

  return null;
}

/** Extract url("seg1","seg2",...) call segments from EndpointTest body. */
function extractUrlSegments(content: string): string[][] {
  const results: string[][] = [];
  for (const m of content.matchAll(/\burl\s*\(([^)]+)\)/g)) {
    const segs: string[] = [];
    for (const s of m[1].matchAll(/"([^"]+)"/g)) segs.push(s[1]);
    if (segs.length > 0) results.push(segs);
  }
  return results;
}

/** Check if the content is an EndpointTest subclass (direct or indirect via common base names). */
function isEndpointTest(content: string): boolean {
  return /extends\s+(EndpointTest|BaseEndpointTest)\b/.test(content);
}

/**
 * Discover Play ITest files and produce TestCase entries with static source targets.
 * Each @Test-style method becomes its own TestCase; staticTargets lists source files
 * estimated to be exercised based on routes and imports.
 */
export function discoverITestCases(projectRoot: string, fileFilter?: string): PlayITestCase[] {
  const testDir = path.join(projectRoot, 'test');
  const appDir  = path.join(projectRoot, 'app');
  const routesPath = path.join(projectRoot, 'conf', 'routes');

  const routes: Route[] = fs.existsSync(routesPath) ? parseRoutes(routesPath) : [];

  const iTestFiles = findITestFiles(testDir);
  const cases: PlayITestCase[] = [];

  for (const filePath of iTestFiles) {
    if (fileFilter && !filePath.includes(fileFilter)) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const packageMatch = content.match(/^package\s+([\w.]+)\s*;/m);
    const packageName = packageMatch ? packageMatch[1] : '';
    const classMatch  = content.match(/public\s+class\s+(\w+)/);
    if (!classMatch) continue;
    const className = classMatch[1];
    const fqcn = packageName ? `${packageName}.${className}` : className;

    const methods = extractTestMethods(content);
    if (methods.length === 0) continue;

    // Static targets — controllers reached via url() for EndpointTests
    const staticTargets: string[] = [];
    const seen = new Set<string>();

    function addTarget(p: string | null) {
      if (!p || seen.has(p)) return;
      seen.add(p);
      staticTargets.push(p);
    }

    if (isEndpointTest(content)) {
      for (const segs of extractUrlSegments(content)) {
        const route = matchRoute(segs, routes);
        if (route) addTarget(resolveController(route.controllerFqn, appDir));
      }
    }

    for (const title of methods) {
      cases.push({
        filePath,
        file:        filePath,
        fullName:    `${fqcn} > ${title}`,
        title,
        describePath: fqcn,
        staticTargets: [...staticTargets],
      });
    }
  }

  return cases;
}
