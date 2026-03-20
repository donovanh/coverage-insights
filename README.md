# coverage-insights

Per-test coverage analysis for Vitest and Jest — find redundant tests, fragile lines, and coverage gaps.

Runs your test suite once per test file, collects per-test line coverage, and cross-references it to surface actionable findings.

## Installation

```bash
# Run once with npx
npx coverage-insights

# Or install globally
npm install -g coverage-insights
```

Requires Node.js 18+. Vitest or Jest must be installed in the project you're analysing.

## Usage

Run from your project root:

```bash
coverage-insights [options]
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--root=<path>` | `cwd` | Project root to analyse |
| `--out=<path>` | `coverage-insights/` | Output directory for JSON and HTML report |
| `--html` | off | Generate an HTML report |
| `--threshold=<0-1>` | `0.9` | Jaccard similarity threshold for high-overlap pairs |
| `--low-coverage=<0-100>` | `80` | Line coverage % below which a file is flagged |
| `--top=<n>` | all | Limit each section to top N findings |
| `--file=<glob>` | all | Only run tests matching this pattern |
| `--config=<path>` | auto | Path to vitest/jest config file |
| `--runner=vitest\|jest` | auto | Force a specific runner (otherwise auto-detected) |
| `--concurrency=<n>` | auto | Max parallel test runs |

### Examples

```bash
# Basic run with HTML report
coverage-insights --html

# Analyse a specific subdirectory
coverage-insights --root=./packages/my-package --html

# Only run tests matching a pattern
coverage-insights --file="src/auth/**" --html

# Limit output to top 20 findings per section
coverage-insights --top=20 --html
```

## Output

Results are written to `coverage-insights/` (or your `--out` path):

- `report.html` — interactive HTML report (with `--html`)
- `test-line-map.json` — raw per-test line coverage data

### Report sections

| Section | What it shows |
|---------|--------------|
| **Consolidation candidates** | Tests in the same describe block with identical line coverage — candidates for `it.each` or merged assertions |
| **High-overlap pairs** | Test pairs sharing a high proportion of covered lines — one may be redundant |
| **Zero-contribution tests** | Tests whose every covered line is also covered by a single larger test |
| **Hot lines** | Source lines covered by an unusually high number of tests |
| **Fragile lines** | Source lines covered by exactly one test |
| **Uncovered functions** | Functions never called during the test run |
| **Low coverage files** | Source files below the line coverage threshold |

## Publishing a new version

```bash
# Bump patch version (0.1.0 → 0.1.1), build, test, publish
npm run release:patch

# Minor bump (0.1.0 → 0.2.0)
npm run release:minor

# Major bump (0.1.0 → 1.0.0)
npm run release:major
```

Run `npm run test:integration` manually before releasing to catch any regressions in the subprocess-based integration tests.

## Licence

MIT
