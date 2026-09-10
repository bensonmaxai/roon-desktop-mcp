# 驗證狀態與範圍

本文件記錄 **2026-09-10 / 0.1.0 開發建置**的驗證範圍。私有 captures、operation journal、畫面與本機 acceptance evidence 不隨 public repository 發布；任何新的環境都應依 [local acceptance plan](acceptance-plan.md) 重新驗證。

## 已驗證的基線

| 項目 | 結果 | 範圍 |
| --- | --- | --- |
| Node regression suite | 77/77 tests 通過 | 此 build 的自動 regression baseline。 |
| JavaScript syntax | 31 modules 通過 `node --check` | `src`、`scripts`、`tests` 的語法檢查。 |
| MCP stdio smoke | initialize、`listTools`、readonly `desktop_status`／`desktop_observe`／`desktop_workflows` 可完成 | smoke 不送任何 UI input。 |
| MCP surface | 13 tools、35 guides | tool schema 與 workflow catalog 可被 stdio client 讀取。 |
| Roon target | Roon Remote 2.71.1683 | 僅代表該開發環境的目標 build。 |
| CUA integration | 已安裝 public interface 0.8.3 | driver 由環境提供，並非 repo bundled dependency；較新版本沒有自動相容性承諾。 |
| guarded foreground recovery | `desktop_activate` 有自動 regression coverage 與受限實機確認 | 僅適用於明確授權、fresh frame 與配置允許的 recovery。 |

這些結果是 build-specific evidence。Roon 更新、driver 更新、DPI、螢幕配置、視窗狀態與 OCR 語言包都可能改變行為；每次部署前應重跑與變更範圍相符的 check。

## 已做過的受限人工驗收

一個隔離、可丟棄的測試播放清單曾完成下列六個階段，且每一階段都以 fresh observation 讀回：

1. 建立空播放清單。
2. 加入少量測試曲目。
3. 重新排序。
4. 改名。
5. 移除指定曲目。
6. 刪除測試播放清單並確認 target absence。

此流程用來驗證「觀察 → 單一動作 → readback → reconcile」的操作模式，以及 foreground drag recovery 的受限路徑。它沒有刻意修改既有播放清單、library、Queue、playback 或 audio 設定。結束後的 visual post-check 只確認 paused 狀態、Queue 顯示計數與螢幕可見片段；那不是完整 Queue manifest、membership 或 order 的驗證。

## 尚未宣告為已驗證

- 35 條 workflow 全數仍為 `guided_unverified`、`agent_assisted`；受限播放清單情境不會升格其他 recipe。
- 既有播放清單與完整 Queue membership／order 沒有作為 public 驗收結果發布。
- library、tag、metadata、audio device、MUSE、DSP preset、filter 與 convolution 的寫入沒有在此 baseline 中完成端到端語意驗收。
- 跨 Roon build、不同 DPI、多螢幕、最小化或遮蔽 canvas、不同 OCR 語言包，以及 driver 未來版本尚未建立相容性承諾。
- playback、Queue 與 DSP 的正確 end state 需要完整 manifest 或值的讀回，不能僅憑截圖、OCR 或 input receipt 推論。

## 建議的重跑方式

1. 依 [setup guide](setup.md) provision 外部 dependencies 與 runtime。
2. 執行 `npm run check` 與 `npm test`。
3. 在不改動資料的前提下執行 `node .\scripts\smoke.mjs`。
4. 若要驗收 mutation，建立可丟棄 target，先取得使用者對該確切寫入 scope 的明確授權；該 scope 內的非破壞性步驟不必重複要求相同同意，並依 [acceptance plan](acceptance-plan.md) 記錄 fresh readback。
5. 不要把本機 captures、journals、operation IDs 或任何 library metadata 加入 repository。operation ID 會原樣保存在 journal，請不要把個資或曲目資料放入 ID。
