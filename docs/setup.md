# 安裝、設定與啟動

這是給受信任本機 host 使用的 Windows stdio MCP，不提供 HTTP endpoint、listener 或多使用者隔離。建議將 `node_modules`、operation journal、captures 與其他 runtime state 放在私有本機目錄；腳本的實際檢查範圍見下方說明。

## 事前條件

| 元件 | 必要條件 |
| --- | --- |
| PowerShell | Windows PowerShell 5.1 或更新版本。 |
| Node.js | 22 以上，npm 應來自相同 Node 安裝。 |
| Roon Remote | 已安裝的 `Roon.exe`。請不要把 RoonServer 指給 `ROON_DESKTOP_APP`。 |
| CUA driver | 可執行的 `cua-driver.exe`，由使用者自行安裝並維護。此專案測過 [CUA driver public source/interface](https://github.com/trycua/cua/tree/main/libs/cua-driver/rust) 0.8.3；repo 不含 binary、不下載 binary，也不啟動 daemon。較新 driver 版本需要重新驗證。 |
| Windows OCR | 繁中與英文語言包可改善可見文字定位；沒有語言包時，截圖仍可用。 |

建議先決定四個絕對路徑：

```text
repository:    <path-to-cloned-repository>
dependencies: <external-dependency-prefix>
runtime:       <external-runtime-directory>
driver:        <path-to-cua-driver.exe>
roon:          <path-to-Roon.exe>
```

`dependencies` 和 `runtime` 應選擇不會同步或共用的本機路徑。`setup.ps1` 與 `launch.ps1` 會在正規化後拒絕路徑文字中含有 `OneDrive` 的目的地；它們不會驗證所有同步資料夾、repository 位置、junction 或其他 reparse point，因此這不是完整的 storage/sync 偵測。

## Provision 外部 dependencies

在 repo 根目錄執行：

```powershell
$deps = '<external-dependency-prefix>'
$runtime = '<external-runtime-directory>'
$driver = '<path-to-cua-driver.exe>'
$roon = '<path-to-Roon.exe>'

.\scripts\setup.ps1 `
  -DependenciesDir $deps `
  -RuntimeDir $runtime `
  -DriverPath $driver `
  -RoonPath $roon
```

腳本會：

1. 驗證 Node.js 22、npm、`Roon.exe` 和 `cua-driver.exe`。
2. 拒絕路徑文字中含有 `OneDrive` 的 dependency 與 runtime 目的地。
3. 將 `package.json` 與 `package-lock.json` 複製到外部 dependency prefix。
4. 用 lockfile 執行 `npm install --prefix <external-dependency-prefix>`，將依賴放到指定的 prefix。
5. 比對外部 `@modelcontextprotocol/sdk`、`zod`、`pngjs` 的實際版本與 manifest。
6. 對 server 做 Node syntax check。

這個流程可以重複執行。若已安裝依賴、只想驗證本機設定，使用：

```powershell
.\scripts\setup.ps1 `
  -DependenciesDir $deps `
  -RuntimeDir $runtime `
  -DriverPath $driver `
  -RoonPath $roon `
  -SkipInstall
```

若沒有傳入路徑，腳本預設使用 `$env:LOCALAPPDATA\Codex\dependencies\roon-desktop-mcp` 作為 dependency prefix，以及 `$env:LOCALAPPDATA\Codex\RoonDesktopMCP` 作為 runtime。明確傳入外部絕對路徑可讓團隊的 local layout 保持一致。

## 手動啟動 stdio server

```powershell
.\scripts\launch.ps1 `
  -DependenciesDir $deps `
  -RuntimeDir $runtime `
  -DriverPath $driver `
  -RoonPath $roon
```

啟動器設定下列 `ROON_DESKTOP_*` 變數後啟動 child Node process；它不會清空其餘 ambient environment，因此 child 仍會繼承呼叫它的 process environment。

| 變數 | 用途 |
| --- | --- |
| `ROON_DESKTOP_DEPENDENCIES` | 外部 dependency prefix。 |
| `ROON_DESKTOP_DATA_DIR` | journal、captures 與暫存 state。 |
| `ROON_DESKTOP_DRIVER` | 已安裝 CUA driver 的絕對路徑。 |
| `ROON_DESKTOP_APP` | Roon Remote 的 `Roon.exe`。 |
| `ROON_DESKTOP_ALLOW_INPUT` | `0` 或 `1`；預設 `0`。`desktop_act` 和 `desktop_navigate` 都需要它為 `1`。 |
| `ROON_DESKTOP_ALLOW_FOREGROUND` | `0` 或 `1`；預設為 `0`。 |
| `ROON_DESKTOP_MAX_OPERATIONS` | 選用的 journal record 上限；預設 `10000`，只接受整數 `1`–`100000`。 |

腳本不會註冊 MCP、建立服務、啟動 CUA daemon，或變更 Roon Core。預設 input 關閉；要讓 `desktop_act` 或 `desktop_navigate` 送出 UI input，受信任的本機操作者必須明確啟動：

```powershell
.\scripts\launch.ps1 `
  -DependenciesDir $deps `
  -RuntimeDir $runtime `
  -DriverPath $driver `
  -RoonPath $roon `
  -AllowInput 1
```

這個開關涵蓋所有桌面 input primitive，包含導航；`desktop_navigate` 的呼叫端 target 仍是 generic click，不能因為導航意圖就當成 readonly，必須核對真正目標與語意。前景化與前景 input 是兩件不同的 opt-in。`desktop_activate` 只需要 foreground opt-in 加上呼叫端宣告的使用者同意；前景 input 還需要 input opt-in、先前 background refusal 或 caller 已驗證的 no-op，以及同一 action 的一次性 permit：

```powershell
.\scripts\launch.ps1 `
  -DependenciesDir $deps `
  -RuntimeDir $runtime `
  -DriverPath $driver `
  -RoonPath $roon `
  -AllowInput 1 `
  -AllowForeground 1
```

## MCP host 設定範本

請依使用的 host 設定格式，加入相當於下列的**可攜範本**。本 repo 不會改寫任何 global config；變更前請先備份自己的設定檔。

```toml
[mcp_servers.roon_desktop]
command = "<absolute-path-to-node.exe>"
args = ["<absolute-path-to-repository>\\src\\server.mjs"]

[mcp_servers.roon_desktop.env]
ROON_DESKTOP_DEPENDENCIES = "<external-dependency-prefix>"
ROON_DESKTOP_DATA_DIR = "<external-runtime-directory>"
ROON_DESKTOP_DRIVER = "<path-to-cua-driver.exe>"
ROON_DESKTOP_APP = "<path-to-Roon.exe>"
ROON_DESKTOP_ALLOW_INPUT = "0"
ROON_DESKTOP_ALLOW_FOREGROUND = "0"
ROON_DESKTOP_MAX_OPERATIONS = "10000" # optional; integer 1 through 100000
```

只把這個設定交給你信任的本機 stdio host。重新載入 host 後，確認其工具清單出現 13 個 `roon_desktop` tools，再開始任何操作。個別 host 的註冊命令、設定檔位置與熱重載行為不在本專案保證範圍。

## Observation 資料流

Windows OCR 在 server 所在機器上執行，但 `desktop_observe` 等工具的回應會傳出 PNG、OCR 文字與 UIA element 資訊給 MCP client。若 client 或 host 會把 tool output 交給雲端模型或服務，這些畫面與文字可能離開本機。不要把 server 接到不受信任的 client，也不要把 runtime captures、journal 或 client 收到的 observation 當成可公開資料。

## 本機驗證

在已 provision 的環境中，可先做 syntax 與 test check：

```powershell
$env:ROON_DESKTOP_DEPENDENCIES = $deps
npm run check
npm test
```

若 Roon Remote 與 driver 都可用，readonly stdio smoke 不會發送 UI input：

```powershell
$env:ROON_DESKTOP_DATA_DIR = $runtime
$env:ROON_DESKTOP_DRIVER = $driver
$env:ROON_DESKTOP_APP = $roon
node .\scripts\smoke.mjs
```

## 排錯

| 現象 | 處理方式 |
| --- | --- |
| `ONEDRIVE_RUNTIME` | 將 dependencies 或 runtime 改到路徑文字不含 `OneDrive` 的本機目錄；這個檢查不代表已辨識所有同步或 reparse path。 |
| `READ_ONLY_MODE` | input 尚未在本機啟用。若確實要送 UI input，以 `-AllowInput 1` 或 host env 的 `ROON_DESKTOP_ALLOW_INPUT="1"` 重啟。 |
| `DRIVER_CONFIG` / `DRIVER_UNAVAILABLE` | 檢查 driver 路徑與既有互動式 runtime；重新建立觀察，不要嘗試復活匿名 session。 |
| `ROON_NOT_RUNNING` | 用 `desktop_open` 或自行開啟 Roon Remote。 |
| `WINDOW_SELECTION_REQUIRED` | 先 `desktop_status` 或 `desktop_observe`，使用回傳的 Roon window。 |
| OCR 找不到文字 | 重新觀察、縮小 region、換成畫面座標；OCR 不可用時不要猜文字。 |
| `STALE_FRAME` / `VIEW_CHANGED` | 畫面已變；取得新 frame、重新定位並使用新的 `operation_id`。 |
| `ACTION_OUTCOME_UNKNOWN` | 查 `desktop_operation`，重新觀察後用 `desktop_reconcile` 結案；不要重送。 |
