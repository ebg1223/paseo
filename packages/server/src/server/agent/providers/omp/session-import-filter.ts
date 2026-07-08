import path from "node:path";

export function filterOmpImportableSessionFiles(input: {
  filePaths: readonly string[];
  sessionsDir: string;
}): string[] {
  const normalizedFiles = new Set(input.filePaths.map((filePath) => path.normalize(filePath)));
  return input.filePaths.filter((filePath) =>
    isOmpImportableSessionFile({
      filePath,
      normalizedFiles,
      sessionsDir: input.sessionsDir,
    }),
  );
}

export function isOmpImportableSessionFile(input: {
  filePath: string;
  normalizedFiles: ReadonlySet<string>;
  sessionsDir: string;
}): boolean {
  const normalizedRoot = path.normalize(input.sessionsDir);
  let currentDir = path.dirname(path.normalize(input.filePath));

  while (isWithinDirectory(currentDir, normalizedRoot)) {
    if (input.normalizedFiles.has(`${currentDir}.jsonl`)) {
      return false;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return true;
}

function isWithinDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
