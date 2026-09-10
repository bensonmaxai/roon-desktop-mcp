import { invariant } from './errors.mjs';
import { normalizeText } from './matching.mjs';

export const INTENTS = ['navigate', 'search', 'select', 'edit', 'commit', 'delete', 'playback', 'audio'];
const WRITE_INTENTS = new Set(['edit', 'commit', 'delete', 'playback', 'audio']);
// normalizeText removes whitespace. Match authentication words in compound
// labels as well, e.g. "Change password" and "Manage Account".
const AUTH_LABEL = /(?:signin|login|logout|signout|password|authorize|deauthorize|account|登入|登出|密碼|授權|帳戶|帳號)/i;
const DELETE_LABEL = /(?:delete|remove|clearall|clearupcoming|restoredefaults|刪除|移除|清除|恢復預設|還原預設)/i;
const MODIFIERS = new Set(['ctrl', 'shift', 'alt']);
const SIMPLE_KEYS = new Set(['return', 'enter', 'tab', 'escape', 'up', 'down', 'left', 'right', 'space', 'delete', 'backspace', 'home', 'end', 'pageup', 'pagedown']);
const COMBOS = new Set([
  'ctrl+a', 'ctrl+d', 'ctrl+f', 'ctrl+e', 'ctrl+g', 'ctrl+y', 'ctrl+i', 'ctrl+left', 'ctrl+right',
  'ctrl+b', 'ctrl+j', 'ctrl+k', 'ctrl+m', 'ctrl+t', 'ctrl+up', 'ctrl+down',
  'shift+tab', 'shift+up', 'shift+down', 'shift+left', 'shift+right', 'shift+home', 'shift+end',
  'ctrl+shift+left', 'ctrl+shift+right', 'ctrl+shift+home', 'ctrl+shift+end',
]);

export function validateIntent({ intent, user_authorized = false, confirmation }, targetLabel = '') {
  invariant(INTENTS.includes(intent), 'INTENT_REQUIRED', 'Classify the intended action before sending input.');
  invariant(!AUTH_LABEL.test(normalizeText(targetLabel)), 'MANUAL_ONLY', 'Account, authentication and permission changes remain manual.');
  const destructive = intent === 'delete' || DELETE_LABEL.test(normalizeText(targetLabel));
  if (WRITE_INTENTS.has(intent) || destructive) {
    invariant(user_authorized === true, 'AUTHORIZATION_REQUIRED',
      'This action changes music data, playback or audio. The caller must first have the user\'s actual authorization for this exact scope.');
  }
  if (destructive) {
    invariant(typeof confirmation === 'string' && confirmation.trim().length >= 8,
      'CONFIRMATION_REQUIRED', 'Record the user-confirmed exact deletion/removal/reset scope at this action boundary.');
    if (targetLabel) invariant(normalizeText(confirmation).includes(normalizeText(targetLabel)),
      'CONFIRMATION_MISMATCH', 'The destructive confirmation does not name the resolved visible target.');
  }
  return { intent, destructive, authorization_required: WRITE_INTENTS.has(intent) || destructive,
    basis: 'caller_declared_intent_and_visible_label',
    limitation: 'Canvas action semantics and actual user consent cannot be independently inferred by this server.' };
}

export function validatePoint(point, snapshot) {
  invariant(point && Number.isFinite(point.x) && Number.isFinite(point.y), 'INVALID_POINT', 'Provide finite screenshot coordinates.');
  invariant(point.x >= 0 && point.y >= 32 && point.x < snapshot.width && point.y < snapshot.height,
    'OUTSIDE_ROON_CONTENT', 'The target must be inside the observed Roon content, below the Windows title bar.');
  return { x: point.x, y: point.y };
}

export function validateKeys(keys, action) {
  invariant(Array.isArray(keys) && keys.length >= 1 && keys.length <= 4, 'INVALID_KEYS', 'Provide one key, or a supported Roon/editor shortcut.');
  const normalized = keys.map(key => String(key).toLowerCase().replace(/^control$/, 'ctrl').replace(/^esc$/, 'escape'));
  invariant(normalized.every(key => !/^(win|windows|meta|super|cmd|os)$/i.test(key)), 'KEY_DENIED', 'System shortcuts are not exposed.');
  if (normalized.length === 1) {
    invariant(SIMPLE_KEYS.has(normalized[0]), 'KEY_DENIED', 'Use type_text for literal text; this key is not in the Roon navigation allowlist.');
  } else {
    invariant(normalized.slice(0, -1).every(key => MODIFIERS.has(key)) && COMBOS.has(normalized.join('+')),
      'KEY_DENIED', 'This shortcut is outside the documented Roon/editor allowlist. Clipboard, shell and window-switching shortcuts are not exposed.');
  }
  const combo = normalized.join('+');
  if (['space', 'ctrl+j', 'ctrl+k', 'ctrl+t'].includes(combo)) {
    invariant(action.intent === 'playback' && action.user_authorized === true, 'PLAYBACK_AUTHORIZATION', 'This shortcut changes playback.');
  }
  if (['ctrl+m', 'ctrl+up', 'ctrl+down'].includes(combo)) {
    invariant(action.intent === 'audio' && action.user_authorized === true, 'AUDIO_AUTHORIZATION', 'This shortcut changes mute or volume.');
  }
  if (combo === 'ctrl+b') invariant(action.user_authorized === true, 'AUTHORIZATION_REQUIRED', 'Adding a bookmark needs authorization.');
  if (combo === 'delete') validateIntent({ ...action, intent: 'delete' }, 'delete');
  return normalized;
}

export function validateText(text) {
  invariant(typeof text === 'string' && text.length > 0 && text.length <= 8000, 'INVALID_TEXT', 'Provide 1–8000 characters of explicit text.');
  invariant(!/[\u0000-\u001f\u007f]/u.test(text), 'CONTROL_CHARACTER', 'Use separate key actions for control keys; text input must contain only literal text.');
  return text;
}

export function validateModifiers(modifiers = []) {
  invariant(Array.isArray(modifiers) && modifiers.length <= 2 && modifiers.every(m => ['ctrl', 'shift'].includes(m)),
    'INVALID_MODIFIERS', 'Mouse modifiers are limited to ctrl/shift selection.');
  return modifiers;
}
