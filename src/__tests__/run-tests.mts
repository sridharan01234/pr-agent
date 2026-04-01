import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Simple transpile test - verify the modules can be imported
describe('Module smoke tests', () => {
  test('classifier module loads', async () => {
    const { classifyFiles } = await import('../agents/classifier.js');
    assert.equal(typeof classifyFiles, 'function');
  });

  test('aggregator module loads', async () => {
    const { aggregateReports } = await import('../agents/aggregator.js');
    assert.equal(typeof aggregateReports, 'function');
  });

  test('prompts module loads', async () => {
    const { REVIEW_AGENTS } = await import('../agents/prompts.js');
    assert.ok(Array.isArray(REVIEW_AGENTS));
    assert.equal(REVIEW_AGENTS.length, 11);
  });
});
