# CodeReel

將本機程式碼儲存庫轉成繁體中文教學 PPTX、逐頁講稿、配音、字幕與 MP4。

## 1. 安裝需求

共通需求：

- Node.js 20 或更新版本
- FFmpeg 與 ffprobe，且可從終端機直接執行
- Claude Code CLI，且已用 Claude 訂閱帳號登入
- 正式影片配音：Azure Speech 付費方案與預建 `zh-TW` 語音

投影片渲染依平台而異，`init` 會自動選好，不需要手動設定：

| 平台 | `slides.renderProvider` | 需要安裝 |
|---|---|---|
| Windows | `powerpoint` | Microsoft PowerPoint 桌面版 |
| macOS | `libreoffice` | `brew install --cask libreoffice` 與 `brew install poppler` |
| Linux | `libreoffice` | `sudo apt install libreoffice-impress poppler-utils fonts-noto-cjk` |

`init` 也會依平台填好繁中與等寬字型（Windows 用 Microsoft JhengHei／Cascadia Mono，macOS 用 PingFang TC／Menlo，Linux 用 Noto Sans CJK TC／DejaVu Sans Mono）。Linux 少裝 CJK 字型的話，投影片上的中文會變成空白方框，所以上表的 `fonts-noto-cjk` 不能省。

**Windows 11 是唯一經過完整實測的環境**；macOS 與 Linux 的路徑已實作並通過單元測試，但尚未跑過完整產出。

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

`init` 會偵測你的帳號實際能用哪些模型，再列出來讓你挑：

```powershell
PS C:\Tools\CodeReel> npm run codereel -- init --repo "D:\Projects\MyApp"
已建立設定檔：C:\Tools\CodeReel\codereel.config.json
已設為目前專案。

正在偵測可用的模型…

分析與課程規劃要用哪個模型？
  1) <偵測到的模型>
  2) <偵測到的模型>
  ...
  n) auto（跟隨 Claude Code 目前設定）（目前）

輸入編號（直接按 Enter 沿用 auto）：
```

清單以實際偵測結果為準，會隨模型更新自動變動；`auto` 不是模型，因此固定放在最後一項。選 `auto` 時每次 `build` 可能換到不同模型，固定一個名稱可以讓產出穩定。要加測其他名稱可在設定檔的 `llm.modelCandidates` 補上。

要跳過詢問時用 `--model`：

```powershell
npm run codereel -- init --repo "D:\Projects\MyApp" --model opus
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

先關閉已開啟的 PowerPoint 或 LibreOffice，再檢查環境：

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

先建立外送預覽：

```powershell
npm run codereel -- run
```

第一次執行會在送出任何文字之前停止，並建立：

```text
output\<repo>-<來源識別碼>\intermediate\tts-egress-report.json
```

這份報告要看的是**送出去的是什麼**，不是花多少錢：

| 欄位 | 確認什麼 |
|---|---|
| `items` | 每一頁完整的旁白原文 — 這是唯一會離開你機器的內容 |
| `endpoint` | 送到哪個 Azure 區域 |
| `voice`、`outputFormat` | 用哪個聲音、輸出什麼格式 |
| `billableCharacters` | 計費字元總數 |

確認完之後，複製 `approvalFlag` 內的 digest 再跑一次：

```powershell
npm run codereel -- run --approve-tts=<報告中的-digest>
```

digest 是那批內容的雜湊。旁白、voice、endpoint 或格式只要變更，digest 就會變，必須重新確認一次 — 你不可能核准了 A 卻送出 B。未變更的逐頁語音會直接命中快取，不會再次送出。

### 多音字唸錯時

技術旁白很容易踩到「重」：「重排、重跑、重載、重開、重啟」要唸 chóng，但「重點、權重」是 zhòng。同一段話兩種讀音都有，所以不能用 `replacements` 的整體字串替換去修 — 那會把該唸 zhòng 的也一起改掉。

改用 `phoneme`，只有列出來的詞會被指定讀音，其餘同字不受影響：

```json
"pronunciation": {
  "phonemeAlphabet": "sapi",
  "replacements": [
    { "from": "重排", "phoneme": "chong2 pai2" },
    { "from": "重跑", "phoneme": "chong2 pao3" },
    { "from": "重載", "phoneme": "chong2 zai4" },
    { "from": "重開", "phoneme": "chong2 kai1" },
    { "from": "重啟", "phoneme": "chong2 qi3" },
    { "from": "重新", "phoneme": "chong2 xin1" }
  ]
}
```

這類規則只作用在送給 Azure 的 SSML，投影片與字幕上的文字不變，計費字數也不變。長的詞優先比對，所以同時有 `重` 和 `重新載入` 時會選後者。

`phonemeAlphabet` 預設 `sapi`（拼音加聲調數字），可改成 `ipa`。**Azure 對 zh-TW 語音支援哪一種標音法請自行實測**：先只加一條規則跑一次，確認唸對了再補其他詞。SSML 內容改變會讓該頁語音重新合成，未受影響的頁面仍然命中快取。

`intermediate\pronunciation-audit.json` 會列出每條規則實際命中幾次，可以確認規則有沒有生效。

### 費用

報告預設不會換算金額，只給字元數。要自己估算的話：`字元數 ÷ 1,000,000 × 每百萬字元單價`，單價以 [Azure Speech 定價](https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/)當日的區域牌價為準。

實務上這筆錢很小 — 一份 18 頁、2,562 字的教材大約是零點零幾美元，而設定檔的硬上限 `tts.maxBillableCharacters: 30000` 換算過去也不到一美元。**真正需要謹慎的不是金額，是旁白文字外送，以及免費層與付費層的商用輸出權差異**（見[成本與語音權利](./docs/COST-AND-RIGHTS.md)）。

想讓報告直接顯示估算金額，就在設定檔填入單價；填了之後 `tts.maxEstimatedCost` 才會生效，沒填時該上限不會作用：

```json
"ratePerMillionCharacters": 16,
"pricingCurrency": "USD",
"pricingSnapshotDate": "2026-08-16"
```

注意報告裡的 `rate` 欄位是**語速**（例如 `-6%`），不是價格。

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
