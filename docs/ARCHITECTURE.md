# 架構

## 單一資料鏈

```text
RepoManifest
  → EvidenceManifest
  → CoursePlan / SlideSpec
  → PPTX + speaker notes
  → Narration(display / spoken / caption)
  → PNG + Audio
  → Scene MP4
  → Final MP4 + SRT + VTT + Chapters + QA
```

投影片、旁白、字幕與影片不各自詢問模型。它們從同一份 `course-plan.json` 衍生，因此標題、順序、證據與時間軸能保持一致。

## 模組

- `repo-scan.mjs`：唯讀掃描、Git metadata、排除敏感檔、SHA-256。
- `llm.mjs`：OpenAI-compatible、Ollama 與 fixture adapter；可解析並重試結構化 JSON。
- `plan.mjs`：頁數、禁詞、證據行號、逐字 code／command 驗證。
- `deck.mjs`：固定 16:9 可編輯 PowerPoint layout 與 speaker notes。
- `narration.mjs`：從 PPTX ZIP 關聯實際抽取 notes，移除來源區塊並建立發音稿。
- `render.mjs`：PowerPoint COM 原生輸出與 overflow gate。
- `tts.mjs`：Azure、Piper、fixture；外送預覽、付費核准、逐頁內容快取。
- `media.mjs`：ffprobe duration、逐頁 scene、concat、兩階段 loudnorm、字幕與章節。
- `qa.mjs`：證據、notes、PNG、音訊、scene、codec、SRT、抽幀與發布警告。
- `state.mjs`：stage fingerprint、成功／失敗狀態與斷點續跑。

## 隱私邊界

```text
repo 原文 ──只到──> loopback LLM
核准後旁白 ──可選──> Azure Speech
PPTX/PNG/字幕/證據 ──不送──> Azure Speech
```

`privacy.requireLocalLlm=true` 時，只接受 `localhost`、`127.0.0.1` 與 loopback IPv6。repo 裡的內容視為不可信資料；prompt 明確禁止遵循 README 或程式碼內的模型指令。

## Fingerprint 與失效範圍

- repo 檔案 SHA 變更：重新產生 evidence 與課程計畫。
- course plan 或 theme 變更：重新產生 PPTX 與 PNG。
- pronunciation 或 speaker notes 變更：重新產生 narration。
- spoken text／voice／rate 變更：只讓相應音訊 cache miss。
- 圖片或音訊變更：只讓相應 scene sidecar fingerprint 失效。
- 任一 scene 變更：重新 concat、字幕／章節與 QA。

正式 TTS cache key：

```text
SHA256(provider + voice + rate + spokenText + localVoiceModel)
```

## 品質承諾邊界

- 文件與常見文字型程式碼可做行號蒐證與課程編排。
- 未知語言會降級成 README／設定／純文字模式，不宣稱具備型別或呼叫圖分析。
- MVP 不建 AST、LSP 或跨檔精確 references；這些屬後續擴充。
- repo 中的命令只作教學證據，不會自動執行。
- 無 license 不代表可商用重製；QA 會提出警告，但最終權利確認仍需人工完成。
