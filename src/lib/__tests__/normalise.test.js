import { normalise } from '../normalise';

test('normalises " p-4471 -a " conservatively without removing the space before the hyphen', () => {
  expect(normalise(' p-4471 -a ')).toEqual({
    partOriginal: ' p-4471 -a ', partNorm: 'P-4471 -A', partBase: 'P-4471 ', partRevision: 'A',
  });
});

test('extracts a single-letter revision after normalising', () => {
  expect(normalise('p-4471-b')).toEqual({
    partOriginal: 'p-4471-b', partNorm: 'P-4471-B', partBase: 'P-4471', partRevision: 'B',
  });
});

test.each(['P-4471', 'P-4471-AA', 'P-4471-2', 'P4471', ''])('no revision match: %s', (part) => {
  expect(normalise(part)).toMatchObject({ partBase: part, partRevision: null });
});

test('collapses inner whitespace and leaves partOriginal untouched', () => {
  const part = ' \tp  4471\n-a  ';
  expect(normalise(part).partOriginal).toBe(part);
  expect(normalise(part).partNorm).toBe('P 4471 -A');
  expect(part).toBe(' \tp  4471\n-a  ');
});

test('supports a configurable pattern without mutating its lastIndex', () => {
  const pattern = /^(.+)\/REV(\d+)$/g;
  pattern.lastIndex = 3;
  expect(normalise('p4471/rev02', pattern)).toMatchObject({ partBase: 'P4471', partRevision: '02' });
  expect(normalise('p4471/rev02', pattern)).toMatchObject({ partBase: 'P4471', partRevision: '02' });
  expect(pattern.lastIndex).toBe(3);
});

test('does not silently coerce a non-string part number', () => {
  expect(() => normalise(4471)).toThrow(TypeError);
});
