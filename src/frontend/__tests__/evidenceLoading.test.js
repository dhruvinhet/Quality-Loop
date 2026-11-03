jest.mock('@forge/react', () => Object.fromEntries(['Box', 'Button', 'Heading', 'Link', 'SectionMessage', 'Stack', 'Text',
  'Label', 'Lozenge', 'Modal', 'ModalBody', 'ModalFooter', 'ModalHeader', 'ModalTitle', 'ModalTransition', 'Select', 'TextArea', 'Spinner'].map((name) => [name, name])));
jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }));
const React = require('react');
const { invoke } = require('@forge/bridge');
const MatchView = require('../MatchView').default;
const EvidenceResults = require('../EvidenceResults').default;
const { EvidenceCard } = require('../EvidenceResults');
const DecisionDetails = require('../DecisionDetails').default;
const nodes = (element) => element == null || typeof element === 'boolean' ? [] : Array.isArray(element) ? element.flatMap(nodes)
  : [element, ...(element.props ? nodes(element.props.children) : [])];
beforeEach(() => {
  jest.spyOn(React, 'useState').mockImplementation((initial) => [initial, jest.fn()]);
  jest.spyOn(React, 'useRef').mockImplementation((value) => ({ current: value }));
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });
test('MatchView uses one loadEvidence invocation and keeps hints separate', async () => {
  let cleanup;
  jest.spyOn(React, 'useEffect').mockImplementation((effect) => { cleanup = effect(); });
  invoke.mockResolvedValue({ applicable: true, strong: [], relatedRevision: [], otherRelated: [], pairs: {} });
  MatchView({});
  await Promise.resolve();
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(['loadEvidence', 'findHints']);
  cleanup();
});
test('incomplete searches show all cap/budget notices and avoid definitive no-match wording', () => {
  const tree = nodes(EvidenceResults({ result: { applicable: true, strong: [], relatedRevision: [], otherRelated: [],
    matchesIncomplete: true, otherRelatedIncomplete: true, incomplete: true } }));
  expect(tree).toContain('No exact signature match found in the completed checks.');
  expect(tree).not.toContain('No closed CAPA with this part and failure mode in the last 365 days');
  expect(tree.filter(({ type }) => type === 'SectionMessage')).toHaveLength(3);
});
test('current distinct-NC count and capped history are labelled explicitly', () => {
  const tree = nodes(DecisionDetails({ match: { id: '2' }, readOnly: true, data: {
    pairState: { version: 10, state: 'CONFIRMED' }, confirmedCount: 1, history: [], historyIncomplete: true,
  } }));
  expect(tree).toContain('NCs currently confirmed as recurrences of this CAPA: 1 (may take a few seconds to update)');
  expect(tree).toContain('Older decisions not shown');
});

test.each(['strong', 'relatedRevision'])('non-Done %s card shows the exact closure consistency warning', (classification) => {
  const match = { id: '2', key: 'QL-2', summary: 'CAPA', closedDate: '2026-10-21', status: 'Backlog', statusCategory: 'new',
    supportingFacts: [], failureMode: 'FM-01', rootCause: '', actionsTaken: '' };
  const tree = nodes(EvidenceCard({ match, classification }));
  expect(tree).toContain('Recorded closure date 2026-10-21, but the Jira status is Backlog (not Done). Check whether this CAPA was reopened.');
  expect(nodes(EvidenceCard({ match: { ...match, statusCategory: 'done' }, classification })).filter(({ type }) => type === 'SectionMessage')).toHaveLength(0);
  expect(nodes(EvidenceCard({ match, classification: 'otherRelated' })).filter(({ type }) => type === 'SectionMessage')).toHaveLength(0);
});

test('each capped signature class discloses unchecked candidates without claiming visibility or validity', () => {
  const tree = nodes(EvidenceResults({ result: { applicable: true, strong: [], relatedRevision: [], otherRelated: [],
    uncheckedCandidates: true, notShown: { strong: 7, relatedRevision: 3 } } }));
  expect(tree).toContain('7 more candidates not checked (most recent 25 verified matches shown).');
  expect(tree).toContain('3 more candidates not checked (most recent 25 verified matches shown).');
  expect(tree).not.toContain('No closed CAPA with this part and failure mode in the last 365 days');
});

