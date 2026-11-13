import { FAILURE_MODES } from '../config/failureModes';
import { normaliseText } from './normalise';

export const canonicalCode = (value) => typeof value === 'string' ? normaliseText(value) : '';
export const validModeCode = (code) => typeof code === 'string' && /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code);
export const seedCatalogue = () => ({ version: 0, modes: FAILURE_MODES.map((mode) => ({ ...mode })) });
export function validCatalogue(catalogue) {
  return Number.isSafeInteger(catalogue?.version) && catalogue.version >= 0 && Array.isArray(catalogue.modes)
    && catalogue.modes.length <= 50 && new Set(catalogue.modes.map((m) => m?.code)).size === catalogue.modes.length
    && catalogue.modes.every((m) => validModeCode(m?.code) && typeof m.label === 'string'
      && !!m.label.trim() && m.label.length <= 120 && typeof m.active === 'boolean');
}
export function failureModeLabel(code, modes = FAILURE_MODES) {
  const mode = modes.find((m) => m.code === canonicalCode(code) && m.active);
  return mode ? `${mode.code} ${mode.label}` : code;
}
export const modeOptions = (modes = FAILURE_MODES) => modes.filter((m) => m.active)
  .map((m) => ({ value: m.code, label: `${m.code} ${m.label}` }));

export function changeCatalogue(catalogue, { action, code: rawCode, label }) {
  const code = canonicalCode(rawCode);
  if (!validModeCode(code)) throw new Error('Use a code of 1–32 letters, digits, underscores or hyphens, starting with a letter or digit.');
  const modes = catalogue.modes.map((mode) => ({ ...mode }));
  const existing = modes.find((mode) => mode.code === code);
  if (!['add', 'rename', 'deactivate', 'activate'].includes(action)) throw new Error('Choose add, rename, deactivate or activate. Codes cannot be deleted.');
  if (['add', 'rename'].includes(action) && (typeof label !== 'string' || !label.trim() || label.length > 120)) {
    throw new Error('Enter a label of 1–120 characters.');
  }
  if (action === 'add') {
    if (existing) throw new Error('That code already exists, including inactive codes. Rename or activate it instead.');
    if (modes.length >= 50) throw new Error('The catalogue is limited to 50 codes, including inactive codes.');
    modes.push({ code, label: label.trim(), active: true });
  } else {
    if (!existing) throw new Error('That code is not in the catalogue. Refresh the list.');
    if (action === 'rename') existing.label = label.trim();
    else existing.active = action === 'activate';
  }
  return { version: catalogue.version + 1, modes };
}
