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
let validators;
let submitting;

beforeEach(() => {
  values = null;
  validators = {};
  submitting = false;
  jest.spyOn(React, 'useState').mockImplementation((initial) => [initial, jest.fn()]);
  useForm.mockImplementation(({ defaultValues }) => {
    values = { ...defaultValues, ...values };
    return {
      register: (name, options) => {
        validators[name] = options.validate;
        return { name, onChange: jest.fn() };
      },
      getFieldId: (name) => name,
      getValues: (name) => name ? values[name] : values,
      handleSubmit: (save) => save,
      formState: { errors: {}, isSubmitting: submitting },
    };
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

test('new CAPA shows the required closed-date label, hint and client validation', () => {
  const tree = nodes(CaptureForm({ initialRecordType: 'CAPA' }));
  expect(tree).toContain('Closed date *');
  expect(tree).toContain('Required for recurrence matching. Jira status is not used.');
  expect(tree.find((node) => node.type === 'Label' && node.props.children === 'Closed date *').props.labelFor)
    .toBe(tree.find((node) => node.type === 'DatePicker' && node.props.name === 'closedDate').props.name);
  expect(validators.closedDate()).toBe('Select a closed date for a CAPA. Matching uses this date, not Jira status.');
  values.closedDate = '2026-10-01';
  expect(validators.closedDate()).toBe(true);
});

test('NC does not show or require the CAPA closed-date field', () => {
  const tree = nodes(CaptureForm({ initialRecordType: 'NC' }));
  expect(tree).not.toContain('Closed date *');
  expect(validators.closedDate).toBeUndefined();
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

test('editing a legacy HTTP CAPA retains its link and requires the engineer to fix the field', () => {
  const url = 'http://example.com/legacy-report';
  const tree = nodes(CaptureForm({ record: { recordType: 'CAPA', closedDate: '2026-10-01', effectivenessEvidenceUrl: url } }));
  expect(tree.find((node) => node.type === 'Textfield' && node.props.name === 'effectivenessEvidenceUrl').props.defaultValue).toBe(url);
  expect(tree).toContain('Not a secure link (http)');
  expect(validators.effectivenessEvidenceUrl()).toBe('Use an https:// link.');
  expect(values.effectivenessEvidenceUrl).toBe(url);
  values.effectivenessEvidenceUrl = 'https://example.com/legacy-report';
  expect(validators.effectivenessEvidenceUrl()).toBe(true);
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