test('unchecked candidates and omitted verified matches have separate lines per class', () => {
  const tree = nodes(EvidenceResults({ result: { applicable: true, strong: [], relatedRevision: [], otherRelated: [],
    uncheckedCandidates: true, notShown: { strong: 7, relatedRevision: 3 }, verifiedNotShown: { strong: 2, relatedRevision: 4 } } }));
  expect(tree).toContain('7 more candidates not checked (most recent 25 verified matches shown).');
  expect(tree).toContain('3 more candidates not checked (most recent 25 verified matches shown).');
  expect(tree).toContain('2 more verified matches not shown (most recent 25 shown)');
  expect(tree).toContain('4 more verified matches not shown (most recent 25 shown)');
  expect(tree).not.toContain('No closed CAPA with this part and failure mode in the last 365 days');
});

test('verified omissions alone also prevent definitive no-match text', () => {
  const tree = nodes(EvidenceResults({ result: { applicable: true, strong: [], relatedRevision: [], otherRelated: [],
    uncheckedCandidates: true, notShown: { strong: 0, relatedRevision: 0 }, verifiedNotShown: { strong: 0, relatedRevision: 1 } } }));
  expect(tree).toContain('1 more verified matches not shown (most recent 25 shown)');
  expect(tree).toContain('No exact signature match found in the completed checks.');
  expect(tree).not.toContain('No closed CAPA with this part and failure mode in the last 365 days');
  expect(tree.some((node) => typeof node === 'string' && node.includes('more candidates not checked'))).toBe(false);
});

test('unconfirmed follow-up offers a check and makes no write by merely displaying history', async () => {
  const tree = nodes(DecisionDetails({ match: { id: '2' }, readOnly: true, data: {
    pairState: { version: 1, state: 'CONCERN_RAISED' }, history: [{ id: 'decision', type: 'CONCERN', reason: 'Review',
      createdAt: '2026-10-21', authorDisplayName: 'Engineer', followupUnconfirmed: true }],
  } }));
  expect(tree).toContain('A follow-up was started but not confirmed.');
  const button = tree.find((node) => node.type === 'Button' && node.props.children === 'Check for task');
  expect(button).toBeDefined();
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValue({ message: 'No visible matching task' });
  await button.props.onClick();
  expect(invoke).toHaveBeenCalledWith('checkConcernTask', { capaId: '2', decisionId: 'decision' });
});

test.each(Array.from({ length: 8 }, (_, flags) => [!!(flags & 1), !!(flags & 2), !!(flags & 4)]))(
  'definitive no-match requires complete search=%s, loading=%s and candidates=%s', (matchesIncomplete, incomplete, uncheckedCandidates) => {
    const tree = nodes(EvidenceResults({ result: { applicable: true, strong: [], relatedRevision: [], otherRelated: [],
      matchesIncomplete, incomplete, uncheckedCandidates } }));
    const definitive = 'No closed CAPA with this part and failure mode in the last 365 days';
    const qualified = 'No exact signature match found in the completed checks.';
    expect(tree.includes(definitive)).toBe(!matchesIncomplete && !incomplete && !uncheckedCandidates);
    expect(tree.includes(qualified)).toBe(matchesIncomplete || incomplete || uncheckedCandidates);
  });

test('count/history budget exhaustion keeps decision buttons enabled through MatchView and shows count unavailable', () => {
  const data = { pairState: { version: 7, state: 'CONFIRMED' }, pairStateIncomplete: false,
    confirmedCountUnavailable: true, history: [], historyIncomplete: true, concernAllowed: true };
  const result = { applicable: true, strong: [{ id: '2' }], relatedRevision: [], otherRelated: [],
    pairs: { '2': data }, incomplete: true, decisionsIncomplete: true };
  jest.spyOn(React, 'useEffect').mockImplementation(() => {});
  React.useState.mockImplementation((initial) => [initial?.loading ? { result, pairs: result.pairs,
    decisionsError: 'Decision history and counts are incomplete. Refresh to try again.' } : initial, jest.fn()]);
  const view = nodes(MatchView({}));
  const evidence = view.find((node) => node.type === EvidenceResults);
  expect(evidence.props.decisionsReady).toBe(true);
  const card = nodes(EvidenceResults(evidence.props)).find((node) => node.type === EvidenceCard);
  const details = nodes(EvidenceCard({ ...card.props, match: { ...card.props.match, supportingFacts: [], rootCause: '', actionsTaken: '' } }))
    .find((node) => node.type === DecisionDetails);
  const tree = nodes(DecisionDetails(details.props));
  expect(tree).toContain('Count unavailable — refresh to try again');
  expect(tree).not.toContain('No decisions recorded.');
  const buttons = tree.filter((node) => node.type === 'Button');
  expect(buttons).toHaveLength(4);
  expect(buttons.every((node) => node.props.isDisabled === false)).toBe(true);
});

