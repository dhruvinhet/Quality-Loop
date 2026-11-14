import { DEFAULT_REVISION_PRESET, revisionPattern } from '../config/partPattern';

export function normaliseText(value) {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function normalise(partOriginal, preset = DEFAULT_REVISION_PRESET) {
  if (typeof partOriginal !== 'string') {
    throw new TypeError('Part number must be text.');
  }
  // Named part-number rule: spaces around hyphens are removed. No fuzzy matching.
  const partNorm = normaliseText(partOriginal).replace(/\s*-\s*/g, '-');
  const match = revisionPattern(preset)?.exec(partNorm);
  return {
    partOriginal,
    partNorm,
    partBase: match ? match[1] : partNorm,
    partRevision: match ? match[2] : null,
  };
}

export function partPreview(original, preset = DEFAULT_REVISION_PRESET) {
  const part = normalise(original, preset);
  return part.partRevision === null ? `Base: ${part.partBase || '—'} · No revision`
    : `Base: ${part.partBase} · Revision: ${part.partRevision}`;
}
