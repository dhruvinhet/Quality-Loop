import { PART_PATTERN } from '../config/partPattern';

export function normaliseText(value) {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function normalise(partOriginal, pattern = PART_PATTERN) {
  if (typeof partOriginal !== 'string') {
    throw new TypeError('Part number must be text.');
  }
  // Named part-number rule: spaces around hyphens are removed. No fuzzy matching.
  const partNorm = normaliseText(partOriginal).replace(/\s*-\s*/g, '-');
  // A fresh regex keeps configurable global/sticky patterns deterministic.
  const match = new RegExp(pattern.source, pattern.flags).exec(partNorm);
  return {
    partOriginal,
    partNorm,
    partBase: match ? match[1] : partNorm,
    partRevision: match ? match[2] : null,
  };
}
