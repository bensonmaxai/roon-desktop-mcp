import { findText } from './matching.mjs';
import { invariant } from './errors.mjs';

const nav = (labels, options = {}) => ({ labels, support: 'guided', ...options });
export const ROUTES = {
  home: nav(['主頁', '首頁', 'Home'], { sidebar: true }),
  genres: nav(['音樂類型', 'Genres'], { sidebar: true }),
  tidal: nav(['TIDAL'], { sidebar: true }),
  kkbox: nav(['KKBOX'], { sidebar: true }),
  internet_radio: nav(['直播網路電台', 'Internet Radio'], { sidebar: true }),
  listen_later: nav(['稍後聆聽', 'Listen Later'], { sidebar: true }),
  tags: nav(['標籤', 'Tags'], { sidebar: true }),
  albums: nav(['專輯', 'Albums'], { sidebar: true }),
  artists: nav(['藝術家', 'Artists'], { sidebar: true }),
  tracks: nav(['曲目', 'Tracks'], { sidebar: true }),
  composers: nav(['作曲家', 'Composers'], { sidebar: true }),
  compositions: nav(['作品集', 'Compositions'], { sidebar: true }),
  my_radio: nav(['我的直播電台', 'My Live Radio'], { sidebar: true }),
  music_folders: nav(['音樂資料夾', 'Folders'], { sidebar: true }),
  playlists: nav(['播放清單', 'Playlists'], { sidebar: true }),
  settings: nav([], { icon_hint: 'The settings cog beside the Roon logo; provide its current screenshot target.' }),
  'settings.general': nav(['一般', 'General']),
  'settings.storage': nav(['儲存位置', 'Storage']),
  'settings.services': nav(['服務', 'Services']),
  'settings.setup': nav(['設定', 'Setup']),
  'settings.arc': nav(['Roon ARC']),
  'settings.profiles': nav(['個人檔案', 'Profiles']),
  'settings.playback': nav(['播放模式', 'Playback']),
  'settings.library': nav(['音樂資料庫', 'Library']),
  'settings.audio': nav(['音訊裝置', '音訊', 'Audio']),
  'settings.extensions': nav(['擴充功能', 'Extensions']),
  'settings.about': nav(['關於', 'About']),
  muse: nav(['MUSE', 'DSP Engine', 'DSP 引擎']),
  device_setup: nav(['裝置設定', 'Device Setup']),
  profile_picker: nav([], { icon_hint: 'The current-profile avatar; provide its current screenshot target.' }),
  zone_picker: nav([], { icon_hint: 'The current zone button in the transport footer; provide its current screenshot target.' }),
  search: nav([], { keys: ['ctrl', 'f'] }),
  queue: nav([], { keys: ['ctrl', 'e'] }),
  history: nav([], { keys: ['ctrl', 'y'] }),
  focus: nav([], { keys: ['ctrl', 'g'] }),
  back: nav([], { keys: ['ctrl', 'left'] }),
  forward: nav([], { keys: ['ctrl', 'right'] }),
  toggle_navigation: nav([], { keys: ['tab'] }),
};

export async function navigate(controller, request) {
  const route = ROUTES[request.destination];
  invariant(route, 'UNKNOWN_DESTINATION', 'Choose a destination from desktop_navigation_routes.');
  const frame = controller.requireFrame(request.frame_id);
  let action;
  if (request.target) action = { kind: 'click', target: request.target };
  else if (route.keys) {
    // Live Roon 2.71 can treat a background Ctrl+F as a bare F. Do not
    // silently choose that unreliable transport for a semantic destination.
    if (route.keys.length > 1 && request.delivery_mode !== 'foreground') return {
      ok: false,
      error: { code: 'NAVIGATION_ANCHOR_REQUIRED', message: 'Roon may ignore background shortcut modifiers. Supply the visible icon/menu target from this frame. A deliberate shortcut probe belongs in desktop_act and must be visually verified.' },
      destination: request.destination, route, snapshot: frame,
    };
    action = { kind: 'key', keys: route.keys };
  }
  else {
    // Bounds are used only to disambiguate labels that were actually observed.
    // No icon coordinate is inferred from a remembered screen layout.
    const region = request.region || (route.sidebar
      ? { x: 0, y: 80, width: Math.min(250, frame.width * 0.24), height: frame.height - 170 }
      : request.destination.startsWith('settings.')
        ? { x: Math.min(240, frame.width * 0.15), y: 120, width: Math.min(245, frame.width * 0.19), height: frame.height - 255 }
        : undefined);
    for (const label of route.labels) {
      const matches = findText(frame, { text: label, exact: true, region, source: 'ocr' });
      if (matches.length === 1) {
        action = { kind: 'click', target: { text: label, exact: true, region, source: 'ocr' } };
        break;
      }
    }
    if (!action) return {
      ok: false, error: { code: 'NAVIGATION_ANCHOR_REQUIRED', message: route.icon_hint || 'The destination is not uniquely visible. Inspect/scroll the correct menu, or supply a target from the current image.' },
      destination: request.destination, route, snapshot: frame,
    };
  }
  return {
    ...(await controller.act({ operation_id: request.operation_id, frame_id: request.frame_id,
      intent: 'navigate', action, expect: request.expect, delivery_mode: request.delivery_mode || 'background' })),
    destination: request.destination, support: route.support,
  };
}
