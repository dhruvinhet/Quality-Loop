import React, { useRef, useState } from 'react';
import { Heading, Label, LoadingButton, Select, Stack, Text, Textfield } from '@forge/react';
import { invoke, view } from '@forge/bridge';
import { CopyResults } from './ProbePanel';
import { runSecurityTests } from './securityTestRunner';
import { formatSecurityResults } from '../lib/securitySelfTest';

const WRITE_EXPECTATIONS = [
  { value: 'browse', label: 'Browse-only user: expect 403' },
  { value: 'edit', label: 'Editor: expect successful write and restoration' },
];

export default function SecuritySelfTest() {
  const [otherIssueId, setOtherIssueId] = useState('');
  const [restrictedIssue, setRestrictedIssue] = useState('');
  const [expectedWrite, setExpectedWrite] = useState(WRITE_EXPECTATIONS[0]);
  const [rows, setRows] = useState([]);
  const [timestamp, setTimestamp] = useState('');
  const [details, setDetails] = useState('');
  const [running, setRunning] = useState(false);
  const busy = useRef(false);

  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setRows([]);
    setTimestamp(new Date().toISOString());
    try {
      const context = await view.getContext();
      const currentIssueId = String(context.extension?.issue?.id ?? '');
      if (!/^\d+$/.test(currentIssueId)) throw new Error('Current issue ID is unavailable. Reopen the issue.');
      setDetails(`Current issue: ${currentIssueId}; injected ID: ${otherIssueId}; restricted ID/key: ${restrictedIssue}; expected write: ${expectedWrite.value}`);
      await runSecurityTests({ invoke, currentIssueId, otherIssueId, restrictedIssue, expectedWrite: expectedWrite.value,
        onRow: (row) => setRows((previous) => [...previous, row]) });
    } catch (error) {
      setRows((previous) => [...previous, { check: 'Self-test setup', pass: false, detail: error.message }]);
    } finally {
      busy.current = false;
      setRunning(false);
    }
  };

  return <Stack space="space.200">
    <Heading size="small" as="h2">Security self-test</Heading>
    <Text>Developer checks run as you. Use an isolated test issue with saved quality details. The write check calls saveCapture on this issue and restores the exact previous property (or removes it if originally absent). Keep the panel open and do not edit this issue during the run.</Text>
    <Label labelFor="security-other-issue">Different issue ID for payload injection (numeric)</Label>
    <Textfield id="security-other-issue" value={otherIssueId} isDisabled={running} onChange={(event) => setOtherIssueId(event.target.value.trim())} />
    <Label labelFor="security-restricted-issue">Known restricted issue ID or key for direct read</Label>
    <Textfield id="security-restricted-issue" value={restrictedIssue} isDisabled={running} onChange={(event) => setRestrictedIssue(event.target.value.trim())} />
    <Label labelFor="security-write-expectation">Current user's expected write permission</Label>
    <Select id="security-write-expectation" options={WRITE_EXPECTATIONS} value={expectedWrite} isDisabled={running} onChange={setExpectedWrite} />
    <LoadingButton isLoading={running} isDisabled={running || !otherIssueId || !restrictedIssue} onClick={run}>Run security self-test</LoadingButton>
    {timestamp && <Text>{`Timestamp (UTC): ${timestamp}${running ? ' — running' : ''}`}</Text>}
    {rows.map((row) => <Text key={row.check}>{`${row.pass ? 'PASS' : 'FAIL'} — ${row.check}: ${row.detail}`}</Text>)}
    {rows.length > 0 && !running && <CopyResults text={formatSecurityResults(timestamp, rows, details)} />}
  </Stack>;
}
