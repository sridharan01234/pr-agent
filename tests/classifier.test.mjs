import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFiles } from '../dist/agents/classifier.js';

describe('classifyFiles', () => {
  test('classifies TypeScript service files correctly', () => {
    const files = classifyFiles([{
      filename: 'src/services/user.service.ts',
      status: 'added',
      additions: 50,
      deletions: 0,
      patch: '+ some code',
    }]);
    assert.equal(files.length, 1);
    assert.equal(files[0].isTypeScript, true);
    assert.equal(files[0].isReact, false);
    assert.equal(files[0].isService, true);
    assert.equal(files[0].isTest, false);
  });

  test('classifies React TSX files correctly', () => {
    const files = classifyFiles([{
      filename: 'src/components/UserCard.tsx',
      status: 'modified',
      additions: 10,
      deletions: 5,
      patch: '+ jsx',
    }]);
    assert.equal(files[0].isTypeScript, true);
    assert.equal(files[0].isReact, true);
    assert.equal(files[0].isView, true);
  });

  test('classifies test files correctly', () => {
    const files = classifyFiles([{
      filename: 'src/__tests__/user.test.ts',
      status: 'added',
      additions: 30,
      deletions: 0,
    }]);
    assert.equal(files[0].isTest, true);
  });

  test('normalizes unknown statuses to modified', () => {
    const files = classifyFiles([{
      filename: 'src/utils.ts',
      status: 'changed',
      additions: 1,
      deletions: 1,
    }]);
    assert.equal(files[0].status, 'modified');
  });

  test('classifies listener files correctly', () => {
    const files = classifyFiles([{
      filename: 'src/listeners/pr.listener.ts',
      status: 'added',
      additions: 20,
      deletions: 0,
    }]);
    assert.equal(files[0].isListener, true);
  });
});
