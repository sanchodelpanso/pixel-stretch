/**
 * Download a JPEG blob as a file.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Generate an export filename with timestamp.
 */
export function exportFilename(extension = 'jpg'): string {
  return `PixelStretch-${Date.now()}.${extension}`;
}
