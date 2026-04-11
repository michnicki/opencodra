import picomatch from 'picomatch';
import type { RepoConfig } from '@shared/schema';

export type DiffLineKind = 'context' | 'add' | 'del';

export type DiffLine = {
  kind: DiffLineKind;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  position: number;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export type FileDiff = {
  path: string;
  previousPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  lineCount: number;
  hunks: DiffHunk[];
};

const defaultSkipMatchers = ['**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/*.min.js'].map((pattern) =>
  picomatch(pattern, { dot: true }),
);

export function parseUnifiedDiff(rawDiff: string): FileDiff[] {
  const lines = rawDiff.replace(/\r\n/g, '\n').split('\n');
  const files: FileDiff[] = [];

  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let position = 0;

  const pushCurrentFile = () => {
    if (currentFile) {
      files.push(currentFile);
    }
    currentFile = null;
    currentHunk = null;
    oldLine = 0;
    newLine = 0;
    position = 0;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      pushCurrentFile();
      currentFile = {
        path: '',
        previousPath: null,
        isNew: false,
        isDeleted: false,
        isBinary: false,
        lineCount: 0,
        hunks: [],
      };
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith('rename from ')) {
      currentFile.previousPath = line.slice('rename from '.length);
      continue;
    }

    if (line.startsWith('rename to ')) {
      currentFile.path = line.slice('rename to '.length);
      continue;
    }

    if (line.startsWith('new file mode ')) {
      currentFile.isNew = true;
      continue;
    }

    if (line.startsWith('deleted file mode ')) {
      currentFile.isDeleted = true;
      continue;
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      currentFile.isBinary = true;
      continue;
    }

    if (line.startsWith('--- ')) {
      continue;
    }

    if (line.startsWith('+++ ')) {
      const nextPath = line.slice(4);
      currentFile.path = nextPath.startsWith('b/') ? nextPath.slice(2) : nextPath;
      continue;
    }

    if (line.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) {
        continue;
      }

      oldLine = Number.parseInt(match[1], 10);
      newLine = Number.parseInt(match[2], 10);
      currentHunk = {
        header: line,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    const prefix = line[0];
    if (![' ', '+', '-'].includes(prefix)) {
      continue;
    }

    position += 1;

    if (prefix === ' ') {
      currentHunk.lines.push({
        kind: 'context',
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        position,
      });
      oldLine += 1;
      newLine += 1;
      currentFile.lineCount += 1;
      continue;
    }

    if (prefix === '+') {
      currentHunk.lines.push({
        kind: 'add',
        content: line.slice(1),
        newLineNumber: newLine,
        position,
      });
      newLine += 1;
      currentFile.lineCount += 1;
      continue;
    }

    currentHunk.lines.push({
      kind: 'del',
      content: line.slice(1),
      oldLineNumber: oldLine,
      position,
    });
    oldLine += 1;
    currentFile.lineCount += 1;
  }

  pushCurrentFile();

  return files.filter((file) => file.path);
}

export function getValidNewLines(file: FileDiff) {
  return new Set(
    file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind !== 'del' && line.newLineNumber !== undefined)
        .map((line) => line.newLineNumber as number),
    ),
  );
}

export function getValidPositions(file: FileDiff) {
  return new Set(
    file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind !== 'del')
        .map((line) => line.position),
    ),
  );
}

export function findPositionForLine(file: FileDiff, lineNumber: number) {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLineNumber === lineNumber && line.kind !== 'del') {
        return line.position;
      }
    }
  }

  return undefined;
}

export function filterReviewableFiles(files: FileDiff[], config: RepoConfig['review']) {
  const customMatchers = config.skip_files.map((pattern) => picomatch(pattern, { dot: true }));

  return files
    .filter((file) => !file.isDeleted && !file.isBinary)
    .filter((file) => !defaultSkipMatchers.some((matcher) => matcher(file.path)))
    .filter((file) => !customMatchers.some((matcher) => matcher(file.path)))
    .sort((left, right) => Number(left.isNew) - Number(right.isNew) || left.path.localeCompare(right.path))
    .slice(0, config.max_files);
}
