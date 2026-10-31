import { normalise } from './normalise';
import { windowStart } from './match';
import { lookbackDays as defaultLookbackDays } from '../config/matching';

export function escapeJqlValue(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid JQL value.');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildMatchJql(capture, lookbackDays = defaultLookbackDays) {
  const { partBase } = normalise(capture.partOriginal);
  return `qlRecordType = "CAPA" AND (qlPartBase = ${escapeJqlValue(partBase)} OR qlFailureMode = ${escapeJqlValue(capture.failureMode)}) AND qlClosed <= ${escapeJqlValue(capture.detectedDate)} AND qlClosed >= ${escapeJqlValue(windowStart(capture.detectedDate, lookbackDays))} ORDER BY qlClosed DESC, key ASC`;
}
