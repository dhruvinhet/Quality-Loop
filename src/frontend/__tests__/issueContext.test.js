jest.mock('@forge/react', () => ({
  __esModule: true,
  default: { render: jest.fn() },
  ...Object.fromEntries(['Button', 'SectionMessage', 'Stack', 'Text'].map((name) => [name, name])),
}));
jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }));
jest.mock('../MatchView', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../DecisionDetails', () => ({ __esModule: true, default: jest.fn() }));

const React = require('react');
const { invoke } = require('@forge/bridge');
const { IssueContext } = require('../issueContext');
const MatchView = require('../MatchView').default;
const EvidenceResults = require('../EvidenceResults').default;
const nodes = (element) => {
  if (element == null || typeof element === 'boolean') return [];
  if (Array.isArray(element)) return element.flatMap(nodes);
  return [element, ...(element.props ? nodes(element.props.children) : [])];
};

afterEach(() => jest.restoreAllMocks());

test.each([true, false, null])('side-view guidance uses the actual edit access (%s) and stays read-only', (canEdit) => {
  jest.spyOn(React, 'useState').mockReturnValue([canEdit === null ? null : { canEdit }, jest.fn()]);
  jest.spyOn(React, 'useEffect').mockImplementation(() => {});
  const tree = nodes(IssueContext());
  const text = tree.filter((node) => typeof node === 'string').join(' ');
  expect(text.includes('Edit Issues permission')).toBe(canEdit === false);
  expect(text.includes('This side view is read-only. To update details or record a decision, open QualityLoop from the apps icon under the issue title.'))
    .toBe(canEdit === true);
  expect(tree.find(({ type }) => type === MatchView).props).toMatchObject({ readOnly: true, canEdit });
});

test.each([{ canEdit: true }, { canEdit: false }, null, { error: 'Unavailable' }])('side view loads access from the existing resolver: %j', async (result) => {
  const setAccess = jest.fn();
  jest.spyOn(React, 'useState').mockReturnValue([null, setAccess]);
  jest.spyOn(React, 'useEffect').mockImplementation((effect) => { effect(); });
  invoke.mockResolvedValue(result);
  IssueContext();
  await Promise.resolve();
  expect(invoke).toHaveBeenLastCalledWith('getPanelAccess');
  expect(setAccess).toHaveBeenCalledWith(typeof result?.canEdit === 'boolean' ? result : { error: true });
});

test.each([true, false, null])('read-only evidence copy mentions Edit Issues only for a known non-editor (%s)', (canEdit) => {
  jest.spyOn(React, 'useState').mockReturnValue([false, jest.fn()]);
  for (const result of [{ applicable: false }, { applicable: true, strong: [], relatedRevision: [], otherRelated: [] }]) {
    const tree = nodes(EvidenceResults({ result, readOnly: true, canEdit }));
    const text = tree.filter((node) => typeof node === 'string').join(' ');
    expect(text.includes('Edit Issues permission')).toBe(canEdit === false);
  }
});
