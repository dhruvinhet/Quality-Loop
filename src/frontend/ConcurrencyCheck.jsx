import React, { useEffect, useRef, useState } from 'react';
import { Button, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import { CopyResults } from './ProbePanel';
import { runConcurrencyCheck } from './concurrencyRunner';

export default function ConcurrencyCheck({ capaId, disabled, onChanged }) {
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState([]);
  const [report, setReport] = useState('');
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async () => {
    if (busy.current) return;
    busy.current = true; setRunning(true); setRows([]); setReport('');
    try {
      const result = await runConcurrencyCheck({ invoke, capaId, cancelled: () => !alive.current,
        onRound: (row) => { if (alive.current) setRows((previous) => [...previous, row]); } });
      if (alive.current) setReport(`${result.pass ? 'PASS' : 'CHECK REQUIRED'}: ${result.successfulWrites} test successes; ${result.conflicts} conflicts; prior successful writes (starting version) ${result.startingVersion}; total successful writes ${result.totalSuccessfulWrites}; pairState.version ${result.version}; version equals total successful writes: ${result.version === result.totalSuccessfulWrites}.\n${JSON.stringify(result.rounds, null, 2)}`);
    } catch (error) { if (alive.current) setReport(error.message); }
    finally { busy.current = false; if (alive.current) { setRunning(false); onChanged(); } }
  };
  return <Stack space="space.100">
    <Text>E8 leaves 10 permanent Confirm recurrence decisions. It reports the starting version separately from new writes. Keep the panel open.</Text>
    <Button isDisabled={disabled || running} onClick={run}>{running ? 'Concurrency test running…' : 'Concurrency test'}</Button>
    {rows.map((row) => <Text key={row.round}>{`Round ${row.round}: ${row.success} success, ${row.conflict} conflict, version ${row.version} — ${row.pass ? 'pass' : 'check required'}`}</Text>)}
    {report && <><Text>{report}</Text><CopyResults text={report} /></>}
  </Stack>;
}
