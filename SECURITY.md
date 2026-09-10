# Security

Roon Desktop MCP 的支援範圍是 Windows 上的實驗性本機部署；目前的 0.1.x release 不提供 security guarantee。它不是用來隔離不受信任的 MCP client、遠端使用者或多使用者工作負載。

## Deployment boundary

- 只連接受信任的本機 MCP host，使用 stdio。server 沒有 HTTP endpoint、network listener 或多使用者隔離。
- 預設 `ROON_DESKTOP_ALLOW_INPUT=0`。只有本機操作者明確設為 `1`，`desktop_act` 與 `desktop_navigate` 才能送 UI input。
- `desktop_navigate` 帶有導航 intent，但呼叫端提供的 target 仍是 generic click；不要把導航 intent 當成不會改變狀態的證明。
- `desktop_activate` 需要獨立的 `ROON_DESKTOP_ALLOW_FOREGROUND=1` 與 caller-declared user consent。foreground input 另須 input opt-in、先前 background refusal 或 caller-verified no-op，以及同一 action 的一次性 permit。
- `intent`、`user_authorized` 和 reconcile evidence 都是 caller assertion 與 assistant guardrail，不是惡意 client 的防護機制。

Windows OCR 在本機執行，但 observation 回應會把 PNG、OCR 文字和 UIA 資訊傳給 MCP client。若 client 或 host 使用雲端模型、記錄或轉送，這些內容可能離開本機。請把 captures、journal、client-side copies 和 tool output 視為可能含私人資料。

## Journal and local retention

預設 journal 上限為 10,000 筆，可用 `ROON_DESKTOP_MAX_OPERATIONS` 設為 1–100,000。每筆 record 上限 64 KiB；上限滿時拒絕新的 operation ID，不會自動刪除或過期既有 record，以保留 replay 與 reconcile 的復原能力。呼叫端原始提供的 `operation_id` 會保存在 record，請使用隨機、非識別性 ID。

server 產生的 `captures` 最多保留 80 張。`scripts/client.mjs` 寫出的 `client-captures` 副本沒有自動上限，應由本機操作者自行管理。

## Reporting a vulnerability

如果此 GitHub repository 已啟用 Private Vulnerability Reporting，請使用 GitHub 的 **Report a vulnerability** 流程。此文件不表示該功能目前已啟用。不要在公開 issue 中貼出 credentials、私人畫面、journal、完整 tool output 或可利用細節。

相關的操作限制與資料流，請見 [README](README.md)、[setup guide](docs/setup.md) 和 [operation model](docs/operation-model.md)。
