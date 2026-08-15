# 操作手冊

以下命令使用最近一次 `init` 選定的 repo；需要切換時先重新執行 `init --repo <repo路徑>`。

## 1. Doctor

```powershell
npm run codereel -- doctor
```

必要通過：Node.js、repo 路徑、PowerPoint、FFmpeg／ffprobe、本機 LLM。TTS 只有在要產生影片時才是必要項目。

## 2. Analyze

```powershell
npm run codereel -- analyze
```

人工檢查：

- `evidence\repo-manifest.json` 是否漏掉重要目錄。
- `evidence\evidence.json` 的行號與 claim 是否相符。
- `intermediate\course-plan.json` 是否把實際操作放在主線。
- code／命令是否能在 evidence excerpt 逐字找到。
- 未知內容是否被誤寫成確定事實。

## 3. Build

```powershell
npm run codereel -- build
```

人工檢查：

- `deck\slides` 每一頁，而非只看 montage。
- 長標題、長命令、路徑、頁碼與底部文字。
- `qa\powerpoint-overflow.json` 必須 `passed=true`。
- PowerPoint speaker notes 內有自然口語講稿與 `[CodeReelSources:<id>]` 分隔標記。

PPTX 可修改版面、內文，以及分隔標記前的 speaker notes；請保留每頁的 `[CodeReelSources:<id>]`。影片章節沿用課程計畫中的頁面標題，因此不可只在 PPTX 修改標題，也不要新增、刪除或重排頁面。若來源或模板變更時偵測到人工編輯，CodeReel 會先停止，避免覆寫。

確定要以新生成版本取代人工編輯時才使用：

```powershell
npm run codereel -- build --overwrite-deck-edits
```

舊 PPTX 會先備份到 `deck\backups`。

## 4. 正式語音核准

第一次執行可故意不給核准：

```powershell
npm run codereel -- run
```

若有未命中快取的 Azure 文字，程序會停止並產生 `tts-egress-report.json`。核對 exact text、字元數、voice、rate 與定價 snapshot 後再執行：

```powershell
npm run codereel -- run --approve-tts=<報告中的-digest>
```

## 5. 發布前 QA

```powershell
npm run codereel -- qa
```

必要條件：

- plan、notes、PNG、audio、scene 與 manifest 頁數 1:1。
- 逐頁來源引用覆蓋率 100%，並人工核對每個 claim 與 excerpt 的語意。
- PowerPoint overflow 0。
- 1920×1080、H.264、AAC、yuv420p。
- SRT 時間遞增、不重疊、不超出影片。
- 逐頁抽看 PNG；抽聽開場、中段、技術縮寫密集頁與結尾。
- `video-samples` 與成片畫面一致。
- 正式語音與 repo 重製權已有可追溯紀錄。

## 中斷與重跑

```powershell
npm run codereel -- status
npm run codereel -- run --approve-tts=<報告中的-digest>
```

失敗階段會標成 `failed`，成功且 fingerprint 相同的階段會跳過。若要重跑所有階段：

```powershell
npm run codereel -- run --approve-tts=<報告中的-digest> --force
```

即使使用 `--force`，逐頁語音仍先查內容 cache。

## 常見問題

### LLM 連不上

- 先直接開啟 `llm.baseUrl` 對應的 `/models` 或 Ollama `/api/tags`。
- 確認端點監聽 loopback。
- `model=auto` 會選清單第一個模型；正式使用建議固定模型名稱。

### PowerPoint COM 失敗

- 執行 `doctor`、`build` 或 `run` 前先關閉 PowerPoint；CodeReel 偵測到既有 PowerPoint 時會停止，且不會關閉目前工作中的簡報。
- 確認 PPTX 可手動開啟且不要求修復。
- 再跑 `doctor`；不需要重新做 LLM 或 TTS。

### Azure 沒有呼叫

- 這通常是正確的成本閘門。先看 `tts-egress-report.json`。
- 確認 `AZURE_SPEECH_KEY` 與 region／endpoint。
- 明確加入與目前外送預覽完全相符的 `--approve-tts=<digest>`。

### 修改一頁後仍全部重建 deck

PPTX 是單一檔案，因此 deck 與 PowerPoint PNG 目前整份重建；音訊與 scene 則是逐頁 cache，不會重做未變更旁白。
