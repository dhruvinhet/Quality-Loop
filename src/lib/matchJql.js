import { normalise, normaliseText } from './normalise';
import { windowStart } from './match';
import { lookbackDays as defaultLookbackDays } from '../config/matching';

export function escapeJqlValue(value) {
  // Control characters must be rejected rather than escaped into a JQL literal.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid JQL value.');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function scopedJql(jql, projectIds) {
  if (projectIds == null) return jql;
  if (!projectIds.length) throw new Error('Search project scope is empty.');
  return `project in (${projectIds.map(escapeJqlValue).join(', ')}) AND ${jql}`;
}
export function buildMatchJql(capture, lookbackDays = defaultLookbackDays, projectIds, revisionPreset) {
  const { partBase, partNorm } = normalise(capture.partOriginal, revisionPreset);
  // Independent OR branches share the existing 200-candidate budget. Exact
  // retrieval never depends on the CAPA's stored base or its project's preset.
  const exact = `qlPart = ${escapeJqlValue(partNorm)}`;
  const related = revisionPreset === 'NONE' ? '' : ` OR (qlPartBase = ${escapeJqlValue(partBase)} AND qlPart != ${escapeJqlValue(partNorm)})`;
  return scopedJql(boundedJql(capture, `(${exact}${related}) AND qlFailureMode = ${escapeJqlValue(normaliseText(capture.failureMode))}`, lookbackDays), projectIds);
}

function boundedJql(capture, signature, lookbackDays = defaultLookbackDays) {
  return `qlRecordType = "CAPA" AND ${signature} AND qlClosed >= ${escapeJqlValue(windowStart(capture.detectedDate, lookbackDays))} AND qlClosed < ${escapeJqlValue(capture.detectedDate)} ORDER BY qlClosed DESC, key ASC`;
}

export function buildOtherRelatedJql(capture, lookbackDays = defaultLookbackDays, projectIds, revisionPreset) {
  const { partBase, partNorm } = normalise(capture.partOriginal, revisionPreset);
  const failureMode = normaliseText(capture.failureMode);
  const supplier = normaliseText(capture.supplier ?? '');
  return [
    boundedJql(capture, `qlPart = ${escapeJqlValue(partNorm)} AND qlFailureMode != ${escapeJqlValue(failureMode)}`, lookbackDays),
    ...(supplier ? [boundedJql(capture, `qlFailureMode = ${escapeJqlValue(failureMode)} AND qlSupplierNorm = ${escapeJqlValue(supplier)} AND qlPartBase != ${escapeJqlValue(partBase)}`, lookbackDays)] : []),
  ].map((jql) => scopedJql(jql, projectIds));
}
