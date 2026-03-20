/* eslint-disable */
const path = require('path');

/** @type {import('jest').Config} */
module.exports = {
  rootDir: path.join(__dirname, '../..'),
  testMatch: ['**/tests/jest/**/*.test.ts'],
  transform: { '^.+\\.tsx?$': ['babel-jest', { configFile: path.join(__dirname, 'babel.config.js') }] },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageProvider: 'babel',
};
