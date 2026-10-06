// REQ-061: local metadata, independent of filtering and Server configuration.
import { earliestRecordingDate } from './memo-statistics-rules';
const RECORDING_START_KEY = 'sprout.first-recorded-at';
export async function rememberRecordingStart(dates: Date[]): Promise<string | null> {
  if (typeof window === 'undefined') return earliestRecordingDate(null, dates);
  const saved = window.localStorage.getItem(RECORDING_START_KEY);
  const earliest = earliestRecordingDate(saved, dates);
  if (earliest !== null && earliest !== saved) window.localStorage.setItem(RECORDING_START_KEY, earliest);
  return earliest;
}
