# 操作模型、權限與復原

## 從觀察到動作的閉環

```text
desktop_status / desktop_observe
        ↓ 取得最新 Roon frame、截圖、OCR/UIA
desktop_find 或呼叫端在截圖上定位唯一目標
        ↓
desktop_act / desktop_navigate（一次動作 + operation_id）
        ↓
新的觀察、可見文字檢查、operation journal
        ↓
confirmed（有限的導航證據）或 unknown
        ↓
desktop_reconcile（呼叫端以完整 end-state 證據結案）
```

Roon canvas 使 UIA 通常只能提供有限資訊，OCR 與畫面座標是輔助定位而非語意資料庫。每個 frame 都繫結 Roon process、window、畫面與短暫 TTL；畫面漂移、視窗變更、Roon 重啟或 CUA disconnect 都會讓舊 frame 失效。

## 部署信任邊界與資料流

server 只以 stdio 連接一個受信任的本機 MCP host；它沒有 HTTP endpoint、network listener 或多使用者隔離。這些控制不是給惡意 client 的 sandbox。Windows OCR 在 server 所在機器執行，但每個 observation 的 PNG、OCR 文字與 UIA element 都會透過 MCP 回傳給 client；若 host 或 client 使用雲端模型、記錄或轉送，該資料可能離開本機。

## 工具表面與界線

| 工具 | 可否改變狀態 | 安全界線 |
| --- | ---: | --- |
| `desktop_status` | 否 | 僅回報 Roon process、window、driver binding。 |
| `desktop_open` | 啟動既有 app | 不啟動 RoonServer、不配對 extension、不播放音樂。 |
| `desktop_activate` | 帶到前景 | recovery 專用；需 foreground config opt-in、最新 frame、唯一 operation ID 與 literal `user_authorized: true`。 |
| `desktop_observe` | 否 | 僅可選已驗證的 Roon window；回傳新 frame 與 PNG。 |
| `desktop_find` | 否 | 只查目前可見 OCR/UIA，不查 library。 |
| `desktop_act` | 是 | `ROON_DESKTOP_ALLOW_INPUT=1` 後才可用；僅 click/type/key/scroll/drag/selection，一次一個動作、最新 frame、operation journal。 |
| `desktop_navigation_routes` | 否 | 列出路由及文件快捷鍵。 |
| `desktop_navigate` | 導航 | 會送 UI input，所以同樣要求 `ROON_DESKTOP_ALLOW_INPUT=1`；呼叫端提供的 target 仍是 generic click，必須核對真正目標與語意。 |
| `desktop_verify` | 否 | 只驗證可見文字，OCR absence 不具結論性。 |
| `desktop_operation` | 否 | 讀取 metadata-only operation journal。 |
| `desktop_reconcile` | 更新 journal | 接收呼叫端的已驗證 end state，不重送 UI input。 |
| `desktop_workflows` | 否 | 列出 35 條 recipe 與支援程度。 |
| `desktop_workflow` | 否 | 讀取單一 recipe；recipe 本身不授權寫入。 |

## 授權與安全性

- 觀察工具不送 input。`desktop_navigate` 宣告導航 intent，但呼叫端提供的 target 仍是 generic desktop input；它不因為導航意圖而成為 readonly，必須先有本機 `ROON_DESKTOP_ALLOW_INPUT=1` opt-in 並核對真正目標與語意。
- library、playlist、Queue、playback、audio 的變更需要使用者已明確授權該確切範圍；呼叫端必須正確分類 `intent`，且只在真有同意時設定 `user_authorized`。同一授權 scope 內的非破壞性後續步驟可沿用該授權；scope 改變才需要新的授權。
- delete、remove、clear、restore defaults 還需要動作當下能對應目標的精確確認。
- policy 的 `intent`、`user_authorized` 與 `desktop_reconcile` 的 evidence 都是 caller assertion。它們是 assistant guardrail，而不是惡意 MCP client 的 security sandbox；canvas 的 raw pixel target、`Return` 或 context menu 可能在工具無法語意辨識的 context 造成變更，這些 assertion 也無法獨立證明實際同意或 end state。
- sign-in/out、帳號、密碼、authorize/deauthorize 與權限畫面由使用者手動處理，不在 workflow 設計範圍。
- 系統快捷鍵、clipboard、shell、視窗切換快捷鍵不開放。鍵盤與 modifier 有 allowlist。
- Roon window／process 身分需與配置的 `Roon.exe` 相符；任何其他 app 都不是合法 target。
- journal 只存 action kind、request digest、generation summary 與小型安全 evidence；不存 raw typed text、截圖、token 或帳號資料。但 caller 原始提供的 `operation_id` 會原樣保留在 record，請使用隨機、非識別性 ID，不要放 PII、曲名或帳號資料。

## Input opt-in、background 與 foreground delivery

