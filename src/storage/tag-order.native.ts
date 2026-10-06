// REQ-059: local sorting preference; no Server requests.
import * as FileSystem from 'expo-file-system';
import { readTagOrder } from './tag-order-rules';

function tagOrderFile() { return new FileSystem.File(FileSystem.Paths.document, 'tag-order.json'); }
export async function getTagOrder(): Promise<string[]> {
  const file = tagOrderFile();
  return readTagOrder(file.exists ? await file.text() : null);
}
export async function saveTagOrder(names: string[]): Promise<void> {
  const serialized = JSON.stringify(names);
  readTagOrder(serialized);
  tagOrderFile().write(serialized);
}
