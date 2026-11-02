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

test('each capped signature class discloses omitted visible search matches', () => {
  const tree = nodes(EvidenceResults({ result: { applicable: true, strong: [], relatedRevision: [], otherRelated: [],
    notShown: { strong: 7, relatedRevision: 3 } } }));
  expect(tree).toContain('7 more not shown (most recent 25 displayed)');
  expect(tree).toContain('3 more not shown (most recent 25 displayed)');
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
