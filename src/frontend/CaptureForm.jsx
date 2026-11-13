import React, { useState } from 'react';
import {
  ErrorMessage, Form, FormFooter, FormSection, Label, LoadingButton,
  Select, Textfield, TextArea, DatePicker, SectionMessage, Text, useForm,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { FAILURE_MODES } from '../config/failureModes';
import { validateCapture } from '../lib/capture';
import { validEvidenceUrl } from '../lib/urls';
import { canonicalCode, failureModeLabel, modeOptions } from '../lib/failureModes';

const RECORD_TYPES = ['NC', 'CAPA'].map((value) => ({ label: value, value }));
const asPayload = (data) => ({
  ...data,
  recordType: data.recordType?.value ?? '',
  failureMode: data.failureMode?.value ?? '',
});

export default function CaptureForm({ record, initialRecordType = '', onSaved, failureModes = FAILURE_MODES }) {
  const options = modeOptions(failureModes);
  const storedCode = canonicalCode(record?.failureMode);
  const storedOption = options.find(({ value }) => value === storedCode)
    ?? (storedCode ? { value: storedCode, label: `${failureModeLabel(record.failureMode, failureModes)} (inactive or unavailable)` } : null);
  const [recordType, setRecordType] = useState(record?.recordType ?? initialRecordType);
  const [message, setMessage] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const { register, getFieldId, getValues, handleSubmit, formState: { errors, isSubmitting } } = useForm({
    // UI Kit 12.4 only accepts defaultValues and hardcodes blur/change modes.
    // Register without validation; validate once in save to keep errors stable
    // during edits and blur, equivalent to onSubmit/onSubmit validation modes.
    defaultValues: {
      recordType: RECORD_TYPES.find(({ value }) => value === (record?.recordType ?? initialRecordType)) ?? null,
      partNumber: record?.partOriginal ?? '',
      failureMode: storedOption,
      supplier: record?.supplier ?? '',
      line: record?.line ?? '',
      detectedDate: record?.detectedDate ?? '',
      closedDate: record?.closedDate ?? '',
      effectivenessEvidenceUrl: record?.effectivenessEvidenceUrl ?? '',
      rootCause: record?.rootCause ?? '',
      actionsTaken: record?.actionsTaken ?? '',
    },
  });
  const field = (name) => {
    const registered = register(name);
    return { ...registered, onChange: (...args) => {
      setMessage(null);
      return registered.onChange(...args);
    } };
  };
  const hasFieldErrors = Object.keys(errors).length > 0 || Object.keys(fieldErrors).length > 0;
  const error = (name) => {
    const text = errors[name]?.message || fieldErrors[name];
    return text ? <ErrorMessage>{text}</ErrorMessage> : null;
  };
  const recordTypeField = field('recordType');

  const save = async (data) => {
    setMessage(null);
    setFieldErrors({});
    const validationErrors = validateCapture(asPayload(data), failureModes);
    if (Object.keys(validationErrors).length) {
      setFieldErrors(validationErrors);
      return;
    }
    try {
      const result = await invoke('saveCapture', asPayload(data));
      if (result?.fieldErrors) {
        setFieldErrors(result.fieldErrors);
        setMessage({ appearance: 'error', text: 'Check the highlighted fields.' });
      } else if (!result?.record) {
        setMessage({ appearance: 'error', text: result?.error || 'Save was not completed. Check your issue access and try again.' });
      } else {
        setMessage({ appearance: 'success', text: result.record.recordType === 'NC'
          ? 'Quality details saved. Review the evidence below and record an engineer decision.'
          : 'Quality details saved. Open an NC to review possible recurrence evidence.' });
        onSaved?.(result.record);
      }
    } catch {
      setMessage({ appearance: 'error', text: 'Save could not be completed. Try again.' });
    }
  };

  return (
    <Form onSubmit={handleSubmit(save, () => setMessage(null))}>
      <FormSection description="Save quality details on this issue. Fields marked * are required.">
        <Label labelFor={getFieldId('recordType')}>Record type *</Label>
        <Select {...recordTypeField} options={RECORD_TYPES} isDisabled={isSubmitting || !!record?.recordType}
          onChange={(option) => {
            recordTypeField.onChange(option);
            setRecordType(option?.value ?? '');
            setMessage(null);
          }} />
        {error('recordType')}

        <Label labelFor={getFieldId('partNumber')}>Part number *</Label>
        <Textfield {...field('partNumber')} isDisabled={isSubmitting} maxLength={2000} />
        {error('partNumber')}

        <Label labelFor={getFieldId('failureMode')}>Failure mode *</Label>
        <Select {...field('failureMode')} options={options} isDisabled={isSubmitting} />
        {storedCode && !options.some(({ value }) => value === storedCode) && <Text>{`Stored failure mode: ${record.failureMode} (inactive or unavailable). Choose an active code before saving.`}</Text>}
        {error('failureMode')}

        <Label labelFor={getFieldId('supplier')}>Supplier</Label>
        <Textfield {...field('supplier')} isDisabled={isSubmitting} maxLength={2000} />
        {error('supplier')}

        <Label labelFor={getFieldId('line')}>Line</Label>
        <Textfield {...field('line')} isDisabled={isSubmitting} maxLength={2000} />
        {error('line')}

        <Label labelFor={getFieldId('detectedDate')}>{recordType === 'NC' ? 'Detected date *' : 'Detected date'}</Label>
        <DatePicker {...field('detectedDate')} dateFormat="YYYY-MM-DD" locale="en-CA" placeholder="YYYY-MM-DD" shouldShowCalendarButton isDisabled={isSubmitting} />
        {error('detectedDate')}

        {recordType === 'CAPA' && <>
          <Label labelFor={getFieldId('rootCause')}>Root cause</Label>
          <TextArea {...field('rootCause')} defaultValue={getValues('rootCause')} isDisabled={isSubmitting} maxLength={2000} />
          {error('rootCause')}
          <Label labelFor={getFieldId('actionsTaken')}>Actions taken</Label>
          <TextArea {...field('actionsTaken')} defaultValue={getValues('actionsTaken')} isDisabled={isSubmitting} maxLength={2000} />
          {error('actionsTaken')}
          <Label labelFor={getFieldId('closedDate')}>Closed date *</Label>
          <DatePicker {...field('closedDate')} defaultValue={getValues('closedDate')} dateFormat="YYYY-MM-DD" locale="en-CA" placeholder="YYYY-MM-DD" shouldShowCalendarButton isDisabled={isSubmitting} />
          <Text>Required for recurrence matching. Jira status is not used.</Text>
          {error('closedDate')}

          <Label labelFor={getFieldId('effectivenessEvidenceUrl')}>Effectiveness evidence link</Label>
          <Textfield {...field('effectivenessEvidenceUrl')} defaultValue={getValues('effectivenessEvidenceUrl')} isDisabled={isSubmitting} maxLength={2000} />
          {!validEvidenceUrl(record?.effectivenessEvidenceUrl) && validEvidenceUrl(record?.effectivenessEvidenceUrl, { allowHttp: true }) &&
            <SectionMessage appearance="warning"><Text>Not a secure link (http)</Text></SectionMessage>}
          <Text>Optional. Must start with https://</Text>
          {error('effectivenessEvidenceUrl')}
        </>}
      </FormSection>
      {message && !hasFieldErrors && <SectionMessage appearance={message.appearance}><Text>{message.text}</Text></SectionMessage>}
      {isSubmitting && <Text>Saving quality details. Please wait before making another change.</Text>}
      <FormFooter align="start">
        <LoadingButton type="submit" appearance="primary" isLoading={isSubmitting} isDisabled={isSubmitting}>{isSubmitting ? 'Saving quality details…' : 'Save'}</LoadingButton>
      </FormFooter>
    </Form>
  );
}