預設 `ROON_DESKTOP_ALLOW_INPUT=0` 與 `ROON_DESKTOP_ALLOW_FOREGROUND=0`。`desktop_act` 與 `desktop_navigate` 都由同一個 input controller 執行，input 未明確設為字串 `1` 時一律拒絕；導航不是 intrinsically readonly。foreground 是受控 recovery 路徑，controller 只會為先前 background 動作發出一次、預設 30 秒有效的 permit。前景 input 必須同時滿足：

1. 啟動時明確設定 `ROON_DESKTOP_ALLOW_INPUT=1` 和 `ROON_DESKTOP_ALLOW_FOREGROUND=1`。
2. 原始 background 動作在送入前被 driver 拒絕，或經 caller 以 fresh reconciliation 證實為 `unchanged`。
3. 以新的 frame 重試，且 retry 的 semantic action digest 與原始 background 動作相同。
4. retry 的 Roon process、window 與 process generation 都與 permit 相同；原 action 的既有授權 policy 仍適用。

permit 在一次 foreground dispatch 後立即消耗；到期、Roon 重啟、window 改變或 private CUA session 結束也會清除它。foreground 可能短暫把 Windows 焦點帶到 Roon。

已知 driver 限制：在測過的 public CUA interface 0.8.3，要求 background 的 drag 可能走 `global_input`。controller 因此會在 input 前拒絕 background drag；只有完全符合上述 permit 條件的 foreground retry 才可嘗試。這條保護不構成 background/no-focus drag 的相容性保證。

## `desktop_activate` recovery

`desktop_activate` 的 strict input schema 是 `{ operation_id, frame_id, user_authorized: true }`。它只適用於使用者明確同意把已觀察的 Roon 視窗帶到前景的 recovery，不能由 registered foreground flag 或 workflow 自動觸發。它的條件是 `ROON_DESKTOP_ALLOW_FOREGROUND=1` 加上 caller-declared consent；不需要 `ROON_DESKTOP_ALLOW_INPUT=1`，也不會自動取得 foreground input permit。

呼叫前 controller 會檢查最新且未過期的 frame、`allowForeground`、配置的 `Roon.exe` 路徑及該 Roon window/process generation，接著以 fresh window-state capture 驗證 target 才呼叫 driver。相同 operation ID replay 不會再次前景化；動作後會重新 observe，只有現在的 foreground window 仍與 target 相符才會確認。它不會發出或消耗任何 foreground input permit。

## Operation journal 與錯誤處理

每個 `operation_id` 先原子保留；相同 ID 與相同 request 只會回傳 replay 資訊，不會再次輸入。不同 request 共用 ID 會被拒絕。預設 journal 最多保留 `10000` 個 record，可用 `ROON_DESKTOP_MAX_OPERATIONS` 設為 `1`–`100000`；每筆 record 上限 64 KiB。`desktop_operation` 的列舉回應預設 20 筆、最多 50 筆；journal 讀取時最多同時讀 16 筆，這是內部資源上限，不是回傳筆數。

journal 到達上限時會拒絕新的 operation ID，不會自行刪除或過期既有 record。既有 ID 的 replay lookup 與 unresolved operation 的 reconcile 仍可用，避免為了騰空間而破壞復原證據。caller 原始的 `operation_id` 會寫入 record，請避免把 PII 或敏感內容放入該 ID。

server 自己生成的 `captures` 最多保留 80 張；`scripts/client.mjs` 為方便本機檢視而寫出的 `client-captures` 副本沒有自動上限，需由本機操作者自行管理。

| journal state | 意義 | 下一步 |
| --- | --- | --- |
| `prepared` | 已保留，尚未送出 input。 | 驗證失敗時可 `refused`。 |
| `dispatched` | input 可能已送達。 | 重新觀察，不可重送。 |
| `confirmed` | 僅在可見導航轉換或 caller reconciliation 有明確證據時使用。 | 終態。 |
| `unchanged` | 新證據顯示確實未變。 | 終態；可作為一次 foreground justification。 |
| `unknown` | 送達或結果不明。 | 用新 frame 與完整 end-state evidence reconcile。 |
| `refused` | input 未被允許或未送達。 | 檢查 policy／target／delivery；不沿用舊 frame。 |

CUA private stdio child session 若結束，舊 binding、frame、foreground permit 都會失效。重新 read／observe 後再決定下一步；不要嘗試復活匿名 CLI session。

## 語意驗證的責任

截圖變化、OCR text presence、driver delivery receipt 都只能當 UI evidence。它們不能單獨證明：

- 播放清單已保存、曲目 identity 正確或順序完整；
- Queue 的成員與當前播放狀態正確；
- metadata/favorite/tag 已持久化；
- MUSE、DSP、convolution、audio device 的實際值已保存。

對這些資料，使用最新畫面加上既有 Roon API 讀回（可用時），比對完整 manifest／計數／順序／已保存值，再以 `desktop_reconcile` 留下短證據摘要。更多 recipe 層面的要求見 [workflows](workflows.md)。