test.each([undefined, { pairStateIncomplete: true, history: [] },
  { pairState: { version: 7, state: 'CONFIRMED' }, pairStateIncomplete: true, history: [] }])(
  'missing or incomplete essential state disables decisions even when the view is ready (%j)', (data) => {
    const tree = nodes(DecisionDetails({ match: { id: '2' }, data, ready: true }));
    const buttons = tree.filter((node) => node.type === 'Button');
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    expect(buttons.every((node) => node.props.isDisabled)).toBe(true);
  });

test('a saved task with no link completion offers Verify link and requires a separate confirmation', async () => {
  const states = [];
  let cursor = 0;
  React.useState.mockImplementation((initial) => {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
  });
  const props = { match: { id: '2' }, readOnly: true, canRecover: true, onChanged: jest.fn(), data: {
    pairState: { version: 1, state: 'CONCERN_RAISED' }, history: [{ id: 'decision', type: 'CONCERN', reason: 'Review',
      createdAt: '2026-10-21', authorDisplayName: 'Engineer', taskKey: 'QL-3', taskLinked: false }],
  } };
  const render = () => { cursor = 0; return nodes(DecisionDetails(props)); };
  let tree = render();
  expect(invoke).not.toHaveBeenCalled();
  const confirmation = 'Check that QL-3 is linked to the CAPA; add a Relates link only if it is missing. CAPA: QL-2. Then record link completion.';
  invoke.mockResolvedValueOnce({ confirmation });
  await tree.find((node) => node.type === 'Button' && node.props.children === 'Verify link').props.onClick();
  expect(invoke.mock.calls).toEqual([['prepareRepairLink', { capaId: '2', decisionId: 'decision' }]]);
  tree = render();
  expect(tree).toContain('Confirm link verification');
  expect(tree).toContain(confirmation);
  expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValueOnce({ message: 'The follow-up link is verified and recorded.' });
  await tree.find((node) => node.type === 'Button' && node.props.children === 'Confirm verification').props.onClick();
  expect(invoke).toHaveBeenLastCalledWith('repairConcernLink', { capaId: '2', decisionId: 'decision', confirmation });
  expect(props.onChanged).toHaveBeenCalledTimes(1);
});

test.each([true, false])('completed link=%s controls Verify link visibility', (taskLinked) => {
  const tree = nodes(DecisionDetails({ match: { id: '2' }, readOnly: true, data: {
    pairState: { version: 1, state: 'CONCERN_RAISED' }, history: [{ id: 'decision', type: 'CONCERN', reason: 'Review',
      createdAt: '2026-10-21', authorDisplayName: 'Engineer', taskKey: 'QL-3', taskLinked }],
  } }));
  const repair = tree.find((node) => node.type === 'Button' && node.props.children === 'Verify link');
  expect(!!repair).toBe(!taskLinked);
  if (repair) expect(repair.props.isDisabled).toBe(true); // read-only side view
});

test('legacy history with a saved task key and no completion flag is labelled Verify link', () => {
  const tree = nodes(DecisionDetails({ match: { id: '2' }, readOnly: false, canRecover: true, data: {
    pairState: { version: 1, state: 'CONCERN_RAISED' }, history: [{ id: 'old-decision', type: 'CONCERN', reason: 'Review',
      createdAt: '2026-10-21', authorDisplayName: 'Engineer', taskKey: 'QT-3' }],
  } }));
  const labels = tree.filter((node) => node.type === 'Button').map((node) => node.props.children);
  expect(labels).toContain('Verify link');
  expect(labels).not.toContain('Repair link');
  expect(invoke).not.toHaveBeenCalled();
});
