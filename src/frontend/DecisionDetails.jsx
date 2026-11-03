import React, { useRef, useState } from 'react';
import { Button, Label, Link, Lozenge, Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle, ModalTransition, Select, Stack, Text, TextArea } from '@forge/react';
import { invoke } from '@forge/bridge';
import { REASON_CATEGORIES, STATE_LABELS, TYPE_LABELS, validateDecision, validEvidenceUrl } from '../lib/decisions';

function DecisionModal({ type, onClose, onSubmit, busy, error }) {
  const [reason, setReason] = useState('');
  const [links, setLinks] = useState('');
  const [category, setCategory] = useState(null);
  const [validation, setValidation] = useState('');
  const submit = () => {
    const payload = { type, reason, evidenceLinks: links.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      ...(type === 'NOT_RECURRENCE' ? { reasonCategory: category?.value } : {}) };
    const errors = validateDecision({ ...payload, capaId: '1', expectedVersion: 0 });
    if (Object.keys(errors).length) { setValidation(Object.values(errors).join(' ')); return; }
    onSubmit(payload);
  };
  return <Modal onClose={() => { if (!busy) onClose(); }}>
    <ModalHeader><ModalTitle>{TYPE_LABELS[type]}</ModalTitle></ModalHeader>
    <ModalBody><Stack space="space.200">
      <Text>Each new decision replaces the current state and keeps all earlier decisions in history.</Text>
      {type === 'SUPERSEDE' && <Text>Correct the explanation and evidence for the current state. The state stays the same.</Text>}
      <Label labelFor="decision-reason">Reason (required, at most 1000 characters)</Label>
      <TextArea id="decision-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} isRequired isDisabled={busy} />
      {type === 'NOT_RECURRENCE' && <>
        <Label labelFor="decision-category">Reason category (required)</Label>
        <Select inputId="decision-category" options={REASON_CATEGORIES.map((value) => ({ value,
          label: value.toLowerCase().replaceAll('_', ' ') }))} value={category} onChange={setCategory} isRequired isDisabled={busy} />
      </>}
      <Label labelFor="decision-links">Evidence links (optional, up to 5 HTTP or HTTPS URLs; one per line)</Label>
      <TextArea id="decision-links" value={links} onChange={(event) => setLinks(event.target.value)} isDisabled={busy} />
      {(validation || error) && <Text>{validation || error}</Text>}
    </Stack></ModalBody>
    <ModalFooter><Button isDisabled={busy} onClick={onClose}>Cancel</Button>
      <Button appearance="primary" isDisabled={busy} onClick={submit}>{busy ? 'Recording…' : 'Record decision'}</Button></ModalFooter>
  </Modal>;
}

