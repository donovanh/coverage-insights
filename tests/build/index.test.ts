import { describe, it, expect } from 'vitest';
import { batchOutputToMap } from '../../src/build/index.js';
import type { TestCase } from '../../src/build/index.js';

const TC1: TestCase = {
  filePath: '/project/application',
  fullName: 'com.example.MathTest > addsTwoNumbers',
  title: 'addsTwoNumbers',
  describePath: 'com.example.MathTest',
};

const TC2: TestCase = {
  filePath: '/project/application',
  fullName: 'com.example.MathTest > subtractsNumbers',
  title: 'subtractsNumbers',
  describePath: 'com.example.MathTest',
};

describe('batchOutputToMap', () => {
  it('maps test name to correct TestCase using safeFileName matching', () => {
    const batchRaw = {
      'com.example.MathTest.addsTwoNumbers': {
        '/project/src/main/java/com/example/Math.java': [10, 11, 12],
      },
    };

    const result = batchOutputToMap(batchRaw, [TC1, TC2], '/project');
    const key = 'application > com.example.MathTest > addsTwoNumbers';
    expect(result[key]).toBeDefined();
    expect(result[key].title).toBe('addsTwoNumbers');
    expect(result[key].fullName).toBe('com.example.MathTest > addsTwoNumbers');
  });

  it('skips entries with no matching TestCase', () => {
    const batchRaw = {
      'com.example.UnknownTest.someMethod': {
        '/project/src/main/java/com/example/Math.java': [1, 2, 3],
      },
    };

    const result = batchOutputToMap(batchRaw, [TC1], '/project');
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('skips files with empty line arrays', () => {
    const batchRaw = {
      'com.example.MathTest.addsTwoNumbers': {
        '/project/src/main/java/com/example/Math.java': [],
        '/project/src/main/java/com/example/Other.java': [5, 6],
      },
    };

    const result = batchOutputToMap(batchRaw, [TC1], '/project');
    const key = 'application > com.example.MathTest > addsTwoNumbers';
    expect(result[key]).toBeDefined();
    const sourceKeys = Object.keys(result[key].sourceLines);
    expect(sourceKeys).not.toContain('src/main/java/com/example/Math.java');
    expect(sourceKeys).toContain('src/main/java/com/example/Other.java');
  });

  it('skips entire entry when all file line arrays are empty', () => {
    const batchRaw = {
      'com.example.MathTest.addsTwoNumbers': {
        '/project/src/main/java/com/example/Math.java': [],
      },
    };

    const result = batchOutputToMap(batchRaw, [TC1], '/project');
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('correctly applies shortPath to absolute file paths', () => {
    const batchRaw = {
      'com.example.MathTest.addsTwoNumbers': {
        '/project/src/main/java/com/example/Math.java': [10, 11],
      },
    };

    const result = batchOutputToMap(batchRaw, [TC1], '/project');
    const key = 'application > com.example.MathTest > addsTwoNumbers';
    expect(result[key]).toBeDefined();
    const sourceKeys = Object.keys(result[key].sourceLines);
    // shortPath strips /project/ prefix
    expect(sourceKeys[0]).toBe('src/main/java/com/example/Math.java');
  });
});
