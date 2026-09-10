import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKFLOWS, getWorkflow, listWorkflows } from '../src/workflows.mjs';

test('catalog exposes the requested Roon guided workflow families without tested automation claims', () => {
  const required = [
    'navigation.go', 'search.global', 'filter.library', 'bookmark.open', 'bookmark.create', 'bookmark.remove',
    'profile.switch',
    'library.add', 'library.remove', 'library.favorite', 'library.metadata.edit',
    'playlist.create', 'playlist.add', 'playlist.remove', 'playlist.reorder', 'playlist.rename', 'playlist.copy', 'playlist.move', 'playlist.delete',
    'queue.select', 'queue.reorder', 'queue.remove', 'queue.clear_upcoming', 'queue.save',
    'tag.create', 'tag.rename', 'tag.delete', 'tag.apply', 'tag.remove',
    'audio.device.setup', 'dsp.muse.configure', 'dsp.filter.configure', 'dsp.preset.save', 'dsp.preset.load', 'dsp.convolution.import',
  ];
  const ids = WORKFLOWS.map(workflow => workflow.id);
  const officialHelpUrls = new Set([
    'https://help.roonlabs.com/portal/en/kb/articles/playlists',
    'https://help.roonlabs.com/portal/en/kb/articles/profiles',
    'https://help.roonlabs.com/portal/en/kb/articles/tags',
    'https://help.roonlabs.com/portal/en/kb/articles/the-queue',
    'https://help.roonlabs.com/portal/en/kb/articles/muse',
    'https://help.roonlabs.com/portal/en/kb/articles/audio-setup-basics',
    'https://help.roonlabs.com/portal/en/kb/articles/keyboard-shortcuts',
  ]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of required) assert.ok(ids.includes(id), `missing ${id}`);
  for (const workflow of WORKFLOWS) {
    assert.equal(workflow.support, 'guided_unverified');
    assert.equal(workflow.execution, 'agent_assisted');
    assert.equal(workflow.automatic, false);
    assert.equal('manualOnly' in workflow, false);
    assert.ok(Array.isArray(workflow.prerequisites) && workflow.prerequisites.length > 0);
    assert.ok(Array.isArray(workflow.sources) && workflow.sources.every(url => officialHelpUrls.has(url)));
    assert.ok(Array.isArray(workflow.stages) && workflow.stages.length > 0);
    for (const item of workflow.stages) {
      assert.equal(typeof item.id, 'string');
      assert.equal(typeof item.instruction, 'string');
      assert.equal(typeof item.commit, 'boolean');
      assert.ok(Array.isArray(item.verify) && item.verify.length > 0);
    }
    assert.ok(Array.isArray(workflow.success_evidence) && workflow.success_evidence.length > 0);
    assert.ok(Array.isArray(workflow.reconcile) && workflow.reconcile.length > 0);
  }
  assert.equal(WORKFLOWS.some(workflow => /auth|security|account/iu.test(workflow.id)), false);
});

test('every mutating recipe has a commit, verification, and reconciliation boundary', () => {
  const mutating = WORKFLOWS.filter(workflow => workflow.mutates);
  assert.ok(mutating.length > 0);
  for (const workflow of mutating) {
    const commit = workflow.stages.find(item => item.commit);
    assert.ok(commit, `${workflow.id} lacks a commit stage`);
    assert.ok(commit.verify.length > 0, `${workflow.id} commit has no delivery verification boundary`);
    assert.ok(workflow.stages.some(item => item.id === 'verify-after'), `${workflow.id} lacks post-commit verification`);
    assert.ok(workflow.reconcile.some(item => /reconcile|unknown|observe/iu.test(item)), `${workflow.id} lacks reconciliation guidance`);
    assert.ok(workflow.prerequisites.some(item => /operation journal|never blindly replay/iu.test(item)), `${workflow.id} lacks replay guard`);
  }
});

test('playlist writes require the exact user-authorized target profile and correct expected/existing manifest guardrails', () => {
  const playlists = WORKFLOWS.filter(workflow => workflow.category === 'playlists' || workflow.id === 'queue.save');
  assert.ok(playlists.length >= 9);
  for (const workflow of playlists) {
    const text = JSON.stringify(workflow);
    assert.match(text, /active Roon profile exactly matches the intended user-authorized target profile immediately before commit/iu, `${workflow.id} lacks target profile guard`);
    assert.doesNotMatch(text, /active Roon profile is exactly/iu, `${workflow.id} embeds a fixed profile instead of the user-authorized target`);
    assert.match(text, /exact title, artist, album, version, and source/iu, `${workflow.id} lacks full manifest identity guard`);
    assert.match(text, /stable item or queue key/iu, `${workflow.id} lacks stable manifest key guard`);
  }
  assert.match(JSON.stringify(getWorkflow('playlist.create')), /requested input.*before creation/iu);
  assert.match(JSON.stringify(getWorkflow('queue.save')), /queue input manifest/iu);
  for (const id of ['playlist.add', 'playlist.remove', 'playlist.reorder', 'playlist.rename', 'playlist.copy', 'playlist.delete']) {
    assert.match(JSON.stringify(getWorkflow(id)), /existing target playlist manifest before/iu, `${id} lacks existing target manifest`);
  }
  assert.match(JSON.stringify(getWorkflow('playlist.move')), /both existing source and destination playlists before/iu);
  for (const id of ['playlist.create', 'playlist.copy', 'playlist.rename', 'playlist.remove', 'playlist.move', 'playlist.delete']) {
    assert.match(JSON.stringify(getWorkflow(id)), /request already explicitly authorizes|destructive confirmation/iu, `${id} lacks a conditional authority guard`);
  }
  for (const id of ['playlist.add', 'playlist.reorder']) {
    assert.doesNotMatch(JSON.stringify(getWorkflow(id)), /destructive confirmation/iu, `${id} asks for unneeded destructive confirmation`);
  }
});

test('queue safety keeps active playback outside a clear-upcoming request', () => {
  const clearUpcoming = getWorkflow('queue.clear_upcoming');
  assert.ok(clearUpcoming);
  const text = JSON.stringify(clearUpcoming);
  assert.match(text, /Never infer permission to clear active playback/iu);
  assert.match(text, /clear active playback/iu);
  assert.match(text, /upcoming/iu);
});

test('lookup and listing are stable read-only catalog helpers', () => {
  assert.equal(getWorkflow('playlist.add')?.title, 'Add tracks to a Roon playlist');
  assert.equal(getWorkflow('missing.workflow'), undefined);
  const list = listWorkflows();
  assert.notEqual(list, WORKFLOWS);
  assert.equal(list.length, WORKFLOWS.length);
  assert.ok(Object.isFrozen(WORKFLOWS));
});
