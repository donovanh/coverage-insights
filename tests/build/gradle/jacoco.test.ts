import { describe, it, expect, vi } from 'vitest';

vi.mock('fs');
import fs from 'fs';
vi.mocked(fs.existsSync).mockImplementation((p) =>
  String(p).includes('src/main/kotlin')
);

import { parseJacocoXml, mergeIstanbulMaps } from '../../../src/build/runners/gradle/jacoco.js';

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<report name="test">
  <package name="com/example">
    <class name="com/example/Calculator" sourcefilename="Calculator.kt">
      <method name="add" desc="(II)I" line="5">
        <counter type="METHOD" missed="0" covered="1"/>
      </method>
      <method name="subtract" desc="(II)I" line="10">
        <counter type="METHOD" missed="1" covered="0"/>
      </method>
    </class>
    <sourcefile name="Calculator.kt">
      <line nr="5" mi="0" ci="3" mb="0" cb="0"/>
      <line nr="6" mi="0" ci="2" mb="0" cb="0"/>
      <line nr="10" mi="2" ci="0" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;

describe('parseJacocoXml', () => {
  it('extracts covered lines (ci > 0)', () => {
    const result = parseJacocoXml(SAMPLE_XML, '/project/api', '/project');
    const fileKey = Object.keys(result)[0];
    expect(fileKey).toBeDefined();
    // lines 5 and 6 covered, line 10 not
    const covered = Object.entries(result[fileKey].s)
      .filter(([, v]) => v > 0)
      .map(([k]) => result[fileKey].statementMap[k].start.line);
    expect(covered).toContain(5);
    expect(covered).toContain(6);
    expect(covered).not.toContain(10);
  });

  it('maps methods to fnMap and f', () => {
    const result = parseJacocoXml(SAMPLE_XML, '/project/api', '/project');
    const fileKey = Object.keys(result)[0];
    const fnNames = Object.values(result[fileKey].fnMap).map(f => f.name);
    expect(fnNames).toContain('add');
    expect(fnNames).toContain('subtract');
    // add is covered, subtract is not
    const addId = Object.keys(result[fileKey].fnMap).find(
      k => result[fileKey].fnMap[k].name === 'add'
    )!;
    expect(result[fileKey].f[addId]).toBe(1);
    const subId = Object.keys(result[fileKey].fnMap).find(
      k => result[fileKey].fnMap[k].name === 'subtract'
    )!;
    expect(result[fileKey].f[subId]).toBe(0);
  });

  it('emits empty branchMap', () => {
    const result = parseJacocoXml(SAMPLE_XML, '/project/api', '/project');
    const fileKey = Object.keys(result)[0];
    expect(result[fileKey].branchMap).toEqual({});
  });

  it('resolves file path including src/main/kotlin prefix', () => {
    const result = parseJacocoXml(SAMPLE_XML, '/project/api', '/project');
    const fileKey = Object.keys(result)[0];
    expect(fileKey).toContain('src/main/kotlin');
    expect(fileKey).toContain('Calculator.kt');
  });
});

describe('mergeIstanbulMaps', () => {
  it('merges two maps summing statement counts', () => {
    const a = parseJacocoXml(SAMPLE_XML, '/project/api', '/project');
    const merged = mergeIstanbulMaps([a, a]);
    const fileKey = Object.keys(merged)[0];
    // ci=3 on line 5 → s value is 3; doubled = 6
    const line5Id = Object.keys(merged[fileKey].statementMap).find(
      k => merged[fileKey].statementMap[k].start.line === 5
    )!;
    expect(merged[fileKey].s[line5Id]).toBe(6);
  });
});
