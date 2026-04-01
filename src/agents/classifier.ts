import type { ChangedFile, FileStatus } from './types.js';

interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export function classifyFiles(rawFiles: RawFile[]): ChangedFile[] {
  return rawFiles.map(classifyFile);
}

function classifyFile(raw: RawFile): ChangedFile {
  const path = raw.filename;
  const lower = path.toLowerCase();

  const isTypeScript = lower.endsWith('.ts') || lower.endsWith('.tsx');
  const isReact = lower.endsWith('.tsx') || lower.endsWith('.jsx');
  const isTest =
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('__tests__/') ||
    lower.includes('/tests/');
  const isConstants = lower.includes('constants') || lower.includes('.constants.');
  const isListener = lower.includes('listener') || lower.includes('handler');
  const isService = lower.includes('.service.') || lower.includes('service/');
  const isView =
    lower.includes('.view.') ||
    lower.includes('view/') ||
    lower.includes('component') ||
    lower.includes('panel');

  return {
    path,
    status: normalizeStatus(raw.status),
    linesAdded: raw.additions,
    linesRemoved: raw.deletions,
    patch: raw.patch ?? '',
    isTypeScript,
    isReact,
    isTest,
    isConstants,
    isListener,
    isService,
    isView,
  };
}

function normalizeStatus(status: string): FileStatus {
  const validStatuses = new Set(['added', 'modified', 'removed', 'renamed']);
  if (validStatuses.has(status)) {
    return status as FileStatus;
  }
  return 'modified';
}
