import type { AnalysisReport, AnalysisOptions } from '../types.js';

const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const RED   = '\x1b[31m';
const CYAN  = '\x1b[36m';
const RESET = '\x1b[0m';

function line(s = ''): void { process.stdout.write(s + '\n'); }

export function consoleReport(report: AnalysisReport, _opts: AnalysisOptions = {}): void {
  const { highOverlapPairs, zeroContribution, hotLines, consolidationGroups } = report.redundancy;
  const { fragileLines, uncoveredFunctions, lowCoverageFiles } = report.coverageDepth;

  line();
  line(`${BOLD}coverage-insights${RESET}`);
  line(`  ${CYAN}Consolidation groups${RESET}  ${consolidationGroups.length}`);
  line(`  ${CYAN}High-overlap pairs  ${RESET}  ${highOverlapPairs.length}`);
  line(`  ${RED}Zero-contribution   ${RESET}  ${zeroContribution.length}`);
  line(`  ${DIM}Hot lines           ${RESET}  ${hotLines.length}`);
  line(`  ${DIM}Fragile lines       ${RESET}  ${fragileLines.length}`);
  line(`  ${RED}Uncovered functions ${RESET}  ${uncoveredFunctions.length}`);
  line(`  ${RED}Low-coverage files  ${RESET}  ${lowCoverageFiles.length}`);
}
