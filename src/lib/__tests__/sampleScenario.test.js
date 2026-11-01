const { sampleDefinitions, removableSample, SAMPLE_LABEL, sampleCreationLines, selectSampleIssueType } = require('../sampleScenario');
const { matchCaptures } = require('../match');
const { buildCapture } = require('../capture');

test('sample type prefers Task, otherwise the first non-subtask type in metadata order', () => {
  const subtask = { id: '1', name: 'Task', subtask: true };
  const story = { id: '2', name: 'Story', subtask: false };
  const bug = { id: '3', name: 'Bug', subtask: false };
  const task = { id: '4', name: 'Task', subtask: false };
  expect(selectSampleIssueType([subtask, story, bug, task])).toBe(task);
  expect(selectSampleIssueType([subtask, story, bug])).toBe(story);
  expect(selectSampleIssueType([subtask])).toBeUndefined();
  expect(selectSampleIssueType([])).toBeUndefined();
});

test('the five isolated definitions preserve the required timeline and evidence', () => {
  const definitions = sampleDefinitions('2026-10-31');
  expect(definitions).toHaveLength(5);
  const [a, b, decoy, historical, nc] = definitions.map((definition, index) => ({ ...definition.capture, id: String(index + 1), key: definition.name }));
  expect([a.closedDate, b.closedDate, decoy.closedDate, historical.detectedDate, nc.detectedDate])
    .toEqual(['2026-10-01', '2026-09-16', '2026-10-11', '2026-09-21', '2026-10-31']);
  expect(definitions.every(({ capture }) => capture.partOriginal.startsWith('DEMO-'))).toBe(true);
  expect(matchCaptures(historical, [a, b, decoy])).toEqual({ strong: [], relatedRevision: [], otherRelated: [] });
  const result = matchCaptures(nc, [a, b, decoy]);
  expect(result.strong.map(({ key }) => key)).toEqual(['DEMO CAPA-B']);
  expect(result.relatedRevision).toEqual([]);
  expect(result.otherRelated.map(({ key }) => key)).toEqual(['DEMO decoy CAPA']);
  expect(a.effectivenessEvidenceUrl).toMatch(/^https:/);
  expect(b.effectivenessEvidenceUrl).toBe('');
  for (const capa of [a, b]) {
    expect(capa.rootCause).toBeTruthy();
    expect(capa.actionsTaken).toBeTruthy();
  }
  expect(sampleCreationLines(definitions).join(' ')).toContain('DEMO historical NC');
});

test.each(sampleDefinitions('2026-10-31'))('$name shares no supplier, line or part with non-DEMO values and cannot match them', ({ capture }) => {
  for (const field of ['supplier', 'line', 'partOriginal', 'partNorm', 'partBase']) {
    expect(capture[field]).toMatch(/^DEMO-/);
    expect(capture[field]).not.toBe(capture[field].replace(/^DEMO-/, ''));
  }
  const partNumber = capture.partOriginal.replace(/^DEMO-/, '');
  const sampleNc = { ...capture, recordType: 'NC', detectedDate: '2026-10-31' };
  const sampleCapa = { ...capture, recordType: 'CAPA', closedDate: '2026-10-01' };
  const noMatches = { strong: [], relatedRevision: [], otherRelated: [] };
  // Exercise same part, different revision and different base, with both equal
  // and different failure modes. Supplier/line keep their non-DEMO counterparts.
  for (const realPart of [partNumber, partNumber.replace(/-[A-Z]$/, '-B'), 'REAL-9999-A']) {
    for (const failureMode of [capture.failureMode, capture.failureMode === 'FM-01' ? 'FM-07' : 'FM-01']) {
      const real = buildCapture({ recordType: 'CAPA', partNumber: realPart, failureMode,
        supplier: capture.supplier.replace(/^DEMO-/, ''), line: capture.line.replace(/^DEMO-/, ''),
        closedDate: '2026-10-01' });
      for (const field of ['supplier', 'line', 'partOriginal', 'partNorm', 'partBase']) {
        expect(capture[field]).not.toBe(real[field]);
      }
      expect(matchCaptures(sampleNc, [real])).toEqual(noMatches);
      expect(matchCaptures({ ...real, recordType: 'NC', detectedDate: '2026-10-31' }, [sampleCapa])).toEqual(noMatches);
    }
  }
});

test('creation dialog lists the DEMO part, supplier and line for every sample record', () => {
  const definitions = sampleDefinitions('2026-10-31');
  const lines = sampleCreationLines(definitions);
  definitions.forEach(({ capture }, index) => {
    expect(lines[index]).toContain(`part ${capture.partOriginal}`);
    expect(lines[index]).toContain(`supplier ${capture.supplier}`);
    expect(lines[index]).toContain(`line ${capture.line}`);
  });
});

test('sample removal requires BOTH the exact stored ID and current label', () => {
  const issue = (id, labels) => ({ id, fields: { labels } });
  expect(removableSample(['12'], issue('12', [SAMPLE_LABEL]))).toBe(true);
  expect(removableSample(['12'], issue('123', [SAMPLE_LABEL]))).toBe(false);
  expect(removableSample(['12'], issue('12', ['other']))).toBe(false);
  expect(removableSample(['12'], issue('12', undefined))).toBe(false);
  expect(removableSample(['12'], null)).toBe(false);
});
