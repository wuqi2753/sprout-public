// REQ-061: persist the earliest observed creation timestamp in private storage.
import * as FileSystem from 'expo-file-system';
import { earliestRecordingDate } from './memo-statistics-rules';

let pendingWrite: Promise<string | null> = Promise.resolve(null);
export function rememberRecordingStart(dates: Date[]): Promise<string | null> {
  async function readAndSave() {
    const file = new FileSystem.File(FileSystem.Paths.document, 'first-recorded-at.txt');
    const saved = file.exists ? await file.text() : null;
    const earliest = earliestRecordingDate(saved, dates);
    if (earliest !== null && earliest !== saved) file.write(earliest);
    return earliest;
  }
  // Both branches retry the actual operation; callers receive every failure.
  pendingWrite = pendingWrite.then(readAndSave, readAndSave);
  return pendingWrite;
}
