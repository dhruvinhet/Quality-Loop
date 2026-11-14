jest.mock('@forge/react', () => ({ __esModule: true, default: { render: jest.fn() },
  ...Object.fromEntries(['Button', 'Heading', 'Stack', 'Text', 'Modal', 'ModalBody', 'ModalHeader', 'ModalTitle', 'ModalFooter', 'ModalTransition'].map((name) => [name, name])) }));
jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }));
jest.mock('../GettingStarted', () => ({ __esModule: true, default: 'GettingStarted' }));
const React = require('react');
const { invoke } = require('@forge/bridge');
const { DataPage } = require('../adminPage');
const nodes = (element) => element == null || typeof element === 'boolean' ? [] : Array.isArray(element) ? element.flatMap(nodes)
  : [element, ...(element.props ? nodes(element.props.children) : [])];
let states, cursor;
const render = () => { cursor = 0; return nodes(DataPage()); };
const click = (tree, label) => tree.find((node) => node.type === 'Button' && node.props.children === label).props.onClick();
beforeEach(() => {
  states = []; cursor = 0; jest.clearAllMocks();
  jest.spyOn(React, 'useState').mockImplementation((initial) => {
    const i = cursor++;
    if (!(i in states)) states[i] = initial;
    return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
  });
});
afterEach(() => jest.restoreAllMocks());

test('supplier migration guidance appears under App data maintenance', () => {
  const tree = render();
  const note = 'Supplier-based searches may miss older CAPAs until their quality details are re-saved.';
  expect(tree).toContain(note);
  expect(tree.indexOf(note)).toBeGreaterThan(tree.indexOf('App data maintenance'));
});

test('orphan check shows count, cancellation writes nothing, and removal requires the count dialog', async () => {
  invoke.mockResolvedValueOnce({ token: 'ticket' }).mockResolvedValueOnce({ scanned: 5, found: 3, unknown: 1, scanComplete: true, removed: 0 });
  await click(render(), 'Check for orphaned records');
  let tree = render();
  expect(tree).toContain('3 orphaned records found (issues deleted)');
  expect(tree).toContain('Trashed projects keep their QualityLoop data. Missing-issue records are not counted as orphaned if any project is in trash or the trash check is unavailable.');
  expect(tree).toContain('Permission denials and errors are not treated as deleted. Run another check to retry unresolved records.');
  await click(tree, 'Remove orphaned records');
  tree = render();
  expect(tree).toContain('Confirm orphaned record removal');
  expect(tree.some((node) => typeof node === 'string' && node.includes('Remove up to 3 orphaned app records?'))).toBe(true);
  expect(tree.some((node) => typeof node === 'string' && node.includes('projects in trash can be ruled out'))).toBe(true);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(['startDataHealthCheck', 'checkOrphanPage']);
  await click(tree, 'Cancel');
  expect(invoke).toHaveBeenCalledTimes(2);
  await click(render(), 'Remove orphaned records');
  invoke.mockResolvedValueOnce({ scanned: 5, found: 3, unknown: 1, scanComplete: true, removed: 2, retained: 1, removeComplete: true });
  await click(render(), 'Confirm removal');
  expect(invoke).toHaveBeenLastCalledWith('removeOrphanPage', { token: 'ticket', expectedCount: 3, confirmed: true });
  expect(render()).toContain('Removed 2 orphaned records. 1 record retained after re-check.');
});

test('a budget pause offers resume using the same server ticket', async () => {
  invoke.mockResolvedValueOnce({ token: 'ticket' }).mockResolvedValueOnce({ scanned: 2, found: 1, unknown: 0, scanComplete: false, paused: true });
  await click(render(), 'Check for orphaned records');
  invoke.mockResolvedValueOnce({ scanned: 4, found: 2, unknown: 0, scanComplete: true });
  await click(render(), 'Resume orphan check');
  expect(invoke.mock.calls).toEqual([
    ['startDataHealthCheck', {}], ['checkOrphanPage', { token: 'ticket' }], ['checkOrphanPage', { token: 'ticket' }],
  ]);
  expect(render()).toContain('2 orphaned records found (issues deleted)');
});

test('one orphan has singular count, confirmation and removal wording', async () => {
  invoke.mockResolvedValueOnce({ token: 'ticket' }).mockResolvedValueOnce({ scanned: 1, found: 1, unknown: 1, scanComplete: true });
  await click(render(), 'Check for orphaned records');
  expect(render()).toContain('1 orphaned record found (issues deleted)');
  expect(render()).toContain('Record checked: 1. Record with unresolved checks: 1.');
  await click(render(), 'Remove orphaned records');
  expect(render().some((node) => typeof node === 'string' && node.includes('Remove up to 1 orphaned app record?'))).toBe(true);
  invoke.mockResolvedValueOnce({ found: 1, removed: 1, retained: 0, removeComplete: true });
  await click(render(), 'Confirm removal');
  expect(render()).toContain('Removed 1 orphaned record. 0 records retained after re-check.');
  expect(render()).toContain('Orphaned record removed: 1.');
});


test('accessible scan previews every part-index write and requires confirmation; cancellation makes no Jira writes', async () => {
  const lines = ['Update QL-1 qualityloop part indexes.', 'Update QL-2 qualityloop part indexes.'];
  invoke.mockImplementation(async (name) => ({
    startOrphanScan: { token: 'legacy-scan' },
    findOrphanPage: { scanned: 0, backfilled: 0, backfillPending: 0 },
    scanPartIndexes: { token: 'parts-plan', lines, nextCursor: 'next' },
    repairPartIndexes: { updated: 2, skipped: 0 },
  }[name]));
  await click(render(), 'Scan accessible app records');
  expect(invoke.mock.calls.some(([name]) => name === 'repairPartIndexes')).toBe(false);
  await click(render(), 'Review part-index updates');
  let tree = render();
  for (const line of lines) expect(tree).toContain(line);
  expect(tree.find((node) => node.type === 'Button' && node.props.children === 'Scan next part-index page').props.isDisabled).toBe(true);
  await click(tree, 'Cancel');
  expect(invoke.mock.calls.some(([name]) => name === 'repairPartIndexes')).toBe(false);
  await click(render(), 'Review part-index updates');
  await click(render(), 'Confirm part-index updates');
  expect(invoke).toHaveBeenLastCalledWith('repairPartIndexes', { token: 'parts-plan', confirmation: lines.join('\n') });
  tree = render();
  expect(tree).toContain('Part indexes updated: 2. Updates skipped: 0. Scan again to retry skipped or interrupted updates.');
  expect(tree.find((node) => node.type === 'Button' && node.props.children === 'Scan next part-index page').props.isDisabled).toBe(false);
  await click(tree, 'Scan next part-index page');
  expect(invoke).toHaveBeenLastCalledWith('scanPartIndexes', { cursor: 'next' });
});
