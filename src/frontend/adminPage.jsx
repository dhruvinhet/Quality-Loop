import React, { useState } from 'react';
import ForgeReconciler, { Button, Heading, Stack, Text, Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle, ModalTransition } from '@forge/react';
import { invoke } from '@forge/bridge';
import { callPage, scanRecordPages, runHealthPages } from './pageRunner';
import GettingStarted from './GettingStarted';
import { plural } from '../lib/plural';
import FailureModeCatalogue from './FailureModeCatalogue';

const call = (name, payload) => callPage(invoke, name, payload);

export function DataPage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  const [health, setHealth] = useState(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  async function checkHealth(resume = false) {
    setBusy(true);
    setMessage('Checking for orphaned app records...');
    try {
      const token = resume ? health.token : (await call('startDataHealthCheck')).token;
      setHealth((previous) => resume ? previous : { token, operation: 'scan' });
      const summary = await runHealthPages(() => call('checkOrphanPage', { token }), 'scanComplete',
        (progress) => setHealth({ token, operation: 'scan', ...progress }));
      setMessage(summary.scanComplete ? 'Data health check complete.' : 'Check paused. Resume to check the remaining records.');
    } catch { setMessage('The check could not finish. Resume this check or start a new one if it expired.'); }
    finally { setBusy(false); }
  }
  async function removeOrphans() {
    setConfirmRemoval(false);
    setBusy(true);
    const { token, found } = health;
    setHealth((previous) => ({ ...previous, operation: 'remove' }));
    setMessage('Re-checking and removing orphaned app records...');
    try {
      const summary = await runHealthPages(() => call('removeOrphanPage', { token, expectedCount: found, confirmed: true }),
        'removeComplete', (progress) => setHealth({ token, operation: 'remove', ...progress }));
      setMessage(summary.removeComplete ? `Removed ${summary.removed} orphaned ${plural(summary.removed, 'record')}. ${summary.retained} ${plural(summary.retained, 'record')} retained after re-check.`
        : 'Removal paused. Resume the confirmed removal to continue.');
    } catch { setMessage('Removal could not finish. Resume the confirmed removal; records will be re-checked.'); }
    finally { setBusy(false); }
  }
  async function find() {
    setBusy(true);
    setResult(null);
    setMessage('Checking app records for issues you can browse...');
    try {
      const scan = await call('startOrphanScan');
      const summary = { scanned: 0, backfilled: 0, backfillPending: 0 };
      await scanRecordPages(async (entity, cursor) => {
        const page = await call('findOrphanPage', { token: scan.token, entity, ...(cursor ? { cursor } : {}) });
        summary.scanned += page.scanned;
        summary.backfilled += page.backfilled;
        summary.backfillPending += page.backfillPending;
        return page;
      });
      setResult(summary);
      setMessage(summary.backfillPending ? 'Scan complete. Some index updates need another attempt; scan again.' : 'Scan complete.');
    } catch { setMessage('App records could not be checked. Refresh the page and try again.'); }
    finally { setBusy(false); }
  }
  return <Stack space="space.300">
    <GettingStarted />
    <FailureModeCatalogue />
    <Heading size="small" as="h2">Data health</Heading>
    <Text>Check stored NC and CAPA references for deleted issues. Only app-record counts are shown; issue content is not read.</Text>
    <Button isDisabled={busy} onClick={() => checkHealth()}>Check for orphaned records</Button>
    {health && typeof health.found === 'number' && <>
      <Text>{`${health.found} orphaned ${plural(health.found, 'record')} found (issues deleted)`}</Text>
      <Text>{`${plural(health.scanned, 'Record')} checked: ${health.scanned}. ${plural(health.unknown, 'Record')} with unresolved checks: ${health.unknown}.`}</Text>
      <Text>Trashed projects keep their QualityLoop data. Missing-issue records are not counted as orphaned if any project is in trash or the trash check is unavailable.</Text>
      {health.unknown > 0 && <Text>Permission denials and errors are not treated as deleted. Run another check to retry unresolved records.</Text>}
    </>}
    {health?.operation === 'scan' && !health.scanComplete && <Button isDisabled={busy} onClick={() => checkHealth(true)}>Resume orphan check</Button>}
    {health?.scanComplete && health.found > 0 && health.operation === 'scan' &&
      <Button appearance="danger" isDisabled={busy} onClick={() => setConfirmRemoval(true)}>Remove orphaned records</Button>}
    {health?.operation === 'remove' && !health.removeComplete &&
      <Button isDisabled={busy} onClick={removeOrphans}>Resume confirmed removal</Button>}
    {typeof health?.removed === 'number' && health.operation === 'remove' && <Text>{`Orphaned ${plural(health.removed, 'record')} removed: ${health.removed}.`}</Text>}
    <ModalTransition>{confirmRemoval && <Modal onClose={() => setConfirmRemoval(false)}>
      <ModalHeader><ModalTitle>Confirm orphaned record removal</ModalTitle></ModalHeader>
      <ModalBody><Text>{`Remove up to ${health.found} orphaned app ${plural(health.found, 'record')}? Each record will be re-checked and removed only if a referenced issue still returns 404 and projects in trash can be ruled out. Jira issues will not be changed.`}</Text></ModalBody>
      <ModalFooter><Button onClick={() => setConfirmRemoval(false)}>Cancel</Button>
        <Button appearance="danger" onClick={removeOrphans}>Confirm removal</Button></ModalFooter>
    </Modal>}</ModalTransition>
    <Heading size="small" as="h2">App data maintenance</Heading>
    <Text>Scan app records for NCs and CAPAs you can browse and update their legacy indexes.</Text>
    <Button isDisabled={busy} onClick={find}>Scan accessible app records</Button>
    {message && <Text>{message}</Text>}
    {result && <Text>{`Accessible app ${plural(result.scanned, 'record')} checked: ${result.scanned}. ${plural(result.backfilled, 'Index', 'Indexes')} updated: ${result.backfilled}. ${plural(result.backfillPending, 'Update')} pending: ${result.backfillPending}.`}</Text>}
  </Stack>;
}

ForgeReconciler.render(<DataPage />);
