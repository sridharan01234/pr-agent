#!/usr/bin/env node
/**
 * Test runner using Node.js built-in test module.
 * Runs all test files and reports results.
 */
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const testDir = resolve(import.meta.dirname);
const testFiles = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join(testDir, f));

const stream = run({
  files: testFiles,
  concurrency: false,
});

stream.compose(spec()).pipe(process.stdout);

stream.on('test:fail', () => { process.exitCode = 1; });
