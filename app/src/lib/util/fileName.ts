/** Return the last path segment for a native or URL-style path. */
export function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).at(-1) ?? path;
}
