import React, { useEffect, useRef, useState } from 'react';
import { Button, Form, Heading, Label, SectionMessage, Select, Stack, Text, Textfield } from '@forge/react';
import { invoke } from '@forge/bridge';
import { LOOKBACK_OPTIONS, SEARCH_SCOPES, searchDescription, SETTINGS_PERMISSION_MESSAGE } from '../lib/searchSettings';
import { DEFAULT_REVISION_PRESET, REVISION_PRESETS } from '../config/partPattern';
import { callPage } from './pageRunner';

const WINDOWS = LOOKBACK_OPTIONS.map((value) => ({ value, label: `${value} days` }));
export default function ProjectSearchSettings() {
  const [data, setData] = useState(null);
  const [scope, setScope] = useState('PROJECT');
  const [window, setWindow] = useState(365);
  const [preset, setPreset] = useState(DEFAULT_REVISION_PRESET);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const draft = useRef({ scope: 'PROJECT', lookbackDays: 365, projectKeys: '', revisionPreset: DEFAULT_REVISION_PRESET });
  const pending = useRef(false);
  function accept(result) {
    if (!result?.settings) throw new Error(result?.error || 'Search settings are unavailable. Check project access and refresh.');
    setData(result); setScope(result.settings.scope); setWindow(result.settings.lookbackDays); setPreset(result.settings.revisionPreset ?? DEFAULT_REVISION_PRESET);
    draft.current = { scope: result.settings.scope, lookbackDays: result.settings.lookbackDays, projectKeys: result.listedProjectKeys.join(', '), revisionPreset: result.settings.revisionPreset ?? DEFAULT_REVISION_PRESET };
    setFormKey((key) => key + 1);
  }
  async function refresh() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try { accept(await callPage(invoke, 'getProjectSearchSettings')); }
    catch (error) { setMessage({ appearance: 'error', text: error.message }); }
    finally { pending.current = false; setBusy(false); }
  }
  useEffect(() => { refresh(); }, []);
  async function save() {
    if (pending.current || !data?.canAdmin) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      accept(await callPage(invoke, 'saveProjectSearchSettings', { ...draft.current,
        projectKeys: draft.current.scope === 'LISTED' ? draft.current.projectKeys : '', expectedVersion: data.settings.version }));
      setMessage({ appearance: 'success', text: 'Search settings saved. Refresh evidence on open NCs to apply them.' });
    } catch (error) { setMessage({ appearance: 'error', text: error.message }); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Stack space="space.200">
    <Heading size="small" as="h2">Search settings</Heading>
    <Text>The NC's project chooses the scope, look-back window and revision preset. Searches always use the viewing user's Jira access.</Text>
    <Button isDisabled={busy} onClick={refresh}>Refresh search settings</Button>
    {data && <>
      <Text>{searchDescription(data.settings)}</Text>
      <Text>{`Revision preset: ${REVISION_PRESETS.find((option) => option.value === (data.settings.revisionPreset ?? DEFAULT_REVISION_PRESET)).label}`}</Text>
      {data.settings.scope === 'LISTED' && <Text>{`Listed projects you can browse: ${data.listedProjectKeys.join(', ') || 'none shown'}`}</Text>}
      {!data.canAdmin && <Text>{SETTINGS_PERMISSION_MESSAGE}</Text>}
    </>}
    {data?.canAdmin && <Form key={formKey} onSubmit={save}>
      <Stack space="space.100">
        <Label labelFor="search-scope">Search CAPAs in</Label>
        <Select id="search-scope" options={SEARCH_SCOPES} value={SEARCH_SCOPES.find((option) => option.value === scope)} isDisabled={busy}
          onChange={(option) => { if (option) { draft.current.scope = option.value; setScope(option.value); setMessage(null); } }} />
        {scope === 'LISTED' && <>
          <Label labelFor="search-projects">Additional project keys</Label>
          <Textfield id="search-projects" defaultValue={draft.current.projectKeys} maxLength={2000} isDisabled={busy}
            onChange={(event) => { draft.current.projectKeys = event.target.value; setMessage(null); }} />
          <Text>Separate up to 20 keys with spaces or commas. Only listed projects you can browse are shown; saving replaces the list.</Text>
        </>}
        <Label labelFor="search-window">Look-back window</Label>
        <Select id="search-window" options={WINDOWS} value={WINDOWS.find((option) => option.value === window)} isDisabled={busy}
          onChange={(option) => { if (option) { draft.current.lookbackDays = option.value; setWindow(option.value); setMessage(null); } }} />
        <Label labelFor="revision-preset">Revision split for this project</Label>
        <Select id="revision-preset" options={REVISION_PRESETS} value={REVISION_PRESETS.find((option) => option.value === preset)} isDisabled={busy}
          onChange={(option) => { if (option) { draft.current.revisionPreset = option.value; setPreset(option.value); setMessage(null); } }} />
        <Text>Exact matches always use the whole normalised part. Related revisions may miss older bases until records are re-saved or re-indexed. Reopen capture panels after changing the preset.</Text>
        <Button type="submit" appearance="primary" isDisabled={busy}>Save search settings</Button>
      </Stack>
    </Form>}
    {busy && <Text>Loading or saving search settings. Please wait.</Text>}
    {message && <SectionMessage appearance={message.appearance}><Text>{message.text}</Text></SectionMessage>}
  </Stack>;
}
