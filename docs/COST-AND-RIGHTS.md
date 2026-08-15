# 成本與權利

## 預設成本邊界

CodeReel 的 repo 掃描、PPTX、PNG、字幕、影片合成與 QA 均在本機完成。會把資料送出本機的環節有兩個：

1. 內容規劃（預設 `llm.provider=claude-cli`）：把選中的原始碼送到 Anthropic，用的是本機 Claude Code CLI 已登入的 Claude 訂閱額度，不另外計費，也不需要 API key。訂閱有用量上限，額度用完時 CodeReel 會回報 `CLAUDE_CLI_RATE_LIMIT` 並停止，不會改用付費 API。要讓原始碼不離開本機時，改用 `llm.provider=ollama`。
2. 正式 TTS：只送核准後的旁白，而且是唯一按量計價的環節。

不把單價硬編在程式裡。Azure Speech 定價按字元計算，實際價格會依區域、合約、幣別與日期變動；請把當日單價 snapshot 寫入設定，CodeReel 才會顯示估算。來源：[Azure Speech 定價](https://azure.microsoft.com/en-us/pricing/details/speech/)。

## 正式旁白

預設使用 Azure 的預建 `zh-TW` neural voice。Microsoft Product Terms 對免費與付費層的輸出權條件不同；正式商用輸出應使用符合條款的付費層並保存查核紀錄。來源：[Azure Product Terms](https://www.microsoft.com/licensing/terms/en-US/productoffering/MicrosoftAzureServices/OL/)、[Speech 語言與聲音支援](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)。

本機 TTS 可作草稿或替代方案，但模型程式碼授權不等於聲紋、人格或所有輸出的商用權保證。使用任何 cloning 或自訂聲音前，必須取得可稽核的同意。

## 降費規則

1. 先核准 evidence 與課程計畫。
2. 再核准 PPTX、每頁 notes 與 1080p PNG。
3. 產生 `tts-egress-report.json`，檢查 exact text 與未快取字元。
4. 最後才傳入報告內與本次內容綁定的 `--approve-tts=<digest>`。
5. 以 provider、voice、rate 與 spoken text hash 快取每頁音訊。
6. 發音修改只讓受影響頁 cache miss。
7. 字幕直接使用既有講稿和音訊長度，不再付 STT 費用。

## Repo 與程式碼畫面

能公開瀏覽 repo 不代表可以商用重製。GitHub 說明：沒有 license 時，預設著作權仍由作者保留；平台條款僅提供必要的檢視與 fork 權限。來源：[GitHub repository licensing](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。

發布前至少保存：

- repo URL／本機來源、commit 與工作樹狀態的人工確認紀錄。
- 授權檔與必要 attribution。
- 每個程式碼片段的 path、lines 與 SHA-256。
- 語音 provider、方案、voice、區域、產生日與條款查核紀錄。
- FFmpeg build 與 codec 的授權／散布評估。

FFmpeg 本身有 LGPL／GPL 組態差異，啟用 `libx264` 等 GPL 元件會改變整體散布條件；若只呼叫使用者自行安裝的 FFmpeg，也仍應記錄實際 build。來源：[FFmpeg Legal](https://ffmpeg.org/legal.html)。

本文件是工程風險控制說明，不是法律意見。
