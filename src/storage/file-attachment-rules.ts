// REQ-040: docs/stories/v0.2.0/REQ-040-receive-shared-files.md
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const FILE_MEDIA_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

export function validateFileAttachment(name: string, size: number) {
  const basename = name.split(/[\\/]/).at(-1)?.trim() ?? '';
  if (!basename || /[\u0000-\u001f\u007f]/.test(basename)) throw new Error('文件名无效，请重新选择文件。');
  const extension = basename.split('.').at(-1)?.toLowerCase() ?? '';
  const mediaType = FILE_MEDIA_TYPES[extension];
  if (!mediaType) throw new Error('仅支持 PDF、XLS、XLSX 和 CSV 文件。');
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('文件为空或无法读取文件大小。');
  if (size > MAX_FILE_BYTES) throw new Error('文件超过 20 MiB，请选择较小的文件。');
  return { name: basename, mediaType, size };
}
