// Capture group 1 is the base; capture group 2 is the revision.
// Applied to partNorm exactly: do not silently remove punctuation or spaces.
export const PART_PATTERN = /^(.+)-([A-Z]{1,2})$/;
