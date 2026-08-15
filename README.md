# CodeReel

將本機程式碼儲存庫轉成繁體中文教學 PPTX、逐頁講稿、配音、字幕與 MP4。

## 1. 安裝需求

- Windows 11
- Node.js 20 或更新版本
- Microsoft PowerPoint 桌面版
- FFmpeg 與 ffprobe，且可從 PowerShell 直接執行
- Claude Code CLI，且已用 Claude 訂閱帳號登入
- 正式影片配音：Azure Speech 付費方案與預建 `zh-TW` 語音

先確認命令可執行：

```powershell
node --version
ffmpeg -version
ffprobe -version
```

## 2. 安裝 CodeReel

以下所有 `npm` 與 `npm run codereel` 命令，都在 CodeReel 根目錄（含 `package.json` 的資料夾）執行。要轉換的來源 repo 可位於其他資料夾，不需要切換進來源 repo。

在 CodeReel 根目錄執行：

```powershell
npm ci --ignore-scripts
```

先用內附示例確認完整管線可執行；這個命令不呼叫本機 LLM 或付費語音：

```powershell
npm run demo
```

## 3. 建立設定檔

```powershell
npm run codereel -- init --repo "C:\path\to\source-repo"
```

`--repo` 必須指向要製作教材的來源 repo，可使用絕對或相對路徑。`init` 會建立完整設定檔並將它設為目前專案；後續命令不需要填設定檔名稱。切換 repo 時重新執行一次 `init` 即可，既有設定不會被覆寫。

例如 CodeReel 位於 `C:\Tools\CodeReel`，來源 repo 位於 `D:\Projects\MyApp`：

```powershell
PS C:\Tools\CodeReel> npm run codereel -- init --repo "D:\Projects\MyApp"
PS C:\Tools\CodeReel> npm run codereel -- doctor
PS C:\Tools\CodeReel> npm run codereel -- build
```

若要直接分析 CodeReel 本身，也可執行：

```powershell
npm run codereel -- init --repo "."
```

這種情況會自動把輸出移到來源 repo 外，避免掃描或覆寫產物。

## 4. 設定 Claude Code

安裝 Claude Code CLI：

```powershell
npm install -g @anthropic-ai/claude-code
```

用 Claude 訂閱帳號登入，會開啟瀏覽器完成授權：

```powershell
claude auth login
```

確認登入狀態，`loggedIn` 必須是 `true`：

```powershell
claude auth status
```

桌面版 Claude Code App 與 CLI 的登入狀態是分開的。App 可以正常使用，不代表 CLI 也可以；`claude auth status` 顯示 `loggedIn: true` 但實際呼叫回 `401 OAuth access token has been revoked` 時，重跑一次 `claude auth login` 即可。

```json
{
  "llm": {
    "provider": "claude-cli",
    "claudeExecutable": "claude",
    "model": "auto",
    "maxSourceChars": 120000
  },
  "privacy": {
    "requireLocalLlm": false
  }
}
```

分析與課程規劃會呼叫本機的 `claude` 命令，用的是你的 Claude 訂閱額度，不需要 API key，也不會另外計費。`"model": "auto"` 表示交給 Claude Code 目前設定的模型；要固定產出模型時，改成 `opus`、`sonnet` 或完整 model id（例如 `claude-opus-5`）。

CodeReel 呼叫 CLI 時固定加上 `--tools ""`、`--safe-mode`、`--no-session-persistence`，並在來源 repo 之外的暫存目錄執行：模型只做文字生成，不會讀寫檔案、不載入 CLAUDE.md 與外掛，也不會把來源內容留在 Claude Code 的 session 紀錄。

這一步會把 `llm.maxSourceChars` 範圍內選中的原始碼送到 Anthropic。要維持原始碼不離開本機時，請改用 `llm.provider` 為 `ollama` 的設定；此時 `privacy.requireLocalLlm` 可設回 `true`，`claude-cli` 與 `requireLocalLlm=true` 併用會直接被設定檔驗證擋下。

