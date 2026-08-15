# CodeReel

將本機程式碼儲存庫轉成繁體中文教學 PPTX、逐頁講稿、配音、字幕與 MP4。

## 1. 安裝需求

- Windows 11
- Node.js 20 或更新版本
- Microsoft PowerPoint 桌面版
- FFmpeg 與 ffprobe，且可從 PowerShell 直接執行
- 已啟動的本機 LLM 服務：Ollama 或 OpenAI-compatible API
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

`--repo` 必須指向要製作教材的來源 repo，可使用絕對或相對路徑。`init` 會在 CodeReel 根目錄建立完整的 `codereel.config.json`，並自動寫入來源路徑；不需要自行建立設定檔。

例如 CodeReel 位於 `C:\Tools\CodeReel`，來源 repo 位於 `D:\Projects\MyApp`：

```powershell
PS C:\Tools\CodeReel> npm run codereel -- init --repo "D:\Projects\MyApp"
PS C:\Tools\CodeReel> npm run codereel -- build --config .\codereel.config.json
```

若要直接分析 CodeReel 本身，也可執行：

```powershell
npm run codereel -- init --repo "."
```

這種情況會自動把輸出移到來源 repo 外，避免掃描或覆寫產物。

## 4. 設定本機模型

在 `codereel.config.json` 選擇一種端點。

### Ollama（預設）

安裝 Ollama：

```powershell
winget install --id Ollama.Ollama --exact --accept-package-agreements --accept-source-agreements
```

重新開啟 PowerShell，下載一個本機模型。快速驗證可用：

```powershell
ollama pull qwen3:4b-instruct
```

需要較完整的 repo 分析品質時可改用 `qwen3-coder:30b`；下載內容約 19 GB：

```powershell
ollama pull qwen3-coder:30b
```

```json
{
  "llm": {
    "provider": "ollama",
    "baseUrl": "http://127.0.0.1:11434",
    "model": "auto",
    "contextWindow": 32768,
    "maxSourceChars": 32000
  }
}
```

若 Ollama 尚未啟動，另開一個 PowerShell 執行 `ollama serve` 並保持執行。回到專案視窗確認至少有一個已安裝模型：

```powershell
ollama list
```

### OpenAI-compatible API

```json
{
  "llm": {
    "provider": "openai-compatible",
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "auto"
  }
}
```

`"model": "auto"` 會讀取端點的模型清單並自動選取，不需要填寫確切模型名稱。`auto` 不會下載模型；端點內必須已存在至少一個模型。

只有 `doctor` 顯示 `llm.available=true` 與 `canBuildDeck=true` 後才執行 `build`。若端點未啟動，`doctor` 會列出修復命令。

## 5. 產出投影片

先關閉已開啟的 PowerPoint，再檢查環境：

```powershell
npm run codereel -- doctor --config .\codereel.config.json
```

建立課程計畫、PPTX、speaker notes 與逐頁 PNG：

```powershell
npm run codereel -- build --config .\codereel.config.json
```

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
npm run codereel -- run --config .\codereel.config.json
```

第一次執行會在付費前停止，並建立：

```text
output\<repo>-<來源識別碼>\intermediate\tts-egress-report.json
```

確認報告中的旁白、voice、endpoint、字數與費用後，複製 `approvalFlag` 內的 digest：

```powershell
npm run codereel -- run --config .\codereel.config.json --approve-tts=<報告中的-digest>
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
npm run codereel -- analyze --config .\codereel.config.json

# 查看各階段狀態
npm run codereel -- status --config .\codereel.config.json

# 重新執行 QA
npm run codereel -- qa --config .\codereel.config.json

# 強制重跑管線；相同逐頁語音仍可命中內容快取
npm run codereel -- run --config .\codereel.config.json --force
```

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