export default function DecisionDetails({ match, data, readOnly, canRecover = !readOnly, ready, onChanged }) {
  const [type, setType] = useState(null);
  const [expectedVersion, setExpectedVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState('');
  const [modalError, setModalError] = useState('');
  const [followup, setFollowup] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [linkRepair, setLinkRepair] = useState(null);
  const [checkedTask, setCheckedTask] = useState(null);
  const [local, setLocal] = useState(null);
  const pairState = local && (!data?.pairState || local.version > data.pairState.version) ? local : data?.pairState;
  const decisionReady = ready && !!data?.pairState && !data.pairStateIncomplete;
  const open = (value) => {
    setExpectedVersion(pairState?.version ?? 0);
    setType(value); setModalError(''); setMessage('');
  };
  const record = async (payload) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setModalError('');
    try {
      const result = await invoke('recordDecision', { capaId: match.id, expectedVersion, ...payload });
      if (result?.conflict) {
        setLocal(result.pairState); setType(null);
        setMessage('Another decision was recorded. The current state and history have been reloaded. Review them before recording a new decision.');
        onChanged(); return;
      }
      if (!result?.success) {
        setModalError(result?.error || Object.values(result?.fieldErrors ?? {}).join(' ') || 'The decision was not recorded. Check your issue access.'); return;
      }
      setLocal(result.pairState); setType(null); setMessage('Recorded.'); onChanged();
      if (payload.type === 'CONCERN') {
        const proposal = await invoke('prepareConcernTask', { capaId: match.id, decisionId: result.decision.id });
        if (proposal?.confirmation) setFollowup({ ...proposal, decisionId: result.decision.id });
        else setMessage(proposal?.message || proposal?.error || 'Recorded. Follow-up is unavailable. Ask the CAPA owner to review.');
      }
    } catch {
      // An interrupted bridge response may follow a committed transaction.
      setMessage('The response could not be read. Refresh history before recording another decision.'); setType(null); onChanged();
    } finally { busyRef.current = false; setBusy(false); }
  };
  const createTask = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const result = await invoke('createConcernTask', { capaId: match.id, decisionId: followup.decisionId, confirmation: followup.confirmation });
      setMessage(result?.message || result?.error || 'Recorded. Follow-up is unavailable. Check your issue access.');
    } catch { setMessage('Recorded. Follow-up response was interrupted. Check Jira before creating another task.'); }
    finally { setFollowup(null); busyRef.current = false; setBusy(false); onChanged(); }
  };
  const checkTask = async (decisionId) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage(''); setCheckedTask(null);
    try {
      const result = await invoke('checkConcernTask', { capaId: match.id, decisionId });
      if (result?.task) {
        setCheckedTask(result.task);
        if (canRecover) setRecovery({ ...result, decisionId });
        else setMessage('One visible task was found. Open the QualityLoop panel to confirm recording its key.');
      } else setMessage(result?.message || result?.error || 'The task search is unavailable with your current issue access.');
    } catch { setMessage('The task search could not finish. Check again later; another task will not be created.'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const confirmTask = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const result = await invoke('confirmConcernTask', { capaId: match.id, decisionId: recovery.decisionId,
        taskId: recovery.task.id, confirmation: recovery.confirmation });
      setMessage(result?.message || result?.error || 'Recovery is unavailable with your current issue access.');
    } catch { setMessage('The recovery response was interrupted. Refresh history before confirming again.'); }
    finally { setRecovery(null); busyRef.current = false; setBusy(false); onChanged(); }
  };
  const prepareRepair = async (decisionId) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage('');
    try {
      const result = await invoke('prepareRepairLink', { capaId: match.id, decisionId });
      if (result?.confirmation) setLinkRepair({ ...result, decisionId });
      else setMessage(result?.message || result?.error || 'Link repair is unavailable with your current issue access.');
    } catch { setMessage('The link repair proposal could not be loaded. Refresh history and try again.'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const repairLink = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const result = await invoke('repairConcernLink', { capaId: match.id, decisionId: linkRepair.decisionId, confirmation: linkRepair.confirmation });
      setMessage(result?.message || result?.error || 'Link repair is unavailable with your current issue access.');
    } catch { setMessage('The verification response was interrupted. Refresh history and use Verify link again; another task will not be created.'); }
    finally { setLinkRepair(null); busyRef.current = false; setBusy(false); onChanged(); }
  };
  const eligible = data?.concernAllowed ?? (pairState?.state === 'CONFIRMED' || !match.effectivenessEvidenceUrl?.trim());
  return <Stack space="space.100">
    <Text><Lozenge>{pairState ? STATE_LABELS[pairState.state] : 'Decision state unavailable'}</Lozenge></Text>
    {data?.confirmedCountUnavailable ? <Text>Count unavailable — refresh to try again</Text>
      : data && <Text>{`NCs currently confirmed as recurrences of this CAPA: ${data.confirmedCount}${data.confirmedCountIncomplete && data.confirmedCount !== '50+' ? '+ (limited check; total unavailable)' : ''} (may take a few seconds to update)`}</Text>}
    {!data && <Text>Decision state and history are loading or unavailable.</Text>}
    {!readOnly && <>
      <Button isDisabled={!decisionReady || busy} onClick={() => open('CONFIRM')}>Engineer-confirmed recurrence</Button>
      <Button isDisabled={!decisionReady || busy} onClick={() => open('NOT_RECURRENCE')}>Not a recurrence</Button>
      <Button isDisabled={!decisionReady || busy || !eligible} onClick={() => open('CONCERN')}>Effectiveness concern</Button>
      {!eligible && <Text>Record an Engineer-confirmed recurrence first. An Effectiveness concern can also be recorded when no effectiveness evidence is present.</Text>}
      {!!pairState?.version && <Button isDisabled={!decisionReady || busy} onClick={() => open('SUPERSEDE')}>Correct explanation</Button>}
    </>}
    {message && <Text>{message}</Text>}
    {checkedTask && <Text>Found task: <Link href={`/browse/${encodeURIComponent(checkedTask.key)}`}>{checkedTask.key}</Link></Text>}
    <Text>Decision history</Text>
    {data?.historyIncomplete && <Text>Older decisions not shown</Text>}
    {data && !data.historyIncomplete && !data.history.length && <Text>No decisions recorded.</Text>}
    {(data?.history ?? []).map((item) => <Stack key={item.id} space="space.050">
      <Text>{`${item.authorDisplayName} · ${item.createdAt.slice(0, 10)} · ${TYPE_LABELS[item.type] ?? item.type}${item.id === pairState?.latestDecisionId ? ' · Latest' : ''}`}</Text>
      <Text>{item.reason}</Text>
      {item.reasonCategory && <Text>{`Category: ${item.reasonCategory.toLowerCase().replaceAll('_', ' ')}`}</Text>}
      {(item.evidenceLinks ?? []).filter(validEvidenceUrl).map((url, i) => <Text key={`${i}:${url}`}><Link href={url} openNewTab>{url}</Link></Text>)}
      {item.taskKey && <Text>Re-review task: <Link href={`/browse/${encodeURIComponent(item.taskKey)}`}>{item.taskKey}</Link></Text>}
      {item.taskKey && !item.taskLinked && <Button isDisabled={busy || !canRecover} onClick={() => prepareRepair(item.id)}>Verify link</Button>}
      {item.followupUnconfirmed && <>
        <Text>A follow-up was started but not confirmed.</Text>
        <Button isDisabled={busy} onClick={() => checkTask(item.id)}>Check for task</Button>
      </>}
    </Stack>)}
    <ModalTransition>
      {type && <DecisionModal key={type} type={type} onClose={() => setType(null)} onSubmit={record} busy={busy} error={modalError} />}
      {followup && <Modal onClose={() => { if (!busy) setFollowup(null); }}>
        <ModalHeader><ModalTitle>Confirm follow-up task</ModalTitle></ModalHeader>
        <ModalBody><Stack space="space.100"><Text>The concern is recorded. Confirm these Jira writes:</Text><Text>{followup.confirmation}</Text></Stack></ModalBody>
        <ModalFooter><Button isDisabled={busy} onClick={() => setFollowup(null)}>Keep decision only</Button>
          <Button appearance="primary" isDisabled={busy} onClick={createTask}>{busy ? 'Creating…' : 'Create task and link'}</Button></ModalFooter>
      </Modal>}
      {recovery && <Modal onClose={() => { if (!busy) setRecovery(null); }}>
        <ModalHeader><ModalTitle>Confirm follow-up recovery</ModalTitle></ModalHeader>
        <ModalBody><Stack space="space.100"><Text>{recovery.confirmation}</Text>
          <Text><Link href={`/browse/${encodeURIComponent(recovery.task.key)}`}>{recovery.task.key}</Link></Text>
        </Stack></ModalBody>
        <ModalFooter><Button isDisabled={busy} onClick={() => setRecovery(null)}>Cancel</Button>
          <Button appearance="primary" isDisabled={busy} onClick={confirmTask}>Confirm task key</Button></ModalFooter>
      </Modal>}
      {linkRepair && <Modal onClose={() => { if (!busy) setLinkRepair(null); }}>
        <ModalHeader><ModalTitle>Confirm link verification</ModalTitle></ModalHeader>
        <ModalBody><Text>{linkRepair.confirmation}</Text></ModalBody>
        <ModalFooter><Button isDisabled={busy} onClick={() => setLinkRepair(null)}>Cancel</Button>
          <Button appearance="primary" isDisabled={busy} onClick={repairLink}>Confirm verification</Button></ModalFooter>
      </Modal>}
    </ModalTransition>
  </Stack>;
}
