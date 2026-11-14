jest.mock('@forge/react', () => Object.fromEntries(['Button', 'Form', 'Heading', 'Label', 'SectionMessage', 'Select', 'Stack', 'Text', 'Textfield'].map((name) => [name, name])));
jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }));
const React = require('react');
const { invoke } = require('@forge/bridge');
const Settings = require('../ProjectSearchSettings').default;
const nodes = (el) => el == null || typeof el === 'boolean' ? [] : Array.isArray(el) ? el.flatMap(nodes)
  : [el, ...(el.props ? nodes(el.props.children) : [])];
let state, refs, index, refIndex;
const render = () => { index = 0; refIndex = 0; return nodes(Settings()); };
const button = (tree, name) => tree.find((node) => node.type === 'Button' && node.props.children === name);
const saved = { settings: { scope: 'PROJECT', lookbackDays: 365, version: 0 }, canAdmin: true, listedProjectKeys: [] };
beforeEach(() => {
  state = []; refs = []; jest.clearAllMocks();
  jest.spyOn(React, 'useState').mockImplementation((initial) => {
    const slot = index++; if (!(slot in state)) state[slot] = initial;
    return [state[slot], (value) => { state[slot] = typeof value === 'function' ? value(state[slot]) : value; }];
  });
  jest.spyOn(React, 'useRef').mockImplementation((initial) => refs[refIndex++] ??= { current: initial });
  jest.spyOn(React, 'useEffect').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
async function load(data = saved) {
  invoke.mockResolvedValueOnce(data);
  await button(render(), 'Refresh search settings').props.onClick(); return render();
}
test('project browsers see current settings without editing controls', async () => {
  const tree = await load({ ...saved, canAdmin: false });
  expect(tree).toContain('Searching this project only · CAPAs closed 1–365 days before detection');
  expect(tree.some((node) => node.type === 'Form')).toBe(false);
  expect(tree).toContain('Administer Projects on this project or Jira administrator permission is required to change these settings.');
});
test('admin changes scope/window and submits latest pasted keys without controlled text input', async () => {
  let tree = await load();
  tree.find((node) => node.type === 'Select' && node.props.id === 'search-scope').props.onChange({ value: 'LISTED' });
  tree = render();
  const input = tree.find((node) => node.type === 'Textfield');
  expect(Object.hasOwn(input.props, 'value')).toBe(false);
  input.props.onChange({ target: { value: 'O' } });
  input.props.onChange({ target: { value: 'OPS, SUP' } });
  tree.find((node) => node.type === 'Select' && node.props.id === 'search-window').props.onChange({ value: 730 });
  invoke.mockResolvedValueOnce({ ...saved, settings: { scope: 'LISTED', lookbackDays: 730, version: 1 }, listedProjectKeys: ['OPS', 'SUP'] });
  await tree.find((node) => node.type === 'Form').props.onSubmit();
  expect(invoke).toHaveBeenLastCalledWith('saveProjectSearchSettings', { scope: 'LISTED', lookbackDays: 730, projectKeys: 'OPS, SUP', expectedVersion: 0 });
  expect(render()).toContain('Searching this project + listed projects · CAPAs closed 1–730 days before detection');
});
test('unknown listed keys surface the server error, while a transport failure is sanitized', async () => {
  let tree = await load();
  invoke.mockResolvedValueOnce({ error: 'Project MISSING was not found or you cannot browse it. Check the key.' });
  await tree.find((node) => node.type === 'Form').props.onSubmit();
  tree = render(); expect(tree).toContain('Project MISSING was not found or you cannot browse it. Check the key.');
  expect(tree.filter((node) => node.type === 'SectionMessage').map((node) => node.props.appearance)).toEqual(['error']);
  invoke.mockRejectedValueOnce(new Error('Private transport detail'));
  await button(tree, 'Refresh search settings').props.onClick();
  expect(render()).not.toContain('Private transport detail');
});
