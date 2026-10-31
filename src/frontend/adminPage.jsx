import React, { useState } from 'react';
import ForgeReconciler, { Button, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import PageConfirmation from './PageConfirmation';
import { callPage, scanRecordPages } from './pageRunner';

const call = (name, payload) => callPage(invoke, name, payload);

function DataPage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState(false);
  async function find() {
    setBusy(true);
    setResult(null);
    setMessage('Scanning app records and checking Jira issue existence...');
    try {
      const scan = await call('startOrphanScan');
      const summary = { scanned: 0, decision: 0, 'pair-state': 0, tokens: [], recordIds: [], missingIds: [], unknownIds: [], backfilled: 0, backfillPending: 0 };
      await scanRecordPages(async (entity, cursor) => {
        const page = await call('findOrphanPage', { token: scan.token, entity, ...(cursor ? { cursor } : {}) });
        summary.scanned += page.scanned;
        summary[entity] += page.orphanCount;
        summary.backfilled += page.backfilled;
        summary.backfillPending += page.backfillPending;
        if (page.token) summary.tokens.push(page.token);
        summary.recordIds.push(...page.recordIds.map((id) => `${entity}: ${id}`));
        summary.missingIds.push(...page.missingIds);
        summary.unknownIds.push(...page.unknownIds);
        return page;
      });
      summary.missingIds = [...new Set(summary.missingIds)].sort();
      summary.unknownIds = [...new Set(summary.unknownIds)].sort();
      summary.recordIds = [...new Set(summary.recordIds)].sort();
      setResult(summary);
      setMessage(summary.backfillPending ? 'Scan complete. Some backfills conflicted or failed; run Find orphaned records again.' : 'Scan complete. Legacy pair-state index backfill is up to date for scanned records.');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  async function remove() {
    setConfirm(false);
    setBusy(true);
    let deleted = 0;
    let retained = 0;
    try {
      for (const token of result.tokens) {
        const page = await call('deleteOrphanPage', { token, confirmed: true });
        deleted += page.deleted;
        retained += page.retained;
      }
      setMessage(`Deleted ${deleted} orphaned app records. Retained ${retained} records after fresh checks. Find orphaned records again to verify.`);
    } catch (error) { setMessage(`Deleted ${deleted} app records so far. ${error.message} Run Find orphaned records again.`); }
    finally { setResult(null); setBusy(false); }
  }
  return <Stack>
    <Text>Jira administrators can remove app records that refer to missing issues. Jira issues are never changed here. This scan also backfills legacy pair-state indexes safely.</Text>
    <Button isDisabled={busy} onClick={find}>Find orphaned records</Button>
    <Button isDisabled={busy || !result?.tokens.length} onClick={() => setConfirm(true)}>Delete orphaned records</Button>
    {message && <Text>{message}</Text>}
    {result && <Stack>
      <Text>{`Scanned app records: ${result.scanned}. Orphaned decisions: ${result.decision}. Orphaned pair-state records: ${result['pair-state']}. Backfilled: ${result.backfilled}. Backfill pending: ${result.backfillPending}.`}</Text>
      <Text>{`Missing issue/CAPA IDs: ${result.missingIds.join(', ') || 'none'}`}</Text>
      <Text>{`Unresolved issue/CAPA IDs (kept): ${result.unknownIds.join(', ') || 'none'}`}</Text>
      {result.recordIds.map((id) => <Text key={id}>{id}</Text>)}
    </Stack>}
    {confirm && <PageConfirmation title="Delete orphaned app records" lines={[
      'Delete the following decision and pair-state records from Forge hosted storage. Jira issues will not be changed. Each record is checked again before deletion.',
      ...result.recordIds,
    ]} onCancel={() => setConfirm(false)} onConfirm={remove} />}
  </Stack>;
}

ForgeReconciler.render(<DataPage />);
