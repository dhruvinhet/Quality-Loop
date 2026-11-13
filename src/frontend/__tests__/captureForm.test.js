jest.mock('@forge/react', () => ({
  ...Object.fromEntries(['ErrorMessage', 'Form', 'FormFooter', 'FormSection', 'Label', 'LoadingButton',
    'Select', 'Textfield', 'TextArea', 'DatePicker', 'SectionMessage', 'Text'].map((name) => [name, name])),
  useForm: jest.fn(),
}));
jest.mock('@forge/bridge', () => ({ invoke: jest.fn() }));
const React = require('react');
const { useForm } = require('@forge/react');
const { invoke } = require('@forge/bridge');
const CaptureForm = require('../CaptureForm').default;
const nodes = (element) => element == null || typeof element === 'boolean' ? [] : Array.isArray(element) ? element.flatMap(nodes)
  : [element, ...(element.props ? nodes(element.props.children) : [])];
let values;
let registrations;
let submitting;
let invalidSubmit;

beforeEach(() => {
  values = null;
  registrations = {};
  submitting = false;
  jest.spyOn(React, 'useState').mockImplementation((initial) => [initial, jest.fn()]);
  useForm.mockImplementation(({ defaultValues }) => {
    values = { ...defaultValues, ...values };
    return {
      register: (name, options) => {
        const onChange = jest.fn((event) => { values[name] = event?.target ? event.target.value : event; });
        registrations[name] = { options, onChange };
        return { name, onChange, onBlur: jest.fn() };
      },
      getFieldId: (name) => name,
      getValues: (name) => name ? values[name] : values,
      handleSubmit: (save, onError) => { invalidSubmit = onError; return save; },
      formState: { errors: {}, isSubmitting: submitting },
    };
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

const mount = (props) => {
  const state = [];
  let cursor = 0;
  React.useState.mockImplementation((initial) => {
    const index = cursor++;
    if (!(index in state)) state[index] = initial;
    return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  });
  return () => { cursor = 0; return nodes(CaptureForm(props)); };
};
const submit = (tree) => tree.find((node) => node.type === 'Form').props.onSubmit(values);
const complete = { recordType: 'CAPA', partOriginal: 'P-1', failureMode: 'FM-01', closedDate: '2026-10-01' };

test('capture options and validation use the loaded custom catalogue; inactive stored codes remain visible', async () => {
  const failureModes = [{ code: 'FM-08', label: 'Wire fracture', active: true }, { code: 'FM-09', label: 'Old mode', active: false }];
  const render = mount({ record: { ...complete, failureMode: 'FM-09' }, failureModes });
  let tree = render();
  const select = tree.find((node) => node.type === 'Select' && node.props.name === 'failureMode');
  expect(select.props.options).toEqual([{ value: 'FM-08', label: 'FM-08 Wire fracture' }]);
  expect(values.failureMode.value).toBe('FM-09');
  expect(tree).toContain('Stored failure mode: FM-09 (inactive or unavailable). Choose an active code before saving.');
  await submit(tree);
  expect(invoke).not.toHaveBeenCalled();
  expect(render()).toContain('Select a failure mode.');
  values.failureMode = { value: 'FM-08' };
  invoke.mockResolvedValueOnce({ record: { ...complete, failureMode: 'FM-08' } });
  tree = render(); await submit(tree);
  expect(invoke).toHaveBeenCalledWith('saveCapture', expect.objectContaining({ failureMode: 'FM-08' }));
});

test('new CAPA shows the required closed-date label, hint and submit-only client validation', async () => {
  const render = mount({ initialRecordType: 'CAPA' });
  const tree = render();
  expect(tree).toContain('Closed date *');
  expect(tree).toContain('Required for recurrence matching. Jira status is not used.');
  expect(tree.find((node) => node.type === 'Label' && node.props.children === 'Closed date *').props.labelFor)
    .toBe(tree.find((node) => node.type === 'DatePicker' && node.props.name === 'closedDate').props.name);
  await submit(tree);
  expect(render()).toContain('Select a closed date for a CAPA. Matching uses this date, not Jira status.');
  values.closedDate = '2026-10-01';
  await submit(render());
  expect(render()).not.toContain('Select a closed date for a CAPA. Matching uses this date, not Jira status.');
});

test('NC does not show or require the CAPA closed-date field', () => {
  const tree = nodes(CaptureForm({ initialRecordType: 'NC' }));
  expect(tree).not.toContain('Closed date *');
  expect(registrations.closedDate).toBeUndefined();
});

test.each(['NC', 'CAPA'])('record type stays selectable before save and locks when the saved %s is passed back', (recordType) => {
  let tree = nodes(CaptureForm({ initialRecordType: recordType }));
  expect(tree.find((node) => node.type === 'Select' && node.props.name === 'recordType').props.isDisabled).toBe(false);
  tree = nodes(CaptureForm({ record: { recordType } }));
  expect(tree.find((node) => node.type === 'Select' && node.props.name === 'recordType').props.isDisabled).toBe(true);
});

test('record type is disabled during submission even before first save', () => {
  submitting = true;
  const tree = nodes(CaptureForm({ initialRecordType: 'NC' }));
  expect(tree.find((node) => node.type === 'Select' && node.props.name === 'recordType').props.isDisabled).toBe(true);
});

test('legacy CAPA without a date still renders with its saved type and blank date', () => {
  const tree = nodes(CaptureForm({ record: { recordType: 'CAPA', partOriginal: 'P-1', closedDate: null } }));
  expect(tree).toContain('Closed date *');
  expect(tree.find((node) => node.type === 'DatePicker' && node.props.name === 'closedDate').props.defaultValue).toBe('');
  expect(tree.find((node) => node.type === 'Select' && node.props.name === 'recordType').props.isDisabled).toBe(true);
});

test('editing a legacy HTTP CAPA retains its link and requires the engineer to fix the field', async () => {
  const url = 'http://example.com/legacy-report';
  const render = mount({ record: { ...complete, effectivenessEvidenceUrl: url } });
  const tree = render();
  expect(tree.find((node) => node.type === 'Textfield' && node.props.name === 'effectivenessEvidenceUrl').props.defaultValue).toBe(url);
  expect(tree).toContain('Not a secure link (http)');
  expect(tree.find((node) => node.type === 'SectionMessage' && nodes(node).includes('Not a secure link (http)')).props.appearance).toBe('warning');
  expect(tree).toContain('Optional. Must start with https://');
  await submit(tree);
  expect(render()).toContain('Use an https:// link.');
  expect(values.effectivenessEvidenceUrl).toBe(url);
  values.effectivenessEvidenceUrl = 'https://example.com/legacy-report';
  invoke.mockResolvedValue({ record: complete });
  await submit(render());
  expect(render()).not.toContain('Use an https:// link.');
});

test('client errors stay visible on edit and blur; the next Save succeeds without stale saved text', async () => {
  const render = mount({ record: complete });
  invoke.mockResolvedValue({ record: complete });
  await submit(render());
  expect(render().some((node) => typeof node === 'string' && node.startsWith('Quality details saved.'))).toBe(true);
  let field = render().find((node) => node.type === 'Textfield' && node.props.name === 'effectivenessEvidenceUrl');
  field.props.onChange({ target: { value: 'http://example.com/report' } });
  expect(render().some((node) => typeof node === 'string' && node.startsWith('Quality details saved.'))).toBe(false);
  await submit(render());
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(render()).toContain('Use an https:// link.');
  field = render().find((node) => node.type === 'Textfield' && node.props.name === 'effectivenessEvidenceUrl');
  field.props.onChange({ target: { value: 'https://example.com/report' } });
  field.props.onBlur();
  expect(render()).toContain('Use an https:// link.');
  expect(Object.values(registrations).every(({ options }) => !options?.validate)).toBe(true);
  await submit(render());
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith('saveCapture', expect.objectContaining({ effectivenessEvidenceUrl: 'https://example.com/report' }));
  expect(render()).not.toContain('Use an https:// link.');
  expect(render().some((node) => typeof node === 'string' && node.startsWith('Quality details saved.'))).toBe(true);
});

test.each(['recordType', 'partNumber', 'failureMode', 'supplier', 'line', 'detectedDate', 'closedDate',
  'rootCause', 'actionsTaken', 'effectivenessEvidenceUrl'])('changing %s clears saved/error banners and forwards the registered change', async (name) => {
  const render = mount({ record: complete });
  invoke.mockResolvedValue({ record: complete });
  await submit(render());
  const input = render().find((node) => node.props?.name === name);
  const change = registrations[name].onChange;
  const value = ['recordType', 'failureMode'].includes(name) ? { value: name === 'recordType' ? 'CAPA' : 'FM-01' } : { target: { value: 'changed' } };
  input.props.onChange(value);
  expect(change).toHaveBeenCalledWith(value);
  expect(render().some((node) => node.type === 'SectionMessage' && node.props.appearance === 'success')).toBe(false);
  invoke.mockRejectedValue(new Error('Save unavailable'));
  // Restore valid form values to exercise a server error banner as well.
  values.recordType = { value: 'CAPA' }; values.failureMode = { value: 'FM-01' };
  values.closedDate = complete.closedDate; values.detectedDate = ''; values.effectivenessEvidenceUrl = '';
  await submit(render());
  expect(render()).toContain('Save could not be completed. Try again.');
  render().find((node) => node.props?.name === name).props.onChange(value);
  expect(render()).not.toContain('Save could not be completed. Try again.');
});

test('client validation error callback clears a previously saved message', async () => {
  const render = mount({ record: complete });
  invoke.mockResolvedValue({ record: complete });
  await submit(render());
  expect(render().some((node) => node.type === 'SectionMessage' && node.props.appearance === 'success')).toBe(true);
  invalidSubmit({ partNumber: { message: 'Enter a part number.' } });
  expect(render().some((node) => node.type === 'SectionMessage' && node.props.appearance === 'success')).toBe(false);
});

test('a client-invalid Save clears a prior success even without a field change notification', async () => {
  const render = mount({ record: complete });
  invoke.mockResolvedValue({ record: complete });
  await submit(render());
  expect(render().some((node) => node.type === 'SectionMessage' && node.props.appearance === 'success')).toBe(true);
  values.effectivenessEvidenceUrl = 'https://user:pass@example.com/report';
  await submit(render());
  const tree = render();
  expect(tree).toContain('Remove the user name and password from the link.');
  expect(tree.some((node) => typeof node === 'string' && node.startsWith('Quality details saved.'))).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('disabled saved record type is retained in the submitted payload', async () => {
  const record = { recordType: 'CAPA', partOriginal: 'P-1', failureMode: 'FM-01', closedDate: '2026-10-01' };
  const onSaved = jest.fn();
  invoke.mockResolvedValue({ record });
  const tree = nodes(CaptureForm({ record, onSaved }));
  await tree.find((node) => node.type === 'Form').props.onSubmit(values);
  expect(invoke).toHaveBeenCalledWith('saveCapture', expect.objectContaining({ recordType: 'CAPA', closedDate: '2026-10-01' }));
  expect(onSaved).toHaveBeenCalledWith(record);
});
