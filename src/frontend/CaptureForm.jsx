import React, { useState } from 'react';
import {
  ErrorMessage, Form, FormFooter, FormSection, Label, LoadingButton,
  Select, Textfield, DatePicker, SectionMessage, Text, useForm,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { FAILURE_MODES } from '../config/failureModes';
import { validateCapture } from '../lib/capture';

const RECORD_TYPES = ['NC', 'CAPA'].map((value) => ({ label: value, value }));
const asPayload = (data) => ({
  ...data,
  recordType: data.recordType?.value ?? '',
  failureMode: data.failureMode?.value ?? '',
});

export default function CaptureForm({ record }) {
  const [recordType, setRecordType] = useState(record?.recordType ?? '');
  const [message, setMessage] = useState(null);
  const [serverErrors, setServerErrors] = useState({});
  const { register, getFieldId, getValues, handleSubmit, formState: { errors, isSubmitting } } = useForm({
    defaultValues: {
      recordType: RECORD_TYPES.find(({ value }) => value === record?.recordType) ?? null,
      partNumber: record?.partOriginal ?? '',
      failureMode: FAILURE_MODES.find(({ value }) => value === record?.failureMode) ?? null,
      supplier: record?.supplier ?? '',
      line: record?.line ?? '',
      detectedDate: record?.detectedDate ?? '',
      closedDate: record?.closedDate ?? '',
      effectivenessEvidenceUrl: record?.effectivenessEvidenceUrl ?? '',
    },
  });
  const field = (name) => register(name, {
    validate: () => validateCapture(asPayload(getValues()))[name] || true,
  });
  const error = (name) => {
    const text = errors[name]?.message || serverErrors[name];
    return text ? <ErrorMessage>{text}</ErrorMessage> : null;
  };
  const recordTypeField = field('recordType');

  const save = async (data) => {
    setMessage(null);
    setServerErrors({});
    try {
      const result = await invoke('saveCapture', asPayload(data));
      if (result?.fieldErrors) {
        setServerErrors(result.fieldErrors);
        setMessage({ appearance: 'error', text: 'Check the highlighted fields.' });
      } else if (!result?.record) {
        setMessage({ appearance: 'error', text: result?.error || 'Save was not completed. Check your issue access and try again.' });
      } else {
        setMessage({ appearance: 'success', text: 'Quality details saved.' });
      }
    } catch {
      setMessage({ appearance: 'error', text: 'Save could not be completed. Try again.' });
    }
  };

  return (
    <Form onSubmit={handleSubmit(save)}>
      <FormSection description="Save quality details on this issue. Fields marked * are required.">
        <Label labelFor={getFieldId('recordType')}>Record type *</Label>
        <Select {...recordTypeField} options={RECORD_TYPES} isDisabled={isSubmitting}
          onChange={(option) => {
            recordTypeField.onChange(option);
            setRecordType(option?.value ?? '');
            setMessage(null);
            setServerErrors({});
          }} />
        {error('recordType')}

        <Label labelFor={getFieldId('partNumber')}>Part number *</Label>
        <Textfield {...field('partNumber')} isDisabled={isSubmitting} maxLength={2000} />
        {error('partNumber')}

        <Label labelFor={getFieldId('failureMode')}>Failure mode *</Label>
        <Select {...field('failureMode')} options={FAILURE_MODES} isDisabled={isSubmitting} />
        {error('failureMode')}

        <Label labelFor={getFieldId('supplier')}>Supplier</Label>
        <Textfield {...field('supplier')} isDisabled={isSubmitting} maxLength={2000} />
        {error('supplier')}

        <Label labelFor={getFieldId('line')}>Line</Label>
        <Textfield {...field('line')} isDisabled={isSubmitting} maxLength={2000} />
        {error('line')}

        <Label labelFor={getFieldId('detectedDate')}>{recordType === 'NC' ? 'Detected date *' : 'Detected date'}</Label>
        <DatePicker {...field('detectedDate')} isDisabled={isSubmitting} />
        {error('detectedDate')}

        {recordType === 'CAPA' && <>
          <Label labelFor={getFieldId('closedDate')}>Closed date</Label>
          <DatePicker {...field('closedDate')} defaultValue={getValues('closedDate')} isDisabled={isSubmitting} />
          {error('closedDate')}

          <Label labelFor={getFieldId('effectivenessEvidenceUrl')}>Effectiveness evidence link</Label>
          <Textfield {...field('effectivenessEvidenceUrl')} defaultValue={getValues('effectivenessEvidenceUrl')} isDisabled={isSubmitting} maxLength={2000} />
          {error('effectivenessEvidenceUrl')}
        </>}
      </FormSection>
      {message && <SectionMessage appearance={message.appearance}><Text>{message.text}</Text></SectionMessage>}
      <FormFooter align="start">
        <LoadingButton type="submit" appearance="primary" isLoading={isSubmitting} isDisabled={isSubmitting}>Save</LoadingButton>
      </FormFooter>
    </Form>
  );
}
