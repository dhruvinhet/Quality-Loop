jest.mock('@forge/react', () => Object.fromEntries(
  ['Box', 'Button', 'Link', 'Stack', 'Text'].map((name) => [name, name]),
));

const React = require('react');
const HintResults = require('../HintResults').default;
const result = { applicable: true, hints: [{ id: '2', key: 'QL-2', summary: 'DEMO CAPA with a spaced part number', partOriginal: 'SM-6604 -A',
  failureMode: ' fm-01 ', closedDate: '2026-10-01',
  reason: 'Part number differs slightly: stored "SM-6604 -A", this NC "SM-6604-A"' }] };
const nodes = (element) => {
  if (element == null || typeof element === 'boolean') return [];
  if (Array.isArray(element)) return element.flatMap(nodes);
  return [element, ...(element.props ? nodes(element.props.children) : [])];
};

afterEach(() => jest.restoreAllMocks());

test('hints start collapsed and a button expands/collapses the separate section', () => {
  const setExpanded = jest.fn();
  jest.spyOn(React, 'useState').mockReturnValue([false, setExpanded]);
  const tree = nodes(HintResults({ result }));
  expect(React.useState).toHaveBeenCalledWith(false);
  expect(tree).toContain('Not matched — check these');
  expect(tree.some(({ type }) => type === 'Link')).toBe(false);
  tree.find(({ type }) => type === 'Button').props.onClick();
  expect(setExpanded.mock.calls[0][0](false)).toBe(true);
  expect(setExpanded.mock.calls[0][0](true)).toBe(false);
});

test('expanded hints show the link, unchanged stored strings and one reason, with no decision controls', () => {
  jest.spyOn(React, 'useState').mockReturnValue([true, jest.fn()]);
  const tree = nodes(HintResults({ result }));
  expect(tree.find(({ type }) => type === 'Link').props.href).toBe('/browse/QL-2');
  expect(tree).toContain(' DEMO CAPA with a spaced part number');
  expect(tree).toContain('Part number (as stored): "SM-6604 -A"');
  expect(tree).toContain('Failure mode (as stored): " fm-01 "');
  expect(tree.filter((node) => node === result.hints[0].reason)).toHaveLength(1);
  expect(tree.filter(({ type }) => type === 'Button')).toHaveLength(1);
  expect(tree.filter((node) => typeof node.type === 'function')).toEqual([]);
});
