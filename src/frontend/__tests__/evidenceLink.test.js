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

test.each(['http://example.com/report', ' https://example.com/report', 'https://example.com/report '])(
  'decision modal rejects %j without silently trimming it', (url) => {
    React.useState.mockReturnValueOnce(['CONFIRM', jest.fn()]);
    const modal = nodes(DecisionDetails({ match, readOnly: false }))
      .find((node) => typeof node.type === 'function' && node.props.type === 'CONFIRM');
    const onSubmit = jest.fn();
    const setValidation = jest.fn();
    React.useState.mockReturnValueOnce(['Reviewed', jest.fn()]).mockReturnValueOnce([url, jest.fn()])
      .mockReturnValueOnce([null, jest.fn()]).mockReturnValueOnce(['', setValidation]);
    const tree = nodes(modal.type({ ...modal.props, onSubmit }));
    tree.find((node) => node.type === 'Button' && node.props.children === 'Record decision').props.onClick();
    expect(setValidation).toHaveBeenCalledWith('Use an https:// link.');
    expect(onSubmit).not.toHaveBeenCalled();
  },
);
