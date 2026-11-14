import { normalise, normaliseText } from '../normalise';

test('normalises " p-4471 -a " with the spaces around hyphens rule and preserves original', () => {
  expect(normalise(' p-4471 -a ')).toEqual({
    partOriginal: ' p-4471 -a ', partNorm: 'P-4471-A', partBase: 'P-4471', partRevision: 'A',
  });
});

test.each(['SM-6604 -A', 'SM-6604- A', ' SM-6604 - A ', 'SM-6604-A', ' sm \t- 6604\n- a '])(
  'spaces around hyphens are removed: %j', (partOriginal) => {
    expect(normalise(partOriginal)).toEqual({
      partOriginal, partNorm: 'SM-6604-A', partBase: 'SM-6604', partRevision: 'A',
    });
    const once = normalise(partOriginal).partNorm;
    expect(normalise(once).partNorm).toBe(once);
  },
);

test('hyphen formatting rule applies only to parts, without fuzzy edits or hyphen removal', () => {
  expect(normaliseText(' fm - 01 ')).toBe('FM - 01');
  expect(normalise('SM6604-A').partNorm).not.toBe(normalise('SM-6604-A').partNorm);
  expect(normalise('SM-6640-A').partNorm).not.toBe(normalise('SM-6604-A').partNorm);
});

test.each(['b', 'aa'])('extracts a one- or two-letter revision after normalising: %s', (revision) => {
  const partOriginal = ` p-100-${revision} `;
  expect(normalise(partOriginal)).toEqual({
    partOriginal, partNorm: `P-100-${revision.toUpperCase()}`, partBase: 'P-100', partRevision: revision.toUpperCase(),
  });
});

test.each(['P-4471', 'P-4471-AAA', 'P-4471-2', 'P-4471-A2', 'P4471', ''])('no revision match: %s', (part) => {
  expect(normalise(part)).toMatchObject({ partBase: part, partRevision: null });
});

test('collapses inner whitespace and leaves partOriginal untouched', () => {
  const part = ' \tp  4471\n-a  ';
  expect(normalise(part).partOriginal).toBe(part);
  expect(normalise(part).partNorm).toBe('P 4471-A');
  expect(part).toBe(' \tp  4471\n-a  ');
});

test.each([/^(.+)\/REV(\d+)$/g, 'custom', '', null, { source: '^(.+)-(.*)$' }])('rejects free regex/unknown preset %j', (preset) => {
  expect(() => normalise('P-100-A', preset)).toThrow('Select a supported revision preset.');
});

test.each([
  ['LETTERS', 'P-100-AA', 'P-100', 'AA'],
  ['LETTERS', 'P-100-01', 'P-100-01', null],
  ['ALPHANUMERIC', 'P-100-01', 'P-100', '01'],
  ['ALPHANUMERIC', 'P-100-A2B', 'P-100', 'A2B'],
  ['ALPHANUMERIC', 'P-100-ABCD', 'P-100-ABCD', null],
  ['R_DIGITS', 'p-100-r1234', 'P-100', 'R1234'],
  ['R_DIGITS', 'P-100-12', 'P-100-12', null],
  ['NONE', 'P-100-A', 'P-100-A', null],
])('%s splits %s deterministically', (preset, original, partBase, partRevision) => {
  expect(normalise(original, preset)).toMatchObject({ partBase, partRevision });
  expect(normalise(original, preset).partNorm).toBe(normalise(original).partNorm);
});

test('does not silently coerce a non-string part number', () => {
  expect(() => normalise(4471)).toThrow(TypeError);
});
