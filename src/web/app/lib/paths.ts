/** Path of `file` relative to the analyzed project (falls back to the last three segments). */
export function relativePath(file: string, root: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normalized = file.replace(/\\/g, "/");
  if (normalizedRoot && normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized.split("/").slice(-3).join("/");
}

export function fileName(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || file;
}
