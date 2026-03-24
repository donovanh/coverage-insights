import { describe, it, expect } from 'vitest';
import path from 'path';
import { discoverITestCases } from '../../src/build/runners/play/itest-analysis.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/play-project');

describe('discoverITestCases', () => {
  it('finds ITest files in test/', () => {
    const cases = discoverITestCases(FIXTURE);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('does not include UTest files', () => {
    const cases = discoverITestCases(FIXTURE);
    expect(cases.every(tc => tc.file.endsWith('ITest.java'))).toBe(true);
  });

  it('produces one TestCase per @Test-like method', () => {
    const cases = discoverITestCases(FIXTURE);
    // HomeControllerITest has testIndex + testSubmit; AdminControllerITest has testList + testCreate
    expect(cases.length).toBe(4);
  });

  it('sets describePath to the ITest class name', () => {
    const cases = discoverITestCases(FIXTURE);
    const home = cases.filter(tc => tc.describePath === 'test.controllers.HomeControllerITest');
    expect(home.length).toBe(2);
  });

  it('maps EndpointTest url() patterns to controller source files', () => {
    const cases = discoverITestCases(FIXTURE);
    const testIndex = cases.find(tc => tc.title === 'testIndex' && tc.describePath.includes('HomeController'));
    expect(testIndex).toBeDefined();
    // url("home") should resolve to app/controllers/HomeController.java
    expect(testIndex!.staticTargets?.some(t => t.includes('HomeController.java'))).toBe(true);
  });

  it('maps AdminControllerITest url("admin") to AdminController', () => {
    const cases = discoverITestCases(FIXTURE);
    const testList = cases.find(tc => tc.title === 'testList');
    expect(testList).toBeDefined();
    expect(testList!.staticTargets?.some(t => t.includes('AdminController.java'))).toBe(true);
  });

  it('applies fileFilter when provided', () => {
    const cases = discoverITestCases(FIXTURE, 'HomeController');
    expect(cases.every(tc => tc.file.includes('HomeController'))).toBe(true);
  });
});
