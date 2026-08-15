# 「生成 RAG 教學投影片」流程對照

本專案直接把參考任務中實際成功的製作方式固化，而不是只整理成提示詞。

## 成功流程

| 參考任務中的實際操作 | CodeReel 實作 |
|---|---|
| 安全讀取 repo／ZIP，交叉看 README、腳本、設定、工具定義與原始碼 | 唯讀 scanner、Git metadata、檔案 SHA-256、敏感檔排除 |
| 建立技術證據清單 | `evidence.json`，固定 `commit:path:startLine-endLine` |
| 基礎約 70–75%，進階約 25–30% | `project.fundamentalsRatio` 與教學 prompt |
| 固定 16:9 模板 | `templates/titanium-dark.json` + 固定 layout renderer |
| 每頁完整中文講稿寫入 speaker notes | PPTX notes 是旁白抽取來源 |
| 來源留在 notes，但 TTS 不朗讀 | 每頁使用不可預測且記錄於 manifest 的 `[CodeReelSources:<id>]`；只朗讀標記前內容 |
| 顯示稿與發音稿分離 | `narration-display.json`／`narration-tts.json` |
| `aicode`、縮寫、多音字、底線停頓另行處理 | pronunciation replacement、acronym spelling、underscore pause audit |
| PowerPoint 原生輸出 1920×1080 | `scripts/render-powerpoint.ps1` |
| 一頁投影片＝一段音訊＝一段影片 | `slide-NNN` 音訊、scene 與 manifest 一對一 |
| 語音前留 600 ms，尾端留 1.5 秒 | `video.preRollMs`／`tailPaddingMs` |
| H.264、AAC、30 FPS、yuv420p | FFmpeg 固定輸出規格 |
| 以音訊真實長度產生字幕與章節 | ffprobe duration → SRT／VTT／chapters |
| 逐頁溢位、抽幀、音量、頁數與 scene QA | PowerPoint COM、ffprobe、SRT 與 1:1 count gate |

## 內容編排規則

優先順序：

1. 成功結果預演。
2. 架構與前置條件。
3. 安裝與設定。
4. 啟動與分層驗收。
5. 第一次唯讀操作。
6. 證據導向的最小修改。
7. 進階能力與特殊資料。
8. 收尾清單。

每個關鍵操作盡量回答：

- 為什麼做。
- 在哪個目錄做。
- 實際命令。
- 成功時看到什麼。
- 失敗時先查什麼。

畫面保存完整命令、路徑與輸出；旁白解釋目的、判斷方式與失敗意義，不逐字朗讀符號。

## 已吸收的踩坑

- 不讓單一模型同時研究、排版、配音與剪片。
- 不相信 README 一定比程式碼新；所有 claim 都回到行號證據。
- 不把 PowerPoint 預覽或 HTML 渲染當成正式影片畫面。
- 讀 JSON 時移除 UTF-8 BOM；FFmpeg concat 清單使用無 BOM 的 UTF-8，確保中文路徑可用。
- PPTX 禁止負座標；PowerPoint COM 會檢查形狀越界與文字高度。
- 禁止旁白出現「建議講者」「本頁要」等幕後措辭。
- 不以 mean dB 取代 LUFS；正式響度採兩階段 loudnorm。
- 驗收內容必須記錄 repo 根目錄與 commit，避免把另一個專案的狀態當成結果。

## 成本控制

- 在完成課程計畫、PPTX、notes、PNG 與版面 QA 前，不呼叫正式 TTS。
- 正式 TTS 只收到核准旁白，不收到 repo、程式碼、證據或投影片。
- 音訊依內容 hash 快取；修改一頁只重做一頁。
- 每頁 scene 也有 sidecar fingerprint；未變更頁面不重新編碼。
- 所有字幕與章節由既有講稿與音訊時間生成，不做額外 STT。
