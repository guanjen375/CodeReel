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

先用內附示例確認完整管線可執行；這個命令使用固定的示例資料，不呼叫任何模型或付費語音，因此可以在完成第 3 步之前執行：

```powershell
npm run demo
```

## 3. 設定 Claude Code

這一步每台機器只需要做一次，與要分析哪個 repo 無關。

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

分析與課程規劃會呼叫本機的 `claude` 命令，用的是你的 Claude 訂閱額度，不需要 API key，也不會另外計費。這一步只要登入成功就完成了，不需要手動建立或編輯任何設定檔；模型相關的設定會由下一步的 `init` 自動寫好。

CodeReel 呼叫 CLI 時固定加上 `--tools ""`、`--safe-mode`、`--no-session-persistence`，並在來源 repo 之外的暫存目錄執行：模型只做文字生成，不會讀寫檔案、不載入 CLAUDE.md 與外掛，也不會把來源內容留在 Claude Code 的 session 紀錄。

這會把選中的原始碼送到 Anthropic。要維持原始碼不離開本機時，請改用 `llm.provider` 為 `ollama` 的設定；此時 `privacy.requireLocalLlm` 可設回 `true`，`claude-cli` 與 `requireLocalLlm=true` 併用會直接被設定檔驗證擋下。

## 4. 建立設定檔

每個要製作教材的來源 repo 各做一次。

```powershell
npm run codereel -- init --repo "C:\path\to\source-repo"
```

`--repo` 必須指向要製作教材的來源 repo，可使用絕對或相對路徑。命令仍然在 CodeReel 根目錄執行，不需要切換進來源 repo。例如 CodeReel 位於 `C:\Tools\CodeReel`、來源 repo 位於 `D:\Projects\MyApp`：

`init` 會先實際測試你的帳號能用哪些模型，再讓你挑：

```powershell
PS C:\Tools\CodeReel> npm run codereel -- init --repo "D:\Projects\MyApp"
已建立設定檔：C:\Tools\CodeReel\codereel.config.json
已設為目前專案。

正在確認這個帳號可以使用哪些模型…

分析與課程規劃要用哪個模型？箭頭右邊是這個帳號實際會跑到的模型。
  1) auto    → <實測結果>   跟隨 Claude Code 目前設定；模型可能隨時改變（目前）
  2) opus    → <實測結果>   分析最完整，適合正式教材
  3) sonnet  → <實測結果>   品質與速度平衡
  4) haiku   → <實測結果>   最快，適合先跑通整條流程
  ...

輸入編號（直接按 Enter 沿用 auto）：
```

左邊是你填進設定檔的名稱，右邊是 CodeReel **當場實測**問出來的結果 —— 每次執行 `init` 都會重新測一次。模型改版、你的方案變更、或 Anthropic 推出新模型時，這份清單都會自己跟著變，所以這份文件不列出具體的模型代號，一切以你實際跑出來的為準。有幾列、列出哪些名稱，也依 `llm.modelCandidates` 而定。

會需要實測是因為：**指定的模型如果你的帳號不能用，Claude Code 不會報錯，而是安靜地改跑另一個模型。**你以為在用 A，實際跑的是 B。CodeReel 會比對「你選的」和「實際跑到的」是不是同一個系列，對不上就在該列標示出來，你才不會挑到一個名不副實的選項。

正式產出教材建議選 `opus` 這類明確的名稱：`auto` 會跟著 Claude Code 當下的設定走，每次 `build` 可能換到不同模型，而課程計畫的快取判斷看不出這種變化。

要跳過詢問時用 `--model`，適合腳本或重跑：

```powershell
npm run codereel -- init --repo "D:\Projects\MyApp" --model opus
```

清單要測哪些名稱可以自己指定，在設定檔加上 `llm.modelCandidates` 即可，不必等 CodeReel 更新：

```json
{
  "llm": {
    "modelCandidates": ["auto", "opus", "sonnet", "haiku"]
  }
}
```

設定檔位置就是 `init` 印出的那一行，之後要調整任何設定都是改這個檔案。它同時會被設為目前專案，因此後續命令不需要填設定檔名稱。切換 repo 時重新執行一次 `init` 即可：既有設定不會被覆寫，CodeReel 會另外建立以 repo 命名的設定檔（例如 `MyApp.config.json`）。

第 3 步的 Claude Code 設定也已經寫在這個檔案裡：

```json
{
  "llm": {
    "provider": "claude-cli",
    "claudeExecutable": "claude",
    "model": "opus",
    "maxSourceChars": 120000
  },
  "privacy": {
    "requireLocalLlm": false
  }
}
```

`claudeExecutable` 只有在 `claude` 不在 PATH、或 Windows 上只找得到 `.cmd` 時，才需要改成 `claude.exe` 的完整路徑。

## 5. 產出投影片

先關閉已開啟的 PowerPoint，再檢查環境：

```powershell
npm run codereel -- doctor
```

`doctor` 會實際送出一次極小的請求驗證 Claude Code 認證是否可用。只有顯示 `llm.available=true` 與 `canBuildDeck=true` 後才執行 `build`；失敗時會列出修復命令。

建立課程計畫、PPTX、speaker notes 與逐頁 PNG：

```powershell
npm run codereel -- build
```

`build` 會先問這份教材要教什麼：

```text
這份教材要教什麼？方向會決定選哪些檔案與每一頁的內容。
目前設定：快速完成專案的安裝、啟動、驗證與第一個實際操作
輸入新的課程目的（直接按 Enter 沿用）：
```

同一個 repo 可以做出完全不同的教材 — 「快速上手」和「理解檢索架構」會選到不同檔案、切出不同章節。這個目的是模型取捨內容的最高優先依據：與它無關的內容即使證據充足也會被捨棄。輸入的內容會寫回設定檔成為下次的預設值。

要跳過詢問時用 `--purpose`，或用 `--no-prompt` 直接沿用設定檔的值：

```powershell
npm run codereel -- build --purpose "理解檢索與重排流程，能自行替換 embedding 模型"
```

`--purpose` 只影響這一次執行，不會寫回設定檔；要換掉長期預設值請用互動詢問，或直接改設定檔的 `project.purpose`。

`→ 建立證據與課程` 會呼叫 Claude Code CLI，期間可能數分鐘沒有進入下一階段；命令會每 30 秒顯示已等待時間，完成後自動繼續產生 PPTX 與逐頁圖片。改變課程目的會讓課程計畫重新產生，這一段要重跑。

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

固定示例不呼叫任何模型或付費 TTS：

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
