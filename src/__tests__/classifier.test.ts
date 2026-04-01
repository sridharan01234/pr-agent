import { classifyFiles } from '../agents/classifier';

describe('classifyFiles', () => {
  it('classifies TypeScript service files correctly', () => {
    const files = classifyFiles([
      {
        filename: 'src/services/user.service.ts',
        status: 'added',
        additions: 50,
        deletions: 0,
        patch: '+ some code',
      },
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      isTypeScript: true,
      isReact: false,
      isService: true,
      isTest: false,
    });
  });

  it('classifies React TSX files correctly', () => {
    const files = classifyFiles([
      {
        filename: 'src/components/UserCard.tsx',
        status: 'modified',
        additions: 10,
        deletions: 5,
        patch: '+ jsx code',
      },
    ]);

    expect(files[0]).toMatchObject({
      isTypeScript: true,
      isReact: true,
      isView: true,
      isService: false,
    });
  });

  it('classifies test files correctly', () => {
    const files = classifyFiles([
      {
        filename: 'src/__tests__/user.test.ts',
        status: 'added',
        additions: 30,
        deletions: 0,
      },
    ]);

    expect(files[0]).toMatchObject({
      isTypeScript: true,
      isTest: true,
    });
  });

  it('classifies constants files correctly', () => {
    const files = classifyFiles([
      {
        filename: 'src/constants/api.constants.ts',
        status: 'modified',
        additions: 5,
        deletions: 2,
      },
    ]);

    expect(files[0]).toMatchObject({
      isTypeScript: true,
      isConstants: true,
    });
  });

  it('normalizes unknown file statuses to modified', () => {
    const files = classifyFiles([
      {
        filename: 'src/utils.ts',
        status: 'changed',
        additions: 1,
        deletions: 1,
      },
    ]);

    expect(files[0].status).toBe('modified');
  });

  it('handles empty patch gracefully', () => {
    const files = classifyFiles([
      {
        filename: 'src/config.ts',
        status: 'added',
        additions: 0,
        deletions: 0,
      },
    ]);

    expect(files[0].patch).toBe('');
  });

  it('classifies listener files correctly', () => {
    const files = classifyFiles([
      {
        filename: 'src/listeners/pr.listener.ts',
        status: 'added',
        additions: 20,
        deletions: 0,
      },
    ]);

    expect(files[0].isListener).toBe(true);
  });

  it('classifies non-TypeScript files correctly', () => {
    const files = classifyFiles([
      {
        filename: 'README.md',
        status: 'modified',
        additions: 5,
        deletions: 2,
      },
    ]);

    expect(files[0]).toMatchObject({
      isTypeScript: false,
      isReact: false,
    });
  });
});
