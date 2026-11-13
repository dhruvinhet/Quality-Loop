import { normalise, normaliseText } from './normalise';
import { windowStart } from './match';
import { lookbackDays as defaultLookbackDays } from '../config/matching';

export function escapeJqlValue(value) {
  // Control characters must be rejected rather than escaped into a JQL literal.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid JQL value.');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildMatchJql(capture, lookbackDays = defaultLookbackDays) {
  const { partBase } = normalise(capture.partOriginal);
  return boundedJql(capture, `qlPartBase = ${escapeJqlValue(partBase)} AND qlFailureMode = ${escapeJqlValue(normaliseText(capture.failureMode))}`, lookbackDays);
}

function boundedJql(capture, signature, lookbackDays = defaultLookbackDays) {
  return `qlRecordType = "CAPA" AND ${signature} AND qlClosed >= ${escapeJqlValue(windowStart(capture.detectedDate, lookbackDays))} AND qlClosed < ${escapeJqlValue(capture.detectedDate)} ORDER BY qlClosed DESC, key ASC`;
}

export function buildOtherRelatedJql(capture) {
  const { partBase, partNorm } = normalise(capture.partOriginal);
  const failureMode = normaliseText(capture.failureMode);
  const supplier = normaliseText(capture.supplier ?? '');
  return [
    boundedJql(capture, `qlPart = ${escapeJqlValue(partNorm)} AND qlFailureMode != ${escapeJqlValue(failureMode)}`),
    ...(supplier ? [boundedJql(capture, `qlFailureMode = ${escapeJqlValue(failureMode)} AND qlSupplierNorm = ${escapeJqlValue(supplier)} AND qlPartBase != ${escapeJqlValue(partBase)}`)] : []),
  ];
}
