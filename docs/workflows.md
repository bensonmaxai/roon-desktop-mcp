# 工作流程支援矩陣

本 server 提供 35 條 workflow。每一條都使用相同的支援標示：

```json
{ "support": "guided_unverified", "execution": "agent_assisted", "automatic": false }
```

這表示 recipe 會告訴 agent 如何觀察、準備、提交、驗證和復原；它不代表一次 tool call 就能可靠完成某個 Roon 語意操作。呼叫前先用 `desktop_workflow` 讀取指定 recipe，因為目前 Roon build、畫面、profile 和使用者授權都會影響是否可安全執行。

| 類別 | Recipe IDs | 提交後必須驗證 |
| --- | --- | --- |
| Navigation (5) | `navigation.go`, `search.global`, `bookmark.open`, `bookmark.create`, `bookmark.remove` | 目的地或書籤的實際可見狀態。 |
| Library (5) | `filter.library`, `library.add`, `library.remove`, `library.favorite`, `library.metadata.edit` | 正確 item 與資料庫 end state，不能只看按鈕反白。 |
| Profiles (1) | `profile.switch` | 新 frame 顯示預期的既有 profile。 |
| Playlists (8) | `playlist.create`, `playlist.add`, `playlist.remove`, `playlist.reorder`, `playlist.rename`, `playlist.copy`, `playlist.move`, `playlist.delete` | 完整有序 manifest 或唯一 target absence。 |
| Queue (5) | `queue.select`, `queue.reorder`, `queue.remove`, `queue.clear_upcoming`, `queue.save` | Queue 成員、順序與 active playback boundary。 |
| Tags (5) | `tag.create`, `tag.rename`, `tag.delete`, `tag.apply`, `tag.remove` | 指定 tag 與全部 target item 的實際狀態。 |
| Audio (1) | `audio.device.setup` | 實際 zone/device 值；播放結果要分開確認。 |
| DSP / MUSE (5) | `dsp.muse.configure`, `dsp.filter.configure`, `dsp.preset.save`, `dsp.preset.load`, `dsp.convolution.import` | 已保存的 zone、preset、filter 或 convolution 值。 |

## 播放清單與 Queue 的 manifest 規則

永久播放清單寫入前，recipe 會要求目前 active profile 精確符合使用者授權的目標 profile；profile guard 不符合時應停止，而不是切換或猜測 profile。

| 情境 | 提交前資料 | 提交後資料 |
| --- | --- | --- |
| `playlist.create`、`queue.save` | 將請求解析為完整、有序的 expected input manifest。 | 新 target 必須逐筆與 expected input 比對。 |
| add/remove/reorder/rename | 擷取完整既有 target manifest。 | 比對 before/after，只接受請求中的 membership、order 或 name 差異。 |
| copy | 擷取 source manifest，並將其作為新 destination 的 expected input。 | source 與 copy 的完整 manifest 比對。 |
| move | 擷取 source 與 destination 的完整 manifest。 | 兩邊 before/after 都必須只反映要求的 move。 |
| delete | 擷取完整既有 target manifest。 | 確認唯一指定 target 消失，其他 playlist/Queue 不受影響。 |

每筆 manifest 應比對 exact title、artist、album、version、source，以及 Roon 提供時的 stable item 或 queue key，並保存完整順序。建立碰撞、覆寫、改名、移除或刪除既有 state 時，若原始請求沒有明確涵蓋目標，必須在 commit boundary 取得精確的 destructive confirmation。

## 建議執行順序

1. 用 `desktop_workflow` 讀取 recipe，確認 prerequisites、commit 與 expected evidence。
2. 用 `desktop_observe` 取得最新 frame；必要時以 `desktop_find` 縮小目標。
3. 對 mutation 建立清楚的 manifest 與 scope，確認使用者是否已授權這個確切寫入。
4. 使用新的 `operation_id`，以 `desktop_act` 或 `desktop_navigate` 送出**一次**動作。
5. 取得事後 frame；資料或 audio write 還要讀回完整 end state。
6. `dispatched` 或 `unknown` 時先讀 `desktop_operation`，再用 `desktop_reconcile` 記錄已驗證結果；不要盲目重播。

## 授權與不支援範圍

workflow 本身不是授權，也不是 security sandbox。呼叫端必須如實分類 intent，並在真正取得使用者同意後才設定 `user_authorized`。raw pixel、`Return` 或 context menu 可能讓 canvas 上的動作語意無法完整從可見 label 判斷。

帳號、登入、密碼、權限與授權設定不在 workflow 範圍。Library、playlist、Queue、playback、audio 和 DSP 的 mutation 都要有明確 scope；delete、remove、clear 與 reset 還要有動作當下對應目標的確認。

## 官方說明來源

各 recipe 回傳的 `sources` 指向 Roon Help Center。常用入口包括 [Playlists](https://help.roonlabs.com/portal/en/kb/articles/playlists)、[The Queue](https://help.roonlabs.com/portal/en/kb/articles/the-queue)、[Profiles](https://help.roonlabs.com/portal/en/kb/articles/profiles)、[Tags](https://help.roonlabs.com/portal/en/kb/articles/tags)、[MUSE](https://help.roonlabs.com/portal/en/kb/articles/muse)、[Audio setup](https://help.roonlabs.com/portal/en/kb/articles/audio-setup-basics) 與 [keyboard shortcuts](https://help.roonlabs.com/portal/en/kb/articles/keyboard-shortcuts)。
