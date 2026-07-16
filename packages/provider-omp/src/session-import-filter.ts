export function filterOmpImportableSessionFiles(input: {
  filePaths: readonly string[];
  sessionsDir: string;
}): string[] {
  return [...input.filePaths];
}
