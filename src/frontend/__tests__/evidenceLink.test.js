jest.mock('@forge/react', () => Object.fromEntries(['Box', 'Button', 'Heading', 'Link', 'SectionMessage', 'Stack', 'Text',
  'Label', 'Lozenge', 'Modal', 'ModalBody', 'ModalFooter', 'ModalHeader', 'ModalTitle', 'ModalTransition', 'Select', 'TextArea']
  .map((name) => [name, name])));
jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }));

const React = require('react');
const EvidenceLink = require('../EvidenceLink').default;
const { EvidenceCard } = require('../EvidenceResults');
const ReadOnlyCapture = require('../ReadOnlyCapture').default;
const DecisionDetails = require('../DecisionDetails').default;
// Expand the real shared renderer as well as each parent surface. Other custom
// components remain opaque, as in the repository's existing UI Kit tests.
const nodes = (element) => {
  if (element == null || typeof element === 'boolean') return [];
  if (Array.isArray(element)) return element.flatMap(nodes);
  if (element.type === EvidenceLink) return nodes(EvidenceLink(element.props));
  return [element, ...(element.props ? nodes(element.props.children) : [])];
};
const match = { id: '2', key: 'QL-2', summary: 'CAPA', partOriginal: 'SM-6604 -A', failureMode: 'FM-01',
  closedDate: '2026-10-01', daysSinceClosure: 30, status: 'Done', statusCategory: 'done',
  rootCause: '', actionsTaken: '', supportingFacts: [] };