只有 `doctor` 顯示 `llm.available=true` 與 `canBuildDeck=true` 後才執行 `build`。`doctor` 會實際送出一次極小的請求驗證認證是否可用，失敗時會列出修復命令。

## 5. 產出投影片

先關閉已開啟的 PowerPoint，再檢查環境：

```powershell
npm run codereel -- doctor
```

建立課程計畫、PPTX、speaker notes 與逐頁 PNG：

```powershell
npm run codereel -- build
```

`→ 建立證據與課程` 會呼叫 Claude Code CLI，期間可能數分鐘沒有進入下一階段；命令會每 30 秒顯示已等待時間，完成後自動繼續產生 PPTX 與逐頁圖片。

主要檔案位於：

```text
output\<repo>-<來源識別碼>\deck\<repo>-教學投影片.pptx
output\<repo>-<來源識別碼>\deck\slides\
output\<repo>-<來源識別碼>\intermediate\course-plan.json
```

PPTX 可修改版面、內文與每頁 notes，但需保留 notes 內的 `[CodeReelSources:<id>]`。影片章節沿用課程計畫中的頁面標題，因此不可只在 PPTX 修改標題，也不可新增、刪除或重排頁面。

## 6. 產出正式影片

設定 Azure Speech 金鑰與區域：

```powershell
$env:AZURE_SPEECH_KEY = '<your-key>'
$env:AZURE_SPEECH_REGION = '<your-region>'
```

先建立付費語音外送預覽：

```powershell
npm run codereel -- run
```

第一次執行會在付費前停止，並建立：

```text
output\<repo>-<來源識別碼>\intermediate\tts-egress-report.json
```

確認報告中的旁白、voice、endpoint、字數與費用後，複製 `approvalFlag` 內的 digest：

```powershell
npm run codereel -- run --approve-tts=<報告中的-digest>
```

旁白、voice 或 endpoint 只要變更，就必須重新產生並核准 digest。未變更的逐頁語音會直接命中快取，不會再次送出。

完成後的主要檔案位於：

```text
output\<repo>-<來源識別碼>\video\<repo>-教學影片.mp4
output\<repo>-<來源識別碼>\video\<repo>-繁中字幕.srt
output\<repo>-<來源識別碼>\video\<repo>-繁中字幕.vtt
output\<repo>-<來源識別碼>\qa\qa-report.json
```

## 7. 常用命令

```powershell
# 只建立 repo 證據與課程計畫
npm run codereel -- analyze

# 查看各階段狀態
npm run codereel -- status

# 重新執行 QA
npm run codereel -- qa

# 強制重跑管線；相同逐頁語音仍可命中內容快取
npm run codereel -- run --force
```

最近一次 `init` 的 repo 會保持為目前專案。需要臨時指定其他設定檔時，才加入 `--config .\其他設定檔.json`。

若 PPTX 已人工修改，來源或模板也同時變更，CodeReel 會停止以避免覆寫。確定要重建時加入 `--overwrite-deck-edits`；原檔會先備份到 `deck\backups`。

## 8. 本機示例與測試

固定示例不呼叫本機 LLM 或付費 TTS：

```powershell
npm run demo
npm test
npm audit
```

示例輸出位於 `demo-output\demo-repo-<來源識別碼>`。fixture 音訊只供管線測試，不可當作正式成品。

## 9. 詳細文件

- [完整操作與故障排除](./docs/OPERATIONS.md)
- [參考流程](./docs/REFERENCE-FLOW.md)
- [成本與語音權利](./docs/COST-AND-RIGHTS.md)
- [安全說明](./SECURITY.md)
- [系統架構](./docs/ARCHITECTURE.md)

發布前須確認來源 repo 授權、程式碼重製權、商標與聲音商用權。
