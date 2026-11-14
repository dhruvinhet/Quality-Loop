import { FAILURE_MODES } from '../config/failureModes';
import { normalise, normaliseText } from './normalise';
import { canonicalCode, validModeCode } from './failureModes';
import { evidenceUrlError } from './urls';

export const CAPTURE_FIELDS = [
  'recordType', 'partNumber', 'failureMode', 'supplier', 'line',
  'detectedDate', 'closedDate', 'effectivenessEvidenceUrl', 'rootCause', 'actionsTaken',
];

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateCapture(input = {}, modes = FAILURE_MODES, storedFailureMode) {
  const errors = {};
  if (!['NC', 'CAPA'].includes(input.recordType)) errors.recordType = 'Select NC or CAPA.';
  if (typeof input.partNumber !== 'string' || !input.partNumber.trim()) {
    errors.partNumber = 'Enter a part number.';
  }
  const selectedCode = canonicalCode(input.failureMode);
  const keepsStoredCode = validModeCode(selectedCode) && selectedCode === canonicalCode(storedFailureMode);
  if (!keepsStoredCode && !modes.some(({ code, active }) => active && code === selectedCode)) {
    errors.failureMode = 'Select a failure mode.';
  }
  if (input.recordType === 'NC' && !input.detectedDate) errors.detectedDate = 'Select a detected date for an NC.';
  if (input.recordType === 'CAPA' && !input.closedDate) {
    errors.closedDate = 'Select a closed date for a CAPA. Matching uses this date, not Jira status.';
  }
  for (const field of ['detectedDate', ...(input.recordType === 'CAPA' ? ['closedDate'] : [])]) {
    if (input[field] != null && input[field] !== '' && !validDate(input[field])) errors[field] = 'Enter a valid date (YYYY-MM-DD).';
  }
  const textFields = ['partNumber', 'supplier', 'line', ...(input.recordType === 'CAPA' ? ['effectivenessEvidenceUrl', 'rootCause', 'actionsTaken'] : [])];
  for (const field of textFields) {
    if (input[field] != null && typeof input[field] !== 'string') errors[field] = 'Enter text.';
    else if (input[field]?.length > 2000) errors[field] = 'Use 2,000 characters or fewer.';
  }
  const url = input.recordType === 'CAPA' ? input.effectivenessEvidenceUrl : '';
  if (url != null && url !== '') {
    const reason = evidenceUrlError(url);
    if (reason) errors.effectivenessEvidenceUrl = reason;
  }
  return errors;
}

export function buildCapture(input, now = new Date().toISOString(), revisionPreset) {
  return {
    schemaVersion: 3,
    recordType: input.recordType,
    ...normalise(input.partNumber, revisionPreset),
    failureMode: normaliseText(input.failureMode),
    supplier: input.supplier ?? '',
    supplierNorm: normaliseText(input.supplier ?? ''),
    line: input.line ?? '',
    lineNorm: normaliseText(input.line ?? ''),
    detectedDate: input.detectedDate || null,
    closedDate: input.recordType === 'CAPA' ? input.closedDate || null : null,
    effectivenessEvidenceUrl: input.recordType === 'CAPA' ? input.effectivenessEvidenceUrl || '' : '',
    rootCause: input.recordType === 'CAPA' ? input.rootCause || '' : '',
    actionsTaken: input.recordType === 'CAPA' ? input.actionsTaken || '' : '',
    updatedAt: now,
  };
}
