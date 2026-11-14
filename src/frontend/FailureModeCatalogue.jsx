import React, { useEffect, useRef, useState } from 'react';
import { Button, ButtonGroup, Form, Heading, Inline, Label, Lozenge, SectionMessage, Stack, Text, Textfield } from '@forge/react';
import { invoke } from '@forge/bridge';
import { sortFailureModes } from '../lib/failureModes';

export default function FailureModeCatalogue() {
  const [catalogue, setCatalogue] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [editing, setEditing] = useState(null);
  const code = useRef('');
  const label = useRef('');
  const pending = useRef(false);
  async function refresh() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const result = await invoke('getFailureModeCatalogue');
      if (!result?.modes) throw new Error();
      setCatalogue(result); setEditing(null);
    } catch { setMessage({ appearance: 'error', text: 'The catalogue could not be loaded. Check Jira administrator permission and refresh.' }); }
    finally { pending.current = false; setBusy(false); }
  }
  useEffect(() => { refresh(); }, []);
  function edit(action, mode) {
    code.current = mode?.code ?? ''; label.current = mode?.label ?? '';
    setEditing({ action, code: code.current, label: label.current }); setMessage(null);
  }
  async function change(action, selectedCode, selectedLabel) {
    if (pending.current || !catalogue) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const result = await invoke('changeFailureMode', { action, code: selectedCode,
        ...(selectedLabel !== undefined ? { label: selectedLabel } : {}), expectedVersion: catalogue.version });
      if (!result?.modes) {
        setMessage({ appearance: 'error', text: result?.error || 'The catalogue was not saved. Check Jira administrator permission and refresh.' });
        return;
      }
      setCatalogue(result); setEditing(null);
      setMessage({ appearance: 'success', text: 'Failure-mode catalogue saved. Refresh open issue panels to load the current list.' });
    } catch { setMessage({ appearance: 'error', text: 'Save could not be confirmed. Refresh the catalogue before retrying.' }); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Stack space="space.200">
    <Heading size="small" as="h2">Failure-mode catalogue</Heading>
    <Text>Site-wide codes are stable. Rename labels or deactivate codes; codes are never deleted or reused. Existing records keep their codes. Up to 50 codes, including inactive codes.</Text>
    <Button isDisabled={busy} onClick={refresh}>Refresh failure modes</Button>
    {busy && <Text>Loading or saving failure modes. Please wait.</Text>}
    {message && <SectionMessage appearance={message.appearance}><Text>{message.text}</Text></SectionMessage>}
    {catalogue && <>
      {sortFailureModes(catalogue.modes).map((mode) => <Inline key={mode.code} space="space.100" alignBlock="center" shouldWrap>
        <Text>{mode.code}</Text>
        <Text>{mode.label}</Text>
        <Lozenge appearance={mode.active ? 'success' : 'default'}>{mode.active ? 'Active' : 'Inactive'}</Lozenge>
        <ButtonGroup label={`Actions for ${mode.code}`}>
          <Button spacing="compact" appearance="subtle" isDisabled={busy} onClick={() => edit('rename', mode)}>Rename</Button>
          <Button spacing="compact" appearance="subtle" isDisabled={busy} onClick={() => change(mode.active ? 'deactivate' : 'activate', mode.code)}>
            {mode.active ? 'Deactivate' : 'Activate'}
          </Button>
        </ButtonGroup>
      </Inline>)}
      <Button isDisabled={busy || catalogue.modes.length >= 50} onClick={() => edit('add')}>Add failure mode</Button>
    </>}
    {editing && <Form key={`${editing.action}:${editing.code}`} onSubmit={() => change(editing.action, code.current, label.current)}>
      <Stack space="space.100">
        <Text>{editing.action === 'add' ? 'Add a stable code and its display label.' : `Rename the label for ${editing.code}. The code stays unchanged.`}</Text>
        <Label labelFor="mode-code">Code</Label>
        <Textfield id="mode-code" defaultValue={editing.code} isDisabled={busy || editing.action !== 'add'} maxLength={32}
          onChange={(event) => { code.current = event.target.value; setMessage(null); }} />
        <Label labelFor="mode-label">Label</Label>
        <Textfield id="mode-label" defaultValue={editing.label} isDisabled={busy} maxLength={120}
          onChange={(event) => { label.current = event.target.value; setMessage(null); }} />
        <Button type="submit" appearance="primary" isDisabled={busy}>Save failure mode</Button>
        <Button type="button" isDisabled={busy} onClick={() => setEditing(null)}>Cancel catalogue edit</Button>
      </Stack>
    </Form>}
  </Stack>;
}
