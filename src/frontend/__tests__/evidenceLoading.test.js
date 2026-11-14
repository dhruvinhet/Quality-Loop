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
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(['loadEvidence', 'findHints', 'getFailureModes']);
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
  expect(tree).toContain('NC currently confirmed as a recurrence of this CAPA: 1 (may take a few seconds to update)');
  expect(tree).toContain('Older decisions not shown');
});

const card = { id: '2', key: 'QL-2', partOriginal: 'T24-6604 -A', partNorm: 'T24-6604-A',
  failureMode: 'FM-01', rootCause: '', actionsTaken: '', supportingFacts: [], closedDate: '2026-10-01', statusCategory: 'done' };

test.each([
  [[{ code: 'FM-08', label: 'Wire fracture', active: false }], 'FM-08 Wire fracture (inactive)'],
  [[], 'FM-08 (not in catalogue)'],
  [null, 'FM-08'],
])('read-only details and cards use the same inactive/absent label', (failureModes, label) => {
  const ReadOnlyCapture = require('../ReadOnlyCapture').default;
  expect(nodes(ReadOnlyCapture({ record: { failureMode: 'FM-08' }, failureModes }))).toContain(`Failure mode: ${label}`);
  const tree = nodes(EvidenceCard({ match: { ...card, failureMode: 'FM-08' }, classification: 'strong', failureModes }));
  expect(tree.find((node) => typeof node === 'string' && node.startsWith('Exact signature:'))).toContain(`failure mode ${label}`);
});

test('cards retain the custom label and mark inactive modes', () => {
  for (const active of [true, false]) {
    const tree = nodes(EvidenceCard({ match: { ...card, failureMode: 'FM-08' }, classification: 'strong',
      failureModes: [{ code: 'FM-08', label: 'Wire fracture', active }] }));
    const signature = tree.find((node) => typeof node === 'string' && node.startsWith('Exact signature:'));
    expect(signature).toContain('failure mode FM-08');
    expect(signature).toContain('Wire fracture');
    expect(signature.includes('(inactive)')).toBe(!active);
  }
});

test('the NC panel does not render the always-on supplier migration banner', () => {
  const tree = nodes(EvidenceResults({ result: { applicable: true, strong: [], relatedRevision: [], otherRelated: [], supplierIndexLimited: true } }));
  expect(tree).not.toContain('Supplier-based related searches cover only CAPAs saved with normalised supplier details. Older records may be missed until re-saved.');
});

test.each(['strong', 'relatedRevision'])('%s card explains the normalised part while preserving the original', (classification) => {
  const tree = nodes(EvidenceCard({ match: { ...card, partRevision: 'A' }, classification }));
  expect(tree.some((node) => typeof node === 'string' && node.includes('part T24-6604 -A (matched as T24-6604-A);'))).toBe(true);
  expect(card.partOriginal).toBe('T24-6604 -A');
  if (classification === 'relatedRevision') expect(tree.some((node) => typeof node === 'string' && node.startsWith('Exact signature'))).toBe(false);
});

test.each([
  ['strong', 'T24-6604-A', 'T24-6604-A'],
  ['relatedRevision', 'T24-6604-A', 'T24-6604-A'],
  ['otherRelated', 'T24-6604 -A', 'T24-6604-A'],
])('%s card omits matched-as when parts are clean or the record is only other-related', (classification, partOriginal, partNorm) => {
  const tree = nodes(EvidenceCard({ match: { ...card, partOriginal, partNorm }, classification }));
  expect(tree.some((node) => typeof node === 'string' && node.includes('(matched as'))).toBe(false);
});

test.each(['strong', 'relatedRevision', 'otherRelated'])('%s cards use day/days correctly', (classification) => {
  for (const daysSinceClosure of [0, 1, 2, 365]) {
    const tree = nodes(EvidenceCard({ match: { ...card, daysSinceClosure }, classification }));
    expect(tree).toContain(`QualityLoop closure date: 2026-10-01 · ${daysSinceClosure} ${daysSinceClosure === 1 ? 'day' : 'days'} after closure`);
  }
});

test.each(['strong', 'relatedRevision'])('%s candidate and omitted-match notices use singular and plural', (kind) => {
  for (const count of [1, 2]) {
    const tree = nodes(EvidenceResults({ result: { applicable: true, strong: [], relatedRevision: [], otherRelated: [],
      notShown: { [kind]: count }, verifiedNotShown: { [kind]: count } } }));
    expect(tree).toContain(`${count} more ${count === 1 ? 'candidate' : 'candidates'} not checked (most recent 25 verified matches shown).`);
    expect(tree).toContain(`${count} more verified ${count === 1 ? 'match' : 'matches'} not shown (most recent 25 shown)`);
  }
});

