import { invariant } from './errors.mjs';

export function normalizeText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('en-US');
}

export function containsPoint(region, x, y) {
  return !region || (x >= region.x && y >= region.y && x <= region.x + region.width && y <= region.y + region.height);
}

export function findText(snapshot, { text, exact = true, region, source = 'any' }) {
  const needle = normalizeText(text);
  invariant(needle.length > 0, 'EMPTY_TARGET', 'Provide non-empty visible target text.');
  const candidates = [];
  if (source !== 'ocr') {
    for (const element of snapshot.elements || []) {
      if (!element.frame || !element.label || element.enabled === false) continue;
      const bounds = element.local_bounds;
      if (bounds) candidates.push({ text: element.label, bounds, source: 'uia', element_index: element.element_index });
    }
  }
  if (source !== 'uia') {
    for (const line of snapshot.ocr?.lines || []) {
      if (line.bounds) candidates.push({ text: line.text, bounds: line.bounds, source: 'ocr' });
      for (const word of line.words || []) {
        if (word.bounds) candidates.push({ text: word.text, bounds: word.bounds, source: 'ocr' });
      }
    }
  }
  const matches = candidates.filter(candidate => {
    const value = normalizeText(candidate.text);
    const { x, y, width, height } = candidate.bounds;
    return (exact ? value === needle : value.includes(needle)) && containsPoint(region, x + width / 2, y + height / 2);
  });
  // A one-word OCR line and its word describe the same on-screen target.
  return matches.filter((candidate, index) => !matches.slice(0, index).some(previous =>
    normalizeText(previous.text) === normalizeText(candidate.text) &&
    Math.abs(previous.bounds.x - candidate.bounds.x) < 4 &&
    Math.abs(previous.bounds.y - candidate.bounds.y) < 4));
}

export function resolveText(snapshot, query) {
  const matches = findText(snapshot, query);
  invariant(matches.length !== 0, 'TARGET_NOT_FOUND', 'The requested text is not uniquely visible. Scroll, inspect the image, or provide a smaller region.', { text: query.text });
  invariant(matches.length === 1, 'AMBIGUOUS_TARGET', 'Several visible targets match. Supply a bounding region; no click was sent.', { matches });
  const match = matches[0];
  return { ...match, x: match.bounds.x + match.bounds.width / 2, y: match.bounds.y + match.bounds.height / 2 };
}

export function visibleText(snapshot) {
  return (snapshot.ocr?.text || '') + '\n' + (snapshot.elements || []).map(e => e.label || '').join('\n');
}

export function verifyText(snapshot, expectation) {
  if (!expectation) return { status: 'not_requested' };
  const candidates = [
    ...(snapshot.ocr?.lines || []).map(line => normalizeText(line.text)),
    ...(snapshot.elements || []).map(element => normalizeText(element.label)),
  ];
  const has = text => candidates.some(candidate => candidate.includes(normalizeText(text)));
  const present = (expectation.contains || []).map(text => ({ text, matched: has(text) }));
  // OCR misses are not proof that a label (or an object in a virtualized list)
  // does not exist. Report negative observations without elevating them to a
  // passing assertion, even if other positive labels matched.
  const absent = (expectation.absent || []).map(text => ({ text, matched: false, observation: has(text) ? 'still_visible' : 'not_observed' }));
  const checks = [...present, ...absent];
  const missingEvidence = snapshot.ocr?.available !== true && snapshot.elements_complete !== true && present.some(check => !check.matched);
  return {
    status: absent.length || missingEvidence ? 'inconclusive' : (checks.length > 0 && checks.every(check => check.matched) ? 'matched' : 'not_matched'),
    kind: 'visible_text_only', checks,
    note: 'Text presence is UI evidence, not proof of saved track identities, ordering, DSP values or other hidden state.',
  };
}
