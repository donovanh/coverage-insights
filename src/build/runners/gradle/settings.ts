import fs from 'fs';
import path from 'path';

/** Parse settings.gradle.kts or settings.gradle for include() entries. */
export function parseModules(projectRoot: string): string[] {
  const kts = path.join(projectRoot, 'settings.gradle.kts');
  const groovy = path.join(projectRoot, 'settings.gradle');
  const content = fs.existsSync(kts)
    ? String(fs.readFileSync(kts, 'utf8'))
    : fs.existsSync(groovy)
    ? String(fs.readFileSync(groovy, 'utf8'))
    : null;
  if (!content) return [];

  const modules: string[] = [];

  // Kotlin DSL: include(":a") or include(":a", ":b")
  const kotlinRe = /include\s*\(\s*(["'][^"']+["'](?:\s*,\s*["'][^"']+["']\s*)*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = kotlinRe.exec(content)) !== null) {
    const args = m[1].match(/["']([^"']+)["']/g) ?? [];
    for (const arg of args) {
      const mod = arg.replace(/['"]/g, '');
      if (!modules.includes(mod)) modules.push(mod);
    }
  }

  // Groovy DSL: include ':a'
  const groovyRe = /include\s+['"]([^'"]+)['"]/g;
  while ((m = groovyRe.exec(content)) !== null) {
    if (!modules.includes(m[1])) modules.push(m[1]);
  }

  return modules;
}

/** Convert Gradle module path (:application) to filesystem path (/project/application). */
export function moduleToPath(gradleModule: string, projectRoot: string): string {
  const rel = gradleModule.replace(/^:/, '').replace(/:/g, '/');
  return path.join(projectRoot, rel);
}

/**
 * Convert filesystem module path to Gradle task prefix.
 * Returns empty string if modulePath === projectRoot (single-module fallback).
 */
export function pathToModule(modulePath: string, projectRoot: string): string {
  if (modulePath === projectRoot) return '';
  const rel = modulePath.slice(projectRoot.length + 1);
  return ':' + rel.replace(/\//g, ':');
}

/** Return './gradlew' if wrapper exists, otherwise 'gradle'. */
export function findGradleCommand(projectRoot: string): string {
  return fs.existsSync(path.join(projectRoot, 'gradlew')) ? './gradlew' : 'gradle';
}
