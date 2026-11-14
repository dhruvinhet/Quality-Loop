jest.mock('@forge/react', () => Object.fromEntries(
  ['Box', 'Button', 'Link', 'SectionMessage', 'Stack', 'Text'].map((name) => [name, name]),
));

const React = require('react');
const HintResults = require('../HintResults').default;
const result = { applicable: true, hints: [{ id: '2', key: 'QL-2', summary: 'DEMO CAPA with a transposed part number', partOriginal: 'SM-6640 -A',
  failureMode: ' fm-01 ', closedDate: '2026-10-01',
  reason: 'Part number differs slightly: stored "SM-6640 -A", this NC "SM-6604-A"' }] };
const nodes = (element) => {
  if (element == null || typeof element === 'boolean') return [];
  if (Array.isArray(element)) return element.flatMap(nodes);
  return [element, ...(element.props ? nodes(element.props.children) : [])];
};

beforeEach(() => {
  jest.spyOn(React, 'useState').mockImplementation((initial) => [initial, jest.fn()]);
  jest.spyOn(React, 'useEffect').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('hint copy names the configured look-back window', () => {
  const tree = nodes(HintResults({ result: { ...result, search: { scope: 'PROJECT', lookbackDays: 730 } } }));
  expect(tree.some((node) => typeof node === 'string' && node.includes('near-identical part numbers within 730 days') && node.includes('outside the 730-day window'))).toBe(true);
});

test.each([
  [[{ code: 'FM-08', label: 'Wire fracture', active: false }], 'FM-08 Wire fracture (inactive)'],
  [[], 'FM-08 (not in catalogue)'],
])('hints preserve inactive labels and distinguish missing catalogue entries', (failureModes, label) => {
  const tree = nodes(HintResults({ result: { ...result, hints: [{ ...result.hints[0], failureMode: 'FM-08' }] }, failureModes }));
  expect(tree).toContain(`Failure mode: ${label}`);
});

test('nonempty hints start expanded and a button can collapse the separate section', () => {
  const setExpanded = jest.fn();
  React.useState.mockReturnValue([true, setExpanded]);
  const tree = nodes(HintResults({ result }));
  expect(React.useState).toHaveBeenCalledWith(true);
  expect(tree).toContain('Not matched — check these');
  expect(tree.some(({ type }) => type === 'Link')).toBe(true);
  tree.find(({ type }) => type === 'Button').props.onClick();
  expect(setExpanded.mock.calls[0][0](false)).toBe(true);
  expect(setExpanded.mock.calls[0][0](true)).toBe(false);
});

test('expanded hints show the link, unchanged stored strings and one reason, with no decision controls', () => {
  jest.spyOn(React, 'useState').mockReturnValue([true, jest.fn()]);
  const tree = nodes(HintResults({ result }));
  expect(tree.find(({ type }) => type === 'Link').props.href).toBe('/browse/QL-2');
  expect(tree).toContain(' DEMO CAPA with a transposed part number');
  expect(tree).toContain('Part number (as stored): "SM-6640 -A"');
  expect(tree).toContain('Failure mode (as stored): " fm-01 "');
  expect(tree.filter((node) => node === result.hints[0].reason)).toHaveLength(1);
  expect(tree.filter(({ type }) => type === 'Button')).toHaveLength(1);
  expect(tree.filter((node) => typeof node.type === 'function')).toEqual([]);
});

test('expanded truncated hint search shows the cap notice and cautious manual-review wording', () => {
  jest.spyOn(React, 'useState').mockReturnValue([true, jest.fn()]);
  const tree = nodes(HintResults({ result: { ...result, incomplete: true, truncated: true } }));
  expect(tree).toContain('The hint searches check at most 50 candidates each; more may exist.');
  expect(tree).toContain('Up to 3 hints, from limited searches (at most 50 candidates each): near-identical part numbers within 365 days, same part with no closed date, and older precedents outside the 365-day window. These are not matches.');
  expect(tree).toContain('These records do not meet the matching rules, but may still be worth a manual review. Only records you can browse are shown.');
  expect(tree.find(({ type }) => type === 'SectionMessage').props.appearance).toBe('information');
  expect(tree.some((node) => typeof node === 'string' && node.includes('recently closed'))).toBe(false);
  expect(tree.some((node) => typeof node === 'string' && node.includes('They are not possible recurrences.'))).toBe(false);
  expect(tree.some((node) => typeof node === 'string' && node.includes('hint time budget was reached'))).toBe(false);
});

test('hint time budget and search truncation have distinct notices when both apply', () => {
  jest.spyOn(React, 'useState').mockReturnValue([true, jest.fn()]);
  const tree = nodes(HintResults({ result: { ...result, incomplete: true, budgetExceeded: true, truncated: true } }));
  expect(tree).toContain('The hint searches check at most 50 candidates each; more may exist.');
  expect(tree).toContain('The hint time budget was reached. Only completed checks are shown; more hints may exist.');
});

test.each([undefined, { applicable: false }, { applicable: true, hints: [] }])('zero hints hide the hint section: %j', (empty) => {
  expect(HintResults({ result: empty })).toBeNull();
});

test('errors and incomplete-search notices stay visible even without hints', () => {
  const tree = nodes(HintResults({ result: { applicable: true, hints: [], error: 'Could not load hints.', truncated: true, budgetExceeded: true } }));
  expect(tree).toContain('Could not load hints.');
  expect(tree).toContain('The hint searches check at most 50 candidates each; more may exist.');
  expect(tree).toContain('The hint time budget was reached. Only completed checks are shown; more hints may exist.');
  expect(tree.find(({ type }) => type === 'SectionMessage').props.appearance).toBe('error');
  expect(tree.some(({ type }) => type === 'Button')).toBe(false);
});

test('collapsed hints keep the informational not-a-match disclaimer prominent', () => {
  React.useState.mockReturnValue([false, jest.fn()]);
  const tree = nodes(HintResults({ result }));
  expect(tree.some(({ type }) => type === 'Link')).toBe(false);
  expect(tree.find(({ type }) => type === 'SectionMessage').props.appearance).toBe('information');
  expect(tree.some((node) => typeof node === 'string' && node.includes('These are not matches.'))).toBe(true);
});

test('hints arriving after load expand; a manual collapse survives a nonempty refresh', () => {
  let expanded, previousPresence;
  React.useState.mockImplementation((initial) => {
    if (expanded === undefined) expanded = initial;
    return [expanded, (value) => { expanded = typeof value === 'function' ? value(expanded) : value; }];
  });
  React.useEffect.mockImplementation((effect, [presence]) => {
    if (previousPresence !== presence) { previousPresence = presence; effect(); }
  });
  const render = (next) => { HintResults({ result: next }); return nodes(HintResults({ result: next })); };
  expect(render({ applicable: true, hints: [] })).toEqual([]);
  let tree = render(result);
  expect(tree.some(({ type }) => type === 'Link')).toBe(true);
  tree.find(({ type }) => type === 'Button').props.onClick();
  tree = render({ ...result, hints: [...result.hints] });
  expect(tree.some(({ type }) => type === 'Link')).toBe(false);
  expect(render({ applicable: true, hints: [] })).toEqual([]);
  expect(render(result).some(({ type }) => type === 'Link')).toBe(true);
});