test.each([0, 1, 2])('other-related labels agree with their count: %i', (count) => {
  for (const readOnly of [true, false]) {
    const tree = nodes(EvidenceResults({ readOnly, result: { applicable: true, strong: [], relatedRevision: [],
      otherRelated: Array.from({ length: count }, (_, id) => ({ ...card, id })) } }));
    expect(tree).toContain(`Other related ${count === 1 ? 'record' : 'records'} (${count})`);
  }
});

test.each([[0, false], [1, false], [2, false], [1, true], ['50+', true]])(
  'confirmed-NC count handles exact and incomplete counts: %s, incomplete=%s', (confirmedCount, confirmedCountIncomplete) => {
    const tree = nodes(DecisionDetails({ match: { id: '2' }, readOnly: true, data: {
      confirmedCount, confirmedCountIncomplete, history: [] } }));
    const singular = confirmedCount === 1 && !confirmedCountIncomplete;
    expect(tree.some((node) => typeof node === 'string' && node.startsWith(singular
      ? 'NC currently confirmed as a recurrence of this CAPA: 1 '
      : `NCs currently confirmed as recurrences of this CAPA: ${confirmedCount}`))).toBe(true);
  },
);

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
  expect(tree).toContain('1 more verified match not shown (most recent 25 shown)');
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
  const { repairLinkConfirmation } = require('../../lib/followup');
  const confirmation = repairLinkConfirmation('QL-3', 'QL-2', { ncKey: 'QL-1', description: 'Decision: Effectiveness concern\nEngineer reason: Review.' });
  invoke.mockResolvedValueOnce({ confirmation });
  await tree.find((node) => node.type === 'Button' && node.props.children === 'Verify link').props.onClick();
  expect(invoke.mock.calls).toEqual([['prepareRepairLink', { capaId: '2', decisionId: 'decision' }]]);
  tree = render();
  expect(tree).toContain('Confirm link verification');
  const body = tree.find((node) => node.type === 'ModalBody');
  const displayedLines = nodes(body).filter((node) => node.type === 'Text').map((node) => node.props.children);
  expect(displayedLines.join('\n')).toBe(confirmation);
  expect(displayedLines.every((line) => !line.includes('\n') && !line.includes('ADF'))).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValueOnce({ message: 'The follow-up link is verified and recorded.' });
  await tree.find((node) => node.type === 'Button' && node.props.children === 'Confirm verification').props.onClick();
  expect(invoke).toHaveBeenLastCalledWith('repairConcernLink', { capaId: '2', decisionId: 'decision', confirmation });
  expect(props.onChanged).toHaveBeenCalledTimes(1);
});

test('follow-up dialog renders each canonical line separately and submits exactly those joined lines', async () => {
  const { followupConfirmation } = require('../../lib/decisions');
  const confirmation = followupConfirmation('QL', 'QL-2', { accountId: 'private-id', displayName: 'Engineer' }, {
    ncKey: 'QL-1', typeName: 'Task', description: 'Decision: Effectiveness concern\nEngineer reason: Review.\nOpen the QualityLoop panel on QL-1 to see the full history.',
  });
  const states = [null, 0, false, '', '', { decisionId: 'decision', confirmation }];
  let cursor = 0;
  React.useState.mockImplementation((initial) => {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], (value) => { states[index] = value; }];
  });
  const onChanged = jest.fn();
  const tree = nodes(DecisionDetails({ match: { id: '2' }, onChanged }));
  const body = tree.find((node) => node.type === 'ModalBody');
  const displayedLines = nodes(body).filter((node) => node.type === 'Text').map((node) => node.props.children);
  expect(displayedLines.shift()).toBe('The concern is recorded. Confirm these Jira writes:');
  expect(displayedLines.join('\n')).toBe(confirmation);
  expect(displayedLines.every((line) => !line.includes('\n') && !line.includes('ADF'))).toBe(true);
  expect(displayedLines.join('\n')).not.toMatch(/private-id|history\.\./);
  invoke.mockResolvedValueOnce({ message: 'Recorded.' });
  await tree.find((node) => node.type === 'Button' && node.props.children === 'Create follow-up').props.onClick();
  expect(invoke).toHaveBeenCalledWith('createConcernTask', { capaId: '2', decisionId: 'decision', confirmation: displayedLines.join('\n') });
  expect(onChanged).toHaveBeenCalledTimes(1);
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
