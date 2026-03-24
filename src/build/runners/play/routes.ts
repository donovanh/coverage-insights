import fs from 'fs';

export interface Route {
  method: string;
  urlPattern: string;
  controllerFqn: string;
  action: string;
}

/** Parse a Play 1.x conf/routes file into Route entries. */
export function parseRoutes(routesPath: string): Route[] {
  const lines = fs.readFileSync(routesPath, 'utf8').split('\n');
  const routes: Route[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;

    const method = parts[0];
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', '*'].includes(method)) continue;

    const urlPattern = parts[1];
    const handlerRaw = parts[2].split('(')[0]; // strip query-param signature

    // Skip static asset routes
    if (handlerRaw.startsWith('staticDir:') || handlerRaw.startsWith('staticFile:')) continue;

    const lastDot = handlerRaw.lastIndexOf('.');
    if (lastDot < 0) continue;

    const controllerFqn = handlerRaw.slice(0, lastDot);
    const action = handlerRaw.slice(lastDot + 1);

    routes.push({ method, urlPattern, controllerFqn, action });
  }

  return routes;
}

/**
 * Given URL path segments (e.g. ["admin", "users"]), find the best matching route.
 * Returns null if no route matches.
 */
export function matchRoute(segments: string[], routes: Route[]): Route | null {
  let best: Route | null = null;
  let bestScore = -1;

  for (const route of routes) {
    const routeSegs = route.urlPattern.split('/').filter(s => s.length > 0);
    if (routeSegs.length < segments.length) continue;

    let score = 0;
    let mismatch = false;
    for (let i = 0; i < segments.length; i++) {
      const rSeg = routeSegs[i];
      const uSeg = segments[i];
      if (!rSeg) { mismatch = true; break; }
      if (rSeg === uSeg) {
        score += 2; // exact match
      } else if (rSeg.startsWith('{') || rSeg.startsWith('<') || rSeg === '*') {
        score += 1; // wildcard
      } else {
        mismatch = true;
        break;
      }
    }

    if (!mismatch && score > bestScore) {
      bestScore = score;
      best = route;
    }
  }

  return best;
}
