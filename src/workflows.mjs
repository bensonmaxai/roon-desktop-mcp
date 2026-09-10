const HELP = Object.freeze({
  playlists: 'https://help.roonlabs.com/portal/en/kb/articles/playlists',
  profiles: 'https://help.roonlabs.com/portal/en/kb/articles/profiles',
  tags: 'https://help.roonlabs.com/portal/en/kb/articles/tags',
  queue: 'https://help.roonlabs.com/portal/en/kb/articles/the-queue',
  muse: 'https://help.roonlabs.com/portal/en/kb/articles/muse',
  audio: 'https://help.roonlabs.com/portal/en/kb/articles/audio-setup-basics',
  shortcuts: 'https://help.roonlabs.com/portal/en/kb/articles/keyboard-shortcuts',
});

const GUIDED_ONLY = 'This recipe is agent-assisted and unverified. Use only fresh Roon-window observations and observed primitives; do not report a saved result from input delivery alone.';
const REPLAY_GUARD = 'Reserve the action in the persisted operation journal first. An identical request is never blindly replayed after a dispatched or unknown outcome; reconcile it from fresh observation.';
const TARGET_PROFILE = 'For a permanent Roon playlist write, confirm the active Roon profile exactly matches the intended user-authorized target profile immediately before commit; otherwise stop.';
const MANIFEST_IDENTITY = 'exact title, artist, album, version, and source, plus a stable item or queue key when Roon exposes one';
const EXPECTED_INPUT_MANIFEST = `Resolve the requested input into a full ordered manifest before creation, recording ${MANIFEST_IDENTITY}.`;
const EXISTING_TARGET_MANIFEST_BEFORE = `Capture the full ordered existing target playlist manifest before commit, recording ${MANIFEST_IDENTITY}.`;
const EXISTING_TARGET_MANIFEST_AFTER = `Capture the full ordered target playlist manifest after commit, recording ${MANIFEST_IDENTITY}, then compare it with the applicable before or expected manifest.`;
const PLAYLIST_AUTHORITY_GUARD = 'If a create/copy/rename destination collides, or the requested action would overwrite, remove, or delete existing playlist state, verify that the request already explicitly authorizes that exact target; otherwise get destructive confirmation before commit.';
const QUEUE_PRESERVATION = 'Observe active playback and the full current queue first. Never infer permission to clear active playback or existing queue entries.';

function stage(id, instruction, commit, verify) {
  return { id, instruction, commit, verify };
}

function guided({ id, title, category, prerequisites = [], stages, success_evidence, reconcile, sources, mutates = false }) {
  return deepFreeze({
    id,
    title,
    category,
    support: 'guided_unverified',
    execution: 'agent_assisted',
    automatic: false,
    mutates,
    prerequisites: [GUIDED_ONLY, ...prerequisites],
    stages,
    success_evidence,
    reconcile,
    sources,
  });
}

function navigation({ id, title, category = 'navigation', prerequisites = [], action, verify, sources = [HELP.shortcuts] }) {
  return guided({
    id,
    title,
    category,
    prerequisites,
    stages: [
      stage('observe', 'Take a fresh Roon-only observation and identify exactly one visible target.', false,
        ['Fresh Roon window generation is recorded.', 'Target is unique in the observed window.']),
      stage('act', action, false, verify),
      stage('confirm', 'Observe the resulting Roon view again; do not infer a result from input acknowledgement.', false, verify),
    ],
    success_evidence: verify,
    reconcile: ['If the target view is not visible, inspect the fresh observation and stop; do not repeat the input from a stale snapshot.'],
    sources,
  });
}

