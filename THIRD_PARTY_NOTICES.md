# Third-party notices

CodeReel 直接使用：

- PptxGenJS 4.0.1 — MIT License
- JSZip 3.10.1 — MIT License / GPLv3 dual license（本專案依 MIT 條款使用）
- `vendor/image-size-disabled` — CodeReel 本地安全 stub，不含上游 `image-size` 程式碼

執行時會呼叫但不隨本專案散布：

- Microsoft PowerPoint
- FFmpeg／ffprobe；實際授權取決於安裝的 build 與啟用元件
- 選用的本機 LLM runtime 與模型
- 選用的 TTS runtime、voice model 或 Azure Speech 服務

發布或散布前，請依實際安裝組合產生完整 SBOM 與 attribution。
