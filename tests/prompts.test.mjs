import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_AGENTS } from '../dist/agents/prompts.js';

describe('REVIEW_AGENTS', () => {
  test('has exactly 11 agents', () => {
    assert.equal(REVIEW_AGENTS.length, 11);
  });

  test('all agents have required fields', () => {
    for (const agent of REVIEW_AGENTS) {
      assert.ok(agent.id, `Agent missing id`);
      assert.ok(agent.name, `Agent ${agent.id} missing name`);
      assert.ok(agent.systemPrompt.length > 100, `Agent ${agent.id} has too short system prompt`);
      assert.equal(typeof agent.shouldRun, 'function', `Agent ${agent.id} missing shouldRun`);
    }
  });

  test('all agent IDs are unique', () => {
    const ids = REVIEW_AGENTS.map((a) => a.id);
    const uniqueIds = new Set(ids);
    assert.equal(uniqueIds.size, ids.length);
  });

  test('security agent always runs', () => {
    const secAgent = REVIEW_AGENTS.find((a) => a.id === 'security');
    assert.ok(secAgent);
    assert.equal(secAgent.shouldRun([]), true);
  });

  test('react-standards agent only runs with React files', () => {
    const reactAgent = REVIEW_AGENTS.find((a) => a.id === 'react-standards');
    assert.ok(reactAgent);

    const noReactFiles = [{ isReact: false, isTypeScript: true, isTest: false, isListener: false, isService: false, isView: false, isConstants: false }];
    const reactFiles = [{ isReact: true, isTypeScript: true, isTest: false, isListener: false, isService: false, isView: false, isConstants: false }];

    assert.equal(reactAgent.shouldRun(noReactFiles), false);
    assert.equal(reactAgent.shouldRun(reactFiles), true);
  });

  test('type-safety agent runs for TS files', () => {
    const tsAgent = REVIEW_AGENTS.find((a) => a.id === 'type-safety');
    assert.ok(tsAgent);
    
    const tsFiles = [{ isTypeScript: true, isReact: false, isTest: false, isListener: false, isService: false, isView: false, isConstants: false }];
    assert.equal(tsAgent.shouldRun(tsFiles), true);
    assert.equal(tsAgent.shouldRun([]), false);
  });

  test('system prompts contain JSON output instruction', () => {
    for (const agent of REVIEW_AGENTS) {
      assert.ok(agent.systemPrompt.includes('"findings"'), 
        `Agent ${agent.id} prompt missing JSON output instruction`);
    }
  });
});

console.log('✅ prompts tests passed');
