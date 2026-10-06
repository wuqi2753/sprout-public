// REQ-061: use production date rules with isolated in-memory recording metadata.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/storage/memo-statistics-rules.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const dateRules = {};
vm.runInNewContext(`(function(exports) { ${compiled}\n})`)(dateRules);

export function recordingStartModules() {
  let firstRecordedAt = null;
  return {
    '@/storage/memo-statistics-rules': dateRules,
    '@/storage/recording-start': {
      async rememberRecordingStart(dates) {
        firstRecordedAt = dateRules.earliestRecordingDate(firstRecordedAt, dates);
        return firstRecordedAt;
      },
    },
  };
}
