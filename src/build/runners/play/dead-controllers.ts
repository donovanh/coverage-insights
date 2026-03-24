import fs from 'fs';
import path from 'path';
import { parseRoutes } from './routes.js';

export type ControllerStatus = 'routed' | 'view-referenced' | 'java-referenced' | 'test-only' | 'unreferenced';

export interface ControllerResult {
  relativePath: string;
  simpleName:   string;
  status:       ControllerStatus;
  refs: {
    inRoutes:     boolean;
    inViews:      boolean;
    inJava:       boolean;
    inTests:      boolean;
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walk(dir: string, ext: string, results: string[] = []): string[] {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, ext, results);
      else if (entry.isFile() && entry.name.endsWith(ext)) results.push(full);
    }
  } catch { /* ignore */ }
  return results;
}

function readAll(files: string[]): string {
  return files.map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
}

/**
 * Analyse all controllers under app/controllers/ in projectRoot.
 * Returns one ControllerResult per concrete controller class.
 */
export function analyseControllers(projectRoot: string): ControllerResult[] {
  const controllersDir = path.join(projectRoot, 'app', 'controllers');
  const appDir         = path.join(projectRoot, 'app');
  const testDir        = path.join(projectRoot, 'test');
  const viewsDir       = path.join(projectRoot, 'app', 'views');
  const routesPath     = path.join(projectRoot, 'conf', 'routes');

  if (!fs.existsSync(controllersDir)) return [];

  const routes = fs.existsSync(routesPath) ? parseRoutes(routesPath) : [];
  const routesText = fs.existsSync(routesPath) ? fs.readFileSync(routesPath, 'utf8') : '';
  const viewsText  = readAll(walk(viewsDir,      '.html'));
  const javaText   = readAll(walk(appDir,        '.java').filter(f => !f.includes('/controllers/')));
  const testText   = readAll(walk(testDir,       '.java'));

  const ctrlFiles = walk(controllersDir, '.java');
  const results: ControllerResult[] = [];

  for (const filePath of ctrlFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const isAbstract = /\babstract\s+class\b/.test(content) || /\binterface\b/.test(content);
    if (isAbstract) continue;

    const simpleName  = path.basename(filePath, '.java');
    const relPath     = path.relative(path.join(projectRoot, 'app'), filePath).replace(/\\/g, '/');
    const relativePath = 'app/' + relPath;

    // Routes: look for "SimpleClassName.action" or FQN-based reference
    const routeRef = relPath.replace(/\.java$/, '').replace(/\//g, '.');
    const routePattern  = new RegExp(`\\b${escapeRegex(routeRef.replace(/^controllers\./, ''))}\\.\\w+`);
    const inRoutes = routePattern.test(routesText) ||
      routes.some(r => r.controllerFqn.endsWith(simpleName));

    // Views: @{ControllerName.action()}
    const viewPattern = new RegExp(`@\\{[\\w.]*${escapeRegex(simpleName)}\\.`);
    const inViews = viewPattern.test(viewsText);

    // Non-controller Java source
    const javaPattern = new RegExp(`\\b${escapeRegex(simpleName)}[.\\s(]`);
    const inJava = javaPattern.test(javaText);

    // Test files
    const testPattern = new RegExp(`\\b${escapeRegex(simpleName)}\\b`);
    const inTests = testPattern.test(testText);

    let status: ControllerStatus;
    if (inRoutes)     status = 'routed';
    else if (inViews) status = 'view-referenced';
    else if (inJava)  status = 'java-referenced';
    else if (inTests) status = 'test-only';
    else              status = 'unreferenced';

    results.push({ relativePath, simpleName, status, refs: { inRoutes, inViews, inJava, inTests } });
  }

  return results;
}