function mutation({
  id, title, category, prerequisites = [], preparation = [], commitInstruction,
  afterVerify, sources, playlist = false, playlistManifest, playlistAuthority = false, playlistAfter = true, queue = false,
}) {
  const checklist = [REPLAY_GUARD, ...prerequisites];
  if (playlist) {
    checklist.push(TARGET_PROFILE);
    if (playlistManifest === 'expected_input') checklist.push(EXPECTED_INPUT_MANIFEST);
    if (playlistManifest === 'existing_target') checklist.push(EXISTING_TARGET_MANIFEST_BEFORE);
    if (playlistManifest === 'existing_and_input') checklist.push(EXISTING_TARGET_MANIFEST_BEFORE, EXPECTED_INPUT_MANIFEST);
    if (playlistManifest === 'two_existing_targets') checklist.push(`Capture full ordered manifests for both existing source and destination playlists before commit, recording ${MANIFEST_IDENTITY}.`);
    if (playlistAuthority) checklist.push(PLAYLIST_AUTHORITY_GUARD);
  }
  if (queue) checklist.push(QUEUE_PRESERVATION);
  return guided({
    id,
    title,
    category,
    mutates: true,
    prerequisites: checklist,
    stages: [
      stage('observe-before', 'Take a fresh Roon-only observation of the exact affected items and relevant surrounding state.', false,
        ['Affected targets are uniquely identified from a fresh observation.']),
      ...preparation.map((item, index) => stage(`prepare-${index + 1}`, item, false,
        ['Requested target and scope still match the fresh observation.'])),
      stage('commit', commitInstruction, true,
        ['Input delivery is recorded only as dispatch evidence; it is not success evidence.']),
      stage('verify-after', playlist && playlistAfter ? EXISTING_TARGET_MANIFEST_AFTER : 'Take a fresh Roon-only observation and compare the requested change with the observed result.', false,
        afterVerify),
    ],
    success_evidence: afterVerify,
    reconcile: [
      'If delivery times out, is rejected, or the result is ambiguous, record the outcome as unknown in the operation journal.',
      'Re-observe the exact affected state before any further action; reconcile to confirmed, unchanged, or refused with explicit safe evidence.',
    ],
    sources,
  });
}

