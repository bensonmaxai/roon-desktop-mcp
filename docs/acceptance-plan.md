# Local Acceptance Plan

這是一份可重用的公開驗收範本，用來驗證本機 Roon Desktop MCP 安裝。它不代表任何特定帳號、profile、播放清單或音樂資料的驗收紀錄。

## 目標與邊界

先把本次驗收寫成可判斷的範圍：

```text
Goal: 驗證一個可丟棄的播放清單 mutation 流程能完成並讀回。
Scope: 新建測試播放清單與少量明確識別的測試曲目。
Excluded: 現有播放清單、library、Queue、playback、音量、audio、DSP、帳號與權限。
Done when: 每一步都有 fresh end-state evidence，最後只刪除測試 target。
```

使用者必須先授權這個確切範圍。該 scope 內的非破壞性階段可沿用已取得的同意；任何 remove、delete、clear 或 reset 仍要在實際動作前再次確認 exact target。若 scope 改變，先停止並取得新的授權。

## 開始前檢查

- [ ] 依 [setup guide](setup.md) 完成外部 dependencies 與 runtime provision。
- [ ] `npm run check`、`npm test` 與 readonly smoke 已通過。
- [ ] Roon Remote 是唯一操作 target，且 active profile 與使用者授權的目標一致。
- [ ] 已建立全新的可丟棄測試播放清單名稱；若名稱碰撞，停止，不覆寫或合併。
- [ ] 將少量測試曲目解析成完整有序 manifest：title、artist、album、version、source，以及 Roon 有提供時的 stable item/queue key。
- [ ] 已觀察既有 Queue 與 active playback；本計畫不允許清除或改變它們。

## 六階段播放清單檢查

| 階段 | 動作 | 成功 evidence |
| --- | --- | --- |
| 1. 建立 | 建立一張新的空測試播放清單。 | 新 frame 顯示唯一 target；不存在 collision 或未授權 overwrite。 |
| 2. 加入 | 將已解析的測試 manifest 加入 target。 | 全部項目與 order 和 expected input 相符。 |
| 3. 排序 | 執行一個明確的 reorder。 | before/after manifest 只含要求的順序差異。 |
| 4. 改名 | 將測試 target 改為事先核對過的名稱。 | target name 改變，membership 與 order 不變。 |
| 5. 移除 | 移除一個明確指定項目。 | before/after manifest 只少該項目；library source 與其他 items 未改。 |
| 6. 刪除 | 刪除同一張測試播放清單。 | target absence 被新觀察或可靠 readback 證實；其他 playlist/Queue 未改。 |

每一個 UI mutation 都要使用新的、非識別性的 `operation_id`，只送一次。若結果是 `dispatched` 或 `unknown`，先讀 `desktop_operation`、重新觀察，再用 `desktop_reconcile` 記錄 end state；不可直接重送。原始 ID 會保存在 journal，因此不得填入姓名、帳號、曲目或其他 PII。

## Foreground recovery 的額外條件

一般驗收預設 `ROON_DESKTOP_ALLOW_INPUT=0` 與 `ROON_DESKTOP_ALLOW_FOREGROUND=0`。所有 UI input（包括 `desktop_navigate`）都要先由受信任的本機操作者將 input 設為 `1`。只有 background delivery 被 driver 拒絕，或 caller 的 fresh reconciliation 確認為 `unchanged`，才可在符合既有 action scope 後啟動受限 foreground retry。

該 retry 還必須設定 `ROON_DESKTOP_ALLOW_FOREGROUND=1`，使用新的 frame，並維持同一 semantic action digest、Roon process/window generation 與一次性 permit。foreground 會影響 Windows 焦點；它不是正常操作模式。`desktop_activate` 是另一條路徑：它需要 foreground opt-in 與呼叫端宣告的使用者同意，但不會授予 foreground input permit。詳見 [operation model](operation-model.md)。

## Evidence 與結案

每個階段在本機 runtime 保留最小必要 evidence：

- 通過、未變、拒絕或未知的結論；
- 事前與事後的 manifest／設定值比對摘要；
- 授權與 destructive confirmation 是否已取得；
- 需要復原時採取的步驟與結果。

不要把截圖、operation journal、帳號資訊、typed text、完整 library metadata 或 runtime captures 加入 repository。MCP client 收到的 PNG、OCR 與 UIA 同樣可能含私人內容；只在需要協作審查時，另外產生已去識別的摘要。

## Fail-safe 結果

下列任一情況都視為未通過並停止，不把它包裝成成功：frame stale、target 不唯一、profile guard 不符、manifest 無法完整比較、寫入授權不足、delivery unknown、OCR 與畫面衝突，或任何既有 state 出現未預期變化。

驗收完成後，確認測試 target 已刪除，且公開文件只保留已去識別的範圍說明；在 [verification](verification.md) 補上與本次 build 相符的範圍說明。
