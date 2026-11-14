// Fixed presets only. Capture groups are base and revision; no user regex.
export const PART_PATTERN = /^(.+)-([A-Z]{1,2})$/;
export const DEFAULT_REVISION_PRESET = 'LETTERS';
export const REVISION_PRESETS = [
  { value: 'LETTERS', label: 'Trailing -1–2 letters (P-100-AA → P-100 / AA)' },
  { value: 'ALPHANUMERIC', label: 'Trailing -1–3 letters or digits (P-100-01 → P-100 / 01)' },
  { value: 'R_DIGITS', label: 'Trailing -R + digits (P-100-R12 → P-100 / R12)' },
  { value: 'NONE', label: 'No revision split (P-100-A stays P-100-A)' },
];
export const validRevisionPreset = (value) => REVISION_PRESETS.some((preset) => preset.value === value);
export function revisionPattern(preset) {
  if (!validRevisionPreset(preset)) throw new Error('Select a supported revision preset.');
  return { LETTERS: PART_PATTERN, ALPHANUMERIC: /^(.+)-([A-Z0-9]{1,3})$/, R_DIGITS: /^(.+)-(R\d+)$/, NONE: null }[preset];
}
