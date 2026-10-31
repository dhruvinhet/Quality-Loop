import { FAILURE_MODES } from '../config/failureModes';
import { normalise } from './normalise';

export const CAPTURE_FIELDS = [
  'recordType', 'partNumber', 'failureMode', 'supplier', 'line',
  'detectedDate', 'closedDate', 'effectivenessEvidenceUrl',
];

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateCapture(input = {}) {
  const errors = {};
  if (!['NC', 'CAPA'].includes(input.recordType)) errors.recordType = 'Select NC or CAPA.';
  if (typeof input.partNumber !== 'string' || !input.partNumber.trim()) {
    errors.partNumber = 'Enter a part number.';
  }
  if (!FAILURE_MODES.some(({ value }) => value === input.failureMode)) {
    errors.failureMode = 'Select a failure mode.';
  }
  if (input.recordType === 'NC' && !input.detectedDate) errors.detectedDate = 'Select a detected date for an NC.';
  for (const field of ['detectedDate', ...(input.recordType === 'CAPA' ? ['closedDate'] : [])]) {
    if (input[field] != null && input[field] !== '' && !validDate(input[field])) errors[field] = 'Enter a valid date (YYYY-MM-DD).';
  }
  const textFields = ['partNumber', 'supplier', 'line', ...(input.recordType === 'CAPA' ? ['effectivenessEvidenceUrl'] : [])];
  for (const field of textFields) {
    if (input[field] != null && typeof input[field] !== 'string') errors[field] = 'Enter text.';
    else if (input[field]?.length > 2000) errors[field] = 'Use 2,000 characters or fewer.';
  }
  const url = input.recordType === 'CAPA' ? input.effectivenessEvidenceUrl : '';
  if (typeof url === 'string' && url.trim()) {
    try {
      if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Invalid protocol');
    } catch {
      errors.effectivenessEvidenceUrl = 'Enter a full http:// or https:// link.';
    }
  }
  return errors;
}

export function buildCapture(input, now = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    recordType: input.recordType,
    ...normalise(input.partNumber),
    failureMode: input.failureMode,
    supplier: input.supplier ?? '',
    line: input.line ?? '',
    detectedDate: input.detectedDate || null,
    closedDate: input.recordType === 'CAPA' ? input.closedDate || null : null,
    effectivenessEvidenceUrl: input.recordType === 'CAPA' ? input.effectivenessEvidenceUrl || '' : '',
    updatedAt: now,
  };
}
