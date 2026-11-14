import { FAILURE_MODES } from '../config/failureModes';
import { normaliseText } from './normalise';

export const canonicalCode = (value) => typeof value === 'string' ? normaliseText(value) : '';
export const validModeCode = (code) => typeof code === 'string' && /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code);
export const sortFailureModes = (modes) => [...modes].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
export const seedCatalogue = () => ({ version: 0, modes: sortFailureModes(FAILURE_MODES).map((mode) => ({ ...mode })) });
export function validCatalogue(catalogue) {
  return Number.isSafeInteger(catalogue?.version) && catalogue.version >= 0 && Array.isArray(catalogue.modes)
    && catalogue.modes.length <= 50 && new Set(catalogue.modes.map((m) => m?.code)).size === catalogue.modes.length
    && catalogue.modes.every((m) => validModeCode(m?.code) && typeof m.label === 'string'
      && !!m.label.trim() && m.label.length <= 120 && typeof m.active === 'boolean');
}
export function failureModeLabel(code, modes = FAILURE_MODES) {
  const canonical = canonicalCode(code);
  if (!canonical) return code;
  if (modes === null) return canonical; // Lookup unavailable; absence has not been established.
  const mode = modes.find((m) => m.code === canonical);
  return mode ? `${mode.code} ${mode.label}${mode.active ? '' : ' (inactive)'}` : `${canonical} (not in catalogue)`;
}
export function modeOptions(modes = FAILURE_MODES, storedCode) {
  const stored = canonicalCode(storedCode);
  const options = modes.filter((m) => m.active || m.code === stored)
    .map((m) => ({ code: m.code, label: failureModeLabel(m.code, modes) }));
  if (stored && !options.some((m) => m.code === stored)) options.push({ code: stored, label: failureModeLabel(stored, modes) });
  return sortFailureModes(options).map(({ code, label }) => ({ value: code, label }));
}

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
  return { version: catalogue.version + 1, modes: sortFailureModes(modes) };
}
