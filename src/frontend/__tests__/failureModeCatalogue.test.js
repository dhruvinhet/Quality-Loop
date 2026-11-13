jest.mock('@forge/react', () => Object.fromEntries(['Button', 'Form', 'Heading', 'Label', 'SectionMessage', 'Stack', 'Text', 'Textfield'].map((name) => [name, name])));
jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }));
const React = require('react');
const { invoke } = require('@forge/bridge');
const Catalogue = require('../FailureModeCatalogue').default;
const nodes = (el) => el == null || typeof el === 'boolean' ? [] : Array.isArray(el) ? el.flatMap(nodes)
  : [el, ...(el.props ? nodes(el.props.children) : [])];
let state, refs, index, refIndex;
const render = () => { index = 0; refIndex = 0; return nodes(Catalogue()); };
const button = (tree, label) => tree.find((node) => node.type === 'Button' && node.props.children === label);
const catalogue = { version: 1, modes: [{ code: 'FM-08', label: 'Wire fracture', active: true }] };
beforeEach(() => {
  state = []; refs = []; jest.clearAllMocks();
  jest.spyOn(React, 'useState').mockImplementation((initial) => {
    const slot = index++;
    if (!(slot in state)) state[slot] = initial;
    return [state[slot], (value) => { state[slot] = value; }];
  });
  jest.spyOn(React, 'useRef').mockImplementation((initial) => refs[refIndex++] ??= { current: initial });
  jest.spyOn(React, 'useEffect').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
async function load(value = catalogue) {
  invoke.mockResolvedValueOnce(value);
  await button(render(), 'Refresh failure modes').props.onClick();
  return render();
}
test('admin lists catalogue, adds latest pasted text with uncontrolled inputs, and refreshes version', async () => {
  let tree = await load();
  expect(tree).toContain('FM-08 Wire fracture (active)');
  button(tree, 'Add failure mode').props.onClick(); tree = render();
  const fields = tree.filter((node) => node.type === 'Textfield');
  expect(fields.every((field) => !Object.hasOwn(field.props, 'value'))).toBe(true);
  fields.find((field) => field.props.id === 'mode-code').props.onChange({ target: { value: 'fm-09' } });
  const label = fields.find((field) => field.props.id === 'mode-label');
  label.props.onChange({ target: { value: 'Wire' } });
  label.props.onChange({ target: { value: 'Wire fracture after a fast paste' } });
  invoke.mockResolvedValueOnce({ ...catalogue, version: 2 });
  await tree.find((node) => node.type === 'Form').props.onSubmit();
  expect(invoke).toHaveBeenLastCalledWith('changeFailureMode', { action: 'add', code: 'fm-09', label: 'Wire fracture after a fast paste', expectedVersion: 1 });
  expect(render()).toContain('Failure-mode catalogue saved. Refresh open issue panels to load the current list.');
});
test('rename locks the code, and deactivate/activate are explicit actions with no delete button', async () => {
  let tree = await load();
  button(tree, 'Rename FM-08 label').props.onClick(); tree = render();
  expect(tree.find((node) => node.type === 'Textfield' && node.props.id === 'mode-code').props.isDisabled).toBe(true);
  button(tree, 'Cancel catalogue edit').props.onClick(); tree = render();
  invoke.mockResolvedValueOnce({ version: 2, modes: [{ ...catalogue.modes[0], active: false }] });
  await button(tree, 'Deactivate FM-08').props.onClick();
  expect(invoke).toHaveBeenLastCalledWith('changeFailureMode', { action: 'deactivate', code: 'FM-08', expectedVersion: 1 });
  tree = render(); expect(tree).toContain('FM-08 Wire fracture (inactive)');
  expect(button(tree, 'Activate FM-08')).toBeDefined();
  expect(tree.filter((node) => node.type === 'Button').some((node) => String(node.props.children).includes('Delete'))).toBe(false);
});
test('permission and stale-version errors are visible and do not show saved', async () => {
  let tree = await load(null);
  expect(tree).toContain('The catalogue could not be loaded. Check Jira administrator permission and refresh.');
  tree = await load();
  invoke.mockResolvedValueOnce({ error: 'The catalogue changed. Refresh before editing again.' });
  await button(tree, 'Deactivate FM-08').props.onClick();
  tree = render();
  expect(tree).toContain('The catalogue changed. Refresh before editing again.');
  expect(tree.filter((node) => node.type === 'SectionMessage').map((node) => node.props.appearance)).toEqual(['error']);
});