export const WORKFLOWS = Object.freeze([
  navigation({
    id: 'navigation.go', title: 'Navigate to a Roon section', action: 'Use a newly observed navigation label or keyboard shortcut to open the requested section.',
    verify: ['Requested section label is visible in a fresh Roon observation.'],
  }),
  navigation({
    id: 'search.global', title: 'Search the Roon library', action: 'Focus the observed Roon search control, enter the requested query through an observed input step, and wait for visible results.',
    verify: ['Fresh observation shows the requested search context and visible result area.'],
  }),
  navigation({
    id: 'filter.library', title: 'Filter the Roon library', category: 'library', action: 'Use one observed filter control and preserve the selected filter name in the operation context.',
    verify: ['Fresh observation shows the requested filter as active.', 'Visible results are consistent with the active filter.'],
  }),
  navigation({
    id: 'bookmark.open', title: 'Open a Roon bookmark', action: 'Select exactly one observed bookmark entry.',
    verify: ['Fresh observation shows the bookmarked destination.'],
  }),
  mutation({
    id: 'bookmark.create', title: 'Create a Roon bookmark', category: 'navigation',
    prerequisites: ['Confirm the current view is the requested bookmark target and validate the requested bookmark name without persisting typed content in the journal.'],
    commitInstruction: 'Use the observed bookmark command for the requested name and target.',
    afterVerify: ['Fresh observation shows one bookmark matching the intended target.', 'No other bookmark was replaced or removed.'],
    sources: [HELP.shortcuts],
  }),
  mutation({
    id: 'bookmark.remove', title: 'Remove a Roon bookmark', category: 'navigation',
    prerequisites: ['Show the exact existing bookmark and verify the request explicitly authorizes its removal; otherwise get destructive confirmation.'],
    commitInstruction: 'Use the observed remove command for the requested bookmark only.',
    afterVerify: ['Fresh observation no longer shows the confirmed bookmark.', 'Other visible bookmarks remain unchanged.'],
    sources: [HELP.shortcuts],
  }),
  navigation({
    id: 'profile.switch', title: 'Switch Roon profile', category: 'profiles',
    prerequisites: ['Observe the current profile and the exact target profile first.'],
    action: 'Select the observed target profile; this recipe does not alter sign-in, security, or account settings.',
    verify: ['Fresh observation identifies the requested active profile.'], sources: [HELP.profiles],
  }),

  mutation({
    id: 'library.add', title: 'Add an item to the Roon library', category: 'library',
    prerequisites: ['Confirm the exact item identity from fresh visible metadata before commit.'],
    commitInstruction: 'Use the observed library-add control for the confirmed item only.',
    afterVerify: ['Fresh observation indicates the intended item is in the library.', 'No unrelated item was added.'],
    sources: [HELP.shortcuts],
  }),
  mutation({
    id: 'library.remove', title: 'Remove an item from the Roon library', category: 'library',
    prerequisites: ['Show the exact item identity and verify the request explicitly authorizes its removal; otherwise get destructive confirmation.'],
    commitInstruction: 'Use the observed library-remove control for the requested item only.',
    afterVerify: ['Fresh observation indicates the confirmed item is no longer in the library.', 'No unrelated library item changed.'],
    sources: [HELP.shortcuts],
  }),
  mutation({
    id: 'library.favorite', title: 'Set a Roon library favorite', category: 'library',
    prerequisites: ['Confirm the exact item identity and whether the requested end state is favorite or not favorite.'],
    commitInstruction: 'Use the observed favorite control once, then stop for verification.',
    afterVerify: ['Fresh observation shows the requested favorite state for the confirmed item.'],
    sources: [HELP.shortcuts],
  }),
  mutation({
    id: 'library.metadata.edit', title: 'Edit Roon library metadata', category: 'library',
    prerequisites: ['Validate the exact item and each requested metadata field against the request. Do not persist typed metadata content in the journal.'],
    commitInstruction: 'Use only observed metadata fields for the requested values.',
    afterVerify: ['Fresh observation shows the requested metadata fields for the confirmed item.', 'No unrequested field change is visible.'],
    sources: [HELP.shortcuts],
  }),

  mutation({
    id: 'playlist.create', title: 'Create a Roon playlist', category: 'playlists', playlist: true,
    playlistManifest: 'expected_input', playlistAuthority: true,
    prerequisites: ['Check whether the requested playlist name already exists.'],
    commitInstruction: 'Create exactly one playlist with the requested name. On a collision, do not overwrite or merge unless the request explicitly authorizes that exact target or destructive confirmation is obtained.',
    afterVerify: ['Fresh observation shows exactly one intended playlist.', `Full ordered playlist manifest matches the resolved expected input by ${MANIFEST_IDENTITY} and order.`],
    sources: [HELP.playlists, HELP.profiles],
  }),
  mutation({
    id: 'playlist.add', title: 'Add tracks to a Roon playlist', category: 'playlists', playlist: true,
    playlistManifest: 'existing_and_input',
    prerequisites: ['Identify the exact destination playlist and exact source tracks from fresh observations.'],
    commitInstruction: 'Add only the requested resolved input tracks to the requested playlist once.',
    afterVerify: ['Full ordered before/after target manifests show only the requested additions.', `Every entry is compared by ${MANIFEST_IDENTITY} and order.`],
    sources: [HELP.playlists, HELP.profiles],
  }),
  mutation({
    id: 'playlist.remove', title: 'Remove tracks from a Roon playlist', category: 'playlists', playlist: true,
    playlistManifest: 'existing_target', playlistAuthority: true,
    prerequisites: ['Identify every exact target track and its current position in the full ordered manifest.'],
    commitInstruction: 'Remove only the requested entries from the requested playlist.',
    afterVerify: ['Full ordered before/after target manifests show only the requested removals.', `Every remaining entry retains ${MANIFEST_IDENTITY} and order.`],
    sources: [HELP.playlists, HELP.profiles],
  }),
  mutation({
    id: 'playlist.reorder', title: 'Reorder tracks in a Roon playlist', category: 'playlists', playlist: true,
    playlistManifest: 'existing_target',
    prerequisites: ['Capture current and requested positions for every moved track.'],
    commitInstruction: 'Perform one observed reorder for the requested playlist and stop for comparison.',
    afterVerify: ['Full ordered before/after target manifests show the requested order and no unrequested membership change.', `Every entry is compared by ${MANIFEST_IDENTITY} and order.`],
    sources: [HELP.playlists, HELP.profiles],
  }),
  mutation({
    id: 'playlist.rename', title: 'Rename a Roon playlist', category: 'playlists', playlist: true,
    playlistManifest: 'existing_target', playlistAuthority: true,
    prerequisites: ['Check whether the requested destination name belongs to another existing playlist.'],
    commitInstruction: 'Rename only the requested playlist to the requested destination name.',
    afterVerify: ['Fresh observation shows the requested playlist name.', `Full ordered before/after target manifests show unchanged ${MANIFEST_IDENTITY} and order for entries.`],
    sources: [HELP.playlists, HELP.profiles],
  }),
  mutation({
    id: 'playlist.copy', title: 'Copy a Roon playlist', category: 'playlists', playlist: true,
    playlistManifest: 'existing_and_input', playlistAuthority: true,
    prerequisites: ['Identify exact source and destination playlist names and check whether the destination already exists.'],
    commitInstruction: 'Copy the requested source only to the requested destination, subject to the collision authority guard.',
    afterVerify: ['Fresh observation shows the intended destination playlist.', `Full ordered manifests compare ${MANIFEST_IDENTITY} and order for source and copy.`],
    sources: [HELP.playlists, HELP.profiles],
  }),
  mutation({
    id: 'playlist.move', title: 'Move tracks between Roon playlists', category: 'playlists', playlist: true,
    playlistManifest: 'two_existing_targets', playlistAuthority: true,
    prerequisites: ['Capture complete ordered manifests for both source and destination playlists.'],
    commitInstruction: 'Move only the requested tracks between the observed source and destination playlists.',
    afterVerify: ['Full ordered before/after manifests for both playlists show only the requested move.', `Every entry is compared by ${MANIFEST_IDENTITY} and order.`],
    sources: [HELP.playlists, HELP.profiles],
  }),
  mutation({
    id: 'playlist.delete', title: 'Delete a Roon playlist', category: 'playlists', playlist: true,
    playlistManifest: 'existing_target', playlistAuthority: true, playlistAfter: false,
    prerequisites: ['Show the exact existing playlist and its full ordered manifest before deletion.'],
    commitInstruction: 'Delete only the requested playlist after the authority guard is satisfied.',
    afterVerify: ['Fresh observation no longer shows the confirmed playlist.', 'No other visible playlist or queue state changed.'],
    sources: [HELP.playlists, HELP.profiles],
  }),

  navigation({
    id: 'queue.select', title: 'Select a queue item', category: 'queue',
    prerequisites: [QUEUE_PRESERVATION], action: 'Select only the observed queue item; do not clear or replace surrounding queue entries.',
    verify: ['Fresh observation shows the requested queue selection or playback focus.', 'Existing queue entries remain visible unless the request explicitly includes a change.'],
    sources: [HELP.queue, HELP.shortcuts],
  }),
  mutation({
    id: 'queue.reorder', title: 'Reorder the Roon queue', category: 'queue', queue: true,
    prerequisites: ['Capture the full current queue order and exact requested positions.'],
    commitInstruction: 'Perform one observed reorder for the confirmed queue entries only.',
    afterVerify: ['Fresh observation shows the requested queue order.', 'Active playback and unselected queue entries are preserved.'],
    sources: [HELP.queue],
  }),
  mutation({
    id: 'queue.remove', title: 'Remove items from the Roon queue', category: 'queue', queue: true,
    prerequisites: ['Identify every requested queue entry by exact visible context and get confirmation for any currently playing item.'],
    commitInstruction: 'Remove only the explicitly confirmed queue entries.',
    afterVerify: ['Fresh observation shows only the confirmed queue removals.', 'Active playback is preserved unless it was explicitly selected.'],
    sources: [HELP.queue],
  }),
  mutation({
    id: 'queue.clear_upcoming', title: 'Clear only upcoming Roon queue items', category: 'queue', queue: true,
    prerequisites: ['Show the exact boundary between active playback and upcoming entries. If the request does not explicitly authorize clearing those upcoming entries, get destructive confirmation.'],
    commitInstruction: 'Use an observed clear-upcoming command only; never clear active playback or infer permission to clear the existing queue.',
    afterVerify: ['Fresh observation shows no confirmed upcoming items.', 'The active playback item remains intact unless separately and explicitly requested.'],
    sources: [HELP.queue],
  }),
  mutation({
    id: 'queue.save', title: 'Save the Roon queue as a playlist', category: 'queue', queue: true, playlist: true,
    playlistManifest: 'expected_input', playlistAuthority: true,
    prerequisites: [`Capture the full ordered queue input manifest with ${MANIFEST_IDENTITY} before save.`],
    commitInstruction: 'Save only the requested queue to the requested playlist destination, subject to the collision authority guard.',
    afterVerify: [`Full ordered queue and playlist manifests match by ${MANIFEST_IDENTITY} and order.`, 'Active playback and existing queue entries remain unchanged.'],
    sources: [HELP.queue, HELP.playlists, HELP.profiles],
  }),

  mutation({
    id: 'tag.create', title: 'Create a Roon tag', category: 'tags',
    prerequisites: ['Check whether the requested tag already exists and validate its exact name against the request.'],
    commitInstruction: 'Create exactly one requested tag; do not overwrite an existing tag.',
    afterVerify: ['Fresh observation shows the intended tag and no unrelated tag change.'],
    sources: [HELP.tags],
  }),
  mutation({
    id: 'tag.rename', title: 'Rename a Roon tag', category: 'tags',
    prerequisites: ['Identify the exact current tag and check whether the target name is already in use.'],
    commitInstruction: 'Rename only the requested tag to the requested destination name.',
    afterVerify: ['Fresh observation shows the requested tag name.', 'No unrelated tag changed.'],
    sources: [HELP.tags],
  }),
  mutation({
    id: 'tag.delete', title: 'Delete a Roon tag', category: 'tags',
    prerequisites: ['Show the exact tag and verify the request explicitly authorizes its deletion; otherwise get destructive confirmation.'],
    commitInstruction: 'Delete only the requested tag.',
    afterVerify: ['Fresh observation no longer shows the confirmed tag.', 'No unrelated tag changed.'],
    sources: [HELP.tags],
  }),
  mutation({
    id: 'tag.apply', title: 'Apply a Roon tag', category: 'tags',
    prerequisites: ['Identify the exact tag and every target item from fresh visible metadata.'],
    commitInstruction: 'Apply only the reviewed tag to the confirmed target items.',
    afterVerify: ['Fresh observation shows the tag on every confirmed target.', 'No unrelated target was changed.'],
    sources: [HELP.tags],
  }),
  mutation({
    id: 'tag.remove', title: 'Remove a Roon tag', category: 'tags',
    prerequisites: ['Identify the exact tag and every target item; if the request does not explicitly authorize removal, get destructive confirmation.'],
    commitInstruction: 'Remove only the requested tag from the requested target items.',
    afterVerify: ['Fresh observation no longer shows the tag on confirmed targets.', 'No unrelated tag assignment changed.'],
    sources: [HELP.tags],
  }),

  mutation({
    id: 'audio.device.setup', title: 'Set up a Roon audio device', category: 'audio',
    prerequisites: ['Observe the exact device, output zone, and current audio configuration. This workflow excludes account, sign-in, and security settings.'],
    commitInstruction: 'Change only the requested device setting through observed Roon controls.',
    afterVerify: ['Fresh observation shows the intended device configuration.', 'Playback outcome is observed separately and is not inferred from configuration input.'],
    sources: [HELP.audio],
  }),
  mutation({
    id: 'dsp.muse.configure', title: 'Configure Roon MUSE / DSP', category: 'dsp',
    prerequisites: ['Capture the current MUSE/DSP state and exact requested end state before commit.'],
    commitInstruction: 'Change only one requested MUSE/DSP setting path, then stop for verification.',
    afterVerify: ['Fresh observation shows the requested MUSE/DSP state.', 'No unrequested DSP setting change is visible.'],
    sources: [HELP.muse],
  }),
  mutation({
    id: 'dsp.filter.configure', title: 'Configure a Roon DSP filter', category: 'dsp',
    prerequisites: ['Capture current filter state, selected zone, and exact requested filter parameters without persisting typed values in the journal.'],
    commitInstruction: 'Apply only the reviewed DSP filter setting to the confirmed zone.',
    afterVerify: ['Fresh observation shows the requested filter state for the confirmed zone.', 'No unrequested DSP setting change is visible.'],
    sources: [HELP.muse],
  }),
  mutation({
    id: 'dsp.preset.save', title: 'Save a Roon DSP preset', category: 'dsp',
    prerequisites: ['Capture the current DSP state and check whether the requested preset name already exists.'],
    commitInstruction: 'Save one requested preset without overwriting an existing preset unless the request explicitly authorizes it or destructive confirmation is obtained.',
    afterVerify: ['Fresh observation shows the intended DSP preset.', 'Visible DSP state matches the reviewed configuration.'],
    sources: [HELP.muse],
  }),
  mutation({
    id: 'dsp.preset.load', title: 'Load a Roon DSP preset', category: 'dsp',
    prerequisites: ['Capture the current DSP state and identify exactly one existing preset.'],
    commitInstruction: 'Load only the confirmed preset and stop for verification.',
    afterVerify: ['Fresh observation shows the requested active preset or matching DSP state.', 'No unrequested zone changed.'],
    sources: [HELP.muse],
  }),
  mutation({
    id: 'dsp.convolution.import', title: 'Import a Roon convolution filter', category: 'dsp',
    prerequisites: ['Validate the exact local convolution file path and target zone against the request. Do not persist path or file content in the journal.'],
    commitInstruction: 'Import only the requested convolution file into the requested DSP target.',
    afterVerify: ['Fresh observation shows the intended convolution setting for the confirmed zone.', 'No unrequested DSP setting change is visible.'],
    sources: [HELP.muse],
  }),
]);

export function getWorkflow(id) {
  return typeof id === 'string' ? WORKFLOWS.find(workflow => workflow.id === id) : undefined;
}

export function listWorkflows() {
  return [...WORKFLOWS];
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
