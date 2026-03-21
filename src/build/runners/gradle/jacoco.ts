import { XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import path from 'path';

export interface IstanbulFile {
  s:            Record<string, number>;
  statementMap: Record<string, { start: { line: number } }>;
  f:            Record<string, number>;
  fnMap:        Record<string, { name: string; decl: { start: { line: number } } }>;
  branchMap:    Record<string, never>;
}
export type IstanbulCoverage = Record<string, IstanbulFile>;

interface JacocoLine   { '@_nr': string; '@_ci': string }
interface JacocoMethod { '@_name': string; '@_line': string; counter?: JacocoCounter | JacocoCounter[] }
interface JacocoCounter { '@_type': string; '@_missed': string; '@_covered': string }
interface JacocoClass  { '@_name': string; '@_sourcefilename': string; method?: JacocoMethod | JacocoMethod[] }
interface JacocoSourcefile { '@_name': string; line?: JacocoLine | JacocoLine[] }
interface JacocoPackage {
  '@_name': string;
  class?: JacocoClass | JacocoClass[];
  sourcefile?: JacocoSourcefile | JacocoSourcefile[];
}
interface JacocoReport { report?: { package?: JacocoPackage | JacocoPackage[] } }

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: { maxTotalExpansions: Number.MAX_SAFE_INTEGER } });

/** Resolve absolute path for a JaCoCo source file entry. Falls back to relative path. */
function resolveSourcePath(pkgName: string, filename: string, modulePath: string): string {
  const rel = pkgName + '/' + filename;
  for (const srcDir of ['src/main/kotlin', 'src/main/java', 'src/main']) {
    const candidate = path.join(modulePath, srcDir, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return rel;
}

/** Parse a JaCoCo XML report string into Istanbul coverage-final.json format. */
export function parseJacocoXml(
  xmlContent: string,
  modulePath: string,
  _projectRoot: string,
): IstanbulCoverage {
  const doc = parser.parse(xmlContent) as JacocoReport;
  const coverage: IstanbulCoverage = {};

  const packages = toArray(doc.report?.package);
  for (const pkg of packages) {
    const pkgName = pkg['@_name'];

    // Build method coverage map per source file
    const methodsByFile: Record<string, Array<{ name: string; line: number; covered: boolean }>> = {};
    for (const cls of toArray(pkg.class)) {
      const sf = cls['@_sourcefilename'];
      if (!methodsByFile[sf]) methodsByFile[sf] = [];
      for (const method of toArray(cls.method)) {
        const counters = toArray(method.counter);
        const mc = counters.find(c => c['@_type'] === 'METHOD');
        methodsByFile[sf].push({
          name:    method['@_name'],
          line:    parseInt(method['@_line'], 10),
          covered: mc ? parseInt(mc['@_covered'], 10) > 0 : false,
        });
      }
    }

    for (const sf of toArray(pkg.sourcefile)) {
      const filename = sf['@_name'];
      const absPath  = resolveSourcePath(pkgName, filename, modulePath);
      const file: IstanbulFile = { s: {}, statementMap: {}, f: {}, fnMap: {}, branchMap: {} };

      toArray(sf.line).forEach((line, i) => {
        file.s[String(i)]           = parseInt(line['@_ci'], 10);
        file.statementMap[String(i)] = { start: { line: parseInt(line['@_nr'], 10) } };
      });

      (methodsByFile[filename] ?? []).forEach((m, i) => {
        file.f[String(i)]    = m.covered ? 1 : 0;
        file.fnMap[String(i)] = { name: m.name, decl: { start: { line: m.line } } };
      });

      coverage[absPath] = file;
    }
  }
  return coverage;
}

/** Merge multiple Istanbul coverage maps, summing counts for the same file. */
export function mergeIstanbulMaps(maps: IstanbulCoverage[]): IstanbulCoverage {
  const merged: IstanbulCoverage = {};
  for (const map of maps) {
    for (const [file, data] of Object.entries(map)) {
      if (!merged[file]) {
        // statementMap and fnMap are structural metadata derived from the source file.
        // They are identical across all JaCoCo reports for the same file — only
        // execution counts (s, f) vary. We keep the first occurrence as-is.
        // branchMap is always {} because JaCoCo branch data is not mapped to Istanbul
        // branch format; it is hardcoded here rather than copied from data.branchMap
        // to ensure a clean empty object regardless of input.
        merged[file] = {
          s: { ...data.s }, statementMap: data.statementMap,
          f: { ...data.f }, fnMap: data.fnMap, branchMap: {},
        };
      } else {
        // Duplicate file entry: sum execution counts only.
        for (const id of Object.keys(data.s)) {
          merged[file].s[id] = (merged[file].s[id] ?? 0) + data.s[id];
        }
        for (const id of Object.keys(data.f)) {
          merged[file].f[id] = (merged[file].f[id] ?? 0) + data.f[id];
        }
      }
    }
  }
  return merged;
}

function toArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}
