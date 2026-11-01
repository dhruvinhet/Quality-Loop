import { normalise } from './normalise';
import { windowStart } from './match';
import { escapeJqlValue } from './matchJql';

export function buildHintJql(capture) {
  const part = escapeJqlValue(normalise(capture.partOriginal).partNorm);
  const start = escapeJqlValue(windowStart(capture.detectedDate));
  const detected = escapeJqlValue(capture.detectedDate);
  // No failure-mode restriction: its stored original may differ in case/spacing.
  // IS EMPTY is not documented for date property aliases. The second query
  // deliberately has no date clause; selectHints checks fresh missing values.
  return [
    `qlRecordType = "CAPA" AND qlClosed >= ${start} AND qlClosed < ${detected} ORDER BY qlClosed DESC, key ASC`,
    `qlRecordType = "CAPA" AND qlPart = ${part} ORDER BY key ASC`,
    `qlRecordType = "CAPA" AND qlPart = ${part} AND qlClosed < ${start} ORDER BY qlClosed DESC, key ASC`,
  ];
}