const surfaces = {
  card: (url) => EvidenceCard({ match: { ...match, effectivenessEvidenceUrl: url }, classification: 'strong', readOnly: true }),
  readOnly: (url) => ReadOnlyCapture({ record: { ...match, recordType: 'CAPA', effectivenessEvidenceUrl: url } }),
  history: (url) => DecisionDetails({ match, readOnly: true, data: { pairState: { state: 'CONFIRMED' },
    confirmedCount: 1, history: [{ id: 'decision', type: 'CONFIRM', authorDisplayName: 'Engineer',
      createdAt: '2026-10-31', reason: 'Review', evidenceLinks: [url] }] } }),
};
beforeEach(() => {
  jest.spyOn(React, 'useState').mockImplementation((initial) => [initial, jest.fn()]);
  jest.spyOn(React, 'useRef').mockImplementation((initial) => ({ current: initial }));
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

describe.each(Object.entries(surfaces))('%s evidence rendering', (_, render) => {
  test.each(['https://user:pass@example.com/x', 'http://user:pass@example.com/x', 'javascript:alert(1)',
    ' https://example.com/x', 'https://example.com/x ', 'https:///report', 'https://example.com/a\nb'])(
    'invalid stored URL %j is text, never an evidence Link', (url) => {
      const tree = nodes(render(url));
      expect(tree).toContain('Invalid evidence link');
      expect(tree.filter((node) => node.type === 'Link' && node.props.openNewTab)).toEqual([]);
      expect(tree.filter((node) => typeof node === 'string').join(' ')).not.toContain(url);
    },
  );

  test('legacy HTTP remains visible as plain text with the exact warning', () => {
    const url = 'http://example.com/legacy-report';
    const tree = nodes(render(url));
    expect(tree).toContain('Not a secure link (http)');
    expect(tree.find((node) => node.type === 'SectionMessage' && nodes(node).includes('Not a secure link (http)')).props.appearance).toBe('warning');
    expect(tree).toContain(url);
    expect(tree.filter((node) => node.type === 'Link' && node.props.openNewTab)).toEqual([]);
  });

  test('valid HTTPS is a clickable, unchanged evidence link', () => {
    const url = 'https://example.com/report.pdf?revision=A#page=2';
    const tree = nodes(render(url));
    expect(tree.find((node) => node.type === 'Link' && node.props.openNewTab).props.href).toBe(url);
    expect(tree).not.toContain('Invalid evidence link');
    expect(tree).not.toContain('Not a secure link (http)');
  });
});

test.each(['', null, undefined])('absent capture evidence %j still has the absent-evidence message', (url) => {
  for (const render of [surfaces.card, surfaces.readOnly]) {
    const tree = nodes(render(url));
    expect(tree).toContain('No effectiveness evidence recorded at closure');
    expect(tree).not.toContain('Invalid evidence link');
  }
});

const mountModal = (props = {}) => {
  React.useState.mockReturnValueOnce(['CONFIRM', jest.fn()]);
  const modal = nodes(DecisionDetails({ match, readOnly: false }))
    .find((node) => typeof node.type === 'function' && node.props.type === 'CONFIRM');
  const state = [], refs = [];
  let stateIndex = 0, refIndex = 0;
  React.useState.mockImplementation((initial) => {
    const index = stateIndex++;
    if (!(index in state)) state[index] = initial;
    return [state[index], (value) => { state[index] = value; }];
  });
  React.useRef.mockImplementation((initial) => {
    const index = refIndex++;
    if (!(index in refs)) refs[index] = { current: initial };
    return refs[index];
  });
  return () => { stateIndex = 0; refIndex = 0; return nodes(modal.type({ ...modal.props, ...props })); };
};
const typeInto = (tree, id, value) => tree.find((node) => node.type === 'TextArea' && node.props.id === id)
  .props.onChange({ target: { value } });
const submitModal = (tree) => tree.find((node) => node.type === 'Button' && node.props.children === 'Record decision').props.onClick();

test.each([
  ['http://example.com/report', 'Use an https:// link.'],
  ['https://user:pass@example.com/x', 'Remove the user name and password from the link.'],
  [' https://example.com/report', 'Remove spaces before or after the link.'],
  ['https://example.com/report ', 'Remove spaces before or after the link.'],
  ['javascript:alert(1)', 'Use an https:// link.'],
  ['https:///report', 'Enter a full https:// link.'],
])('decision modal reports %j in an error SectionMessage without repairing it', (url, reason) => {
  const onSubmit = jest.fn();
  const render = mountModal({ onSubmit });
  const tree = render();
  typeInto(tree, 'decision-reason', 'Reviewed');
  typeInto(tree, 'decision-links', url);
  submitModal(tree);
  const banner = render().find((node) => node.type === 'SectionMessage');
  expect(banner.props.appearance).toBe('error');
  expect(nodes(banner)).toContain(reason);
  expect(onSubmit).not.toHaveBeenCalled();
});

test('decision textareas are uncontrolled and submit the latest fast typing and pasted text', () => {
  const onSubmit = jest.fn();
  const render = mountModal({ onSubmit });
  const tree = render();
  for (const textarea of tree.filter((node) => node.type === 'TextArea')) {
    expect(textarea.props).not.toHaveProperty('value');
    expect(textarea.props.defaultValue).toBe('');
  }
  const reason = 'Different weld cell';
  for (let i = 1; i <= reason.length; i++) typeInto(tree, 'decision-reason', reason.slice(0, i));
  const url = 'https://example.com/report';
  for (let i = 1; i <= url.length; i++) typeInto(tree, 'decision-links', url.slice(0, i));
  const pasted = `${url}\r\nhttps://example.com/second`;
  typeInto(tree, 'decision-links', pasted);
  // No render awaited between input events and the click.
  submitModal(tree);
  expect(onSubmit).toHaveBeenCalledWith({ type: 'CONFIRM', reason,
    evidenceLinks: [url, 'https://example.com/second'] });
  typeInto(tree, 'decision-reason', 'Pasted complete explanation');
  submitModal(render());
  expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'Pasted complete explanation' }));
});

test('decision server errors use error styling', () => {
  const render = mountModal({ error: 'The decision could not be recorded.' });
  const banner = render().find((node) => node.type === 'SectionMessage');
  expect(banner.props.appearance).toBe('error');
  expect(nodes(banner)).toContain('The decision could not be recorded.');
});
