jest.mock('@forge/react', () => Object.fromEntries(['Box', 'Button', 'Heading', 'Link', 'SectionMessage', 'Stack', 'Text',
  'Label', 'Lozenge', 'Modal', 'ModalBody', 'ModalFooter', 'ModalHeader', 'ModalTitle', 'ModalTransition', 'Select', 'TextArea', 'Spinner'].map((name) => [name, name])));
jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }));
const React = require('react');
const { invoke } = require('@forge/bridge');
const MatchView = require('../MatchView').default;
const EvidenceResults = require('../EvidenceResults').default;
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
