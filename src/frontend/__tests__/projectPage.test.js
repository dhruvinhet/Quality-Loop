jest.mock('@forge/react', () => ({ __esModule: true, default: { render: jest.fn() },
  ...Object.fromEntries(['Button', 'Heading', 'Link', 'Stack', 'Text'].map((name) => [name, name])) }));
jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }));
const React = require('react');
const { invoke } = require('@forge/bridge');
const { SamplePage } = require('../projectPage');
const ProjectSearchSettings = require('../ProjectSearchSettings').default;
const nodes = (element) => element == null || typeof element === 'boolean' ? [] : Array.isArray(element) ? element.flatMap(nodes)
  : [element, ...(element.props ? nodes(element.props.children) : [])];
let state, cursor;
const render = () => { cursor = 0; return nodes(SamplePage()); };
const text = (element) => nodes(element).filter((node) => typeof node === 'string').join('');

beforeEach(() => {
  state = []; cursor = 0;
  jest.clearAllMocks();
  jest.spyOn(React, 'useEffect').mockImplementation(() => {});
  jest.spyOn(React, 'useState').mockImplementation((initial) => {
    const index = cursor++;
    if (!(index in state)) state[index] = initial;
    return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  });
});
afterEach(() => jest.restoreAllMocks());

test('search settings appear below the three-step walkthrough', () => {
  const tree = render();
  const component = tree.find((node) => node.type === ProjectSearchSettings);
  expect(component).toBeDefined();
  expect(tree.indexOf(component)).toBeGreaterThan(tree.findIndex((node) => typeof node === 'string' && node.startsWith('3. Review the DEMO')));
});

test('project page presents three compact first-run steps without an admin page', () => {
  const tree = render();
  expect(tree).toContain('How to try this');
  const steps = tree.filter((node) => node.type === 'Text' && /^[123]\. /.test(text(node)));
  expect(steps).toHaveLength(3);
  expect(text(steps[0])).toBe('1. Create the sample scenario below. Review the five issue writes and confirm.');
  expect(text(steps[1])).toContain('Check sample readiness');
  expect(text(steps[1])).toContain('Open QualityLoop from the apps icon under the issue title and click Save.');
  expect(text(steps[2])).toBe('3. Review the DEMO CAPA-B match and any hints. Record an engineer decision with a reason.');
  expect(text(tree)).not.toMatch(/admin/i);
  expect(tree.some((node) => node.type === 'Link')).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});

test('readiness reveals the authorised DEMO new-NC link in step two without creating more issues', async () => {
  state = [{ exists: true, status: 'complete', issues: [] }, false, null, '', null, []];
  invoke.mockImplementation(async (name) => name === 'sampleReadiness'
    ? { ready: true, newNcKey: 'DEMO-5' } : { exists: true, status: 'complete', issues: [] });
  let tree = render();
  expect(tree.some((node) => node.type === 'Link')).toBe(false);
  await tree.find((node) => node.type === 'Button' && node.props.children === 'Check sample readiness').props.onClick();
  tree = render();
  const step = tree.find((node) => node.type === 'Text' && text(node).startsWith('2. '));
  expect(nodes(step).find((node) => node.type === 'Link').props).toMatchObject({ href: '/browse/DEMO-5', children: 'DEMO-5' });
  expect(text(step)).toContain('Open the DEMO new NC DEMO-5.');
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(['sampleReadiness', 'sampleStatus']);
});

test('a not-ready sample keeps the readiness guidance and does not invent an NC link', async () => {
  state = [{ exists: true, status: 'complete', issues: [] }, false, null, '', null, []];
  expect(render().filter((node) => node.type === 'Link')).toEqual([]);
  expect(text(render())).toContain('Wait for the sample to be ready, or use Check sample readiness.');
});
