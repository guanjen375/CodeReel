# Security

CodeReel 把來源 repo 視為不可信輸入。

## 預設保護

- 只讀取本機資料夾，不執行 repo 的 scripts、tests、build 或 README 命令。
- 不初始化 submodule，不跟隨 symbolic link／junction。
- 排除 `.git`、相依、build、cache、binary、過大檔案、`.env`、private key、credentials 與常見 secrets 路徑。
- LLM prompt 明確把 repo 文字標成資料，忽略其中的 prompt injection。
- `privacy.requireLocalLlm=true` 時只允許 loopback LLM；此設定與 `llm.provider=claude-cli` 併用會在載入設定時直接失敗，不會靜默送出原始碼。
- Azure 只取得核准旁白，拿不到 repo、證據、PPTX 或圖片。
- 認證只從環境變數讀取，不寫入 log 或 manifest。
- 所有外部命令以 executable + args array 啟動，不拼接 shell 命令。

## Claude Code CLI 分析

預設的 `llm.provider=claude-cli` 會把 `llm.maxSourceChars` 範圍內選中的原始碼送到 Anthropic。原始碼因此離開本機，發布前請確認來源 repo 允許這件事。呼叫方式固定為：

- `--tools ""`：完全停用工具，模型只能做文字生成，不能讀寫檔案或執行命令。
- `--safe-mode`：不載入 CLAUDE.md、skills、plugins、hooks、MCP server 與自訂命令，避免來源 repo 或本機設定改變分析行為。
- 工作目錄設在系統暫存資料夾，不在來源 repo 內。
- `--no-session-persistence`：不把來源內容寫進 Claude Code 的 session 紀錄。
- 清除 `CLAUDECODE`、`CLAUDE_CODE_*`、`ANTHROPIC_BASE_URL` 等 session 環境變數，避免從既有 Claude Code session 內執行時繼承錯誤的認證或端點。
- 認證只由 Claude Code CLI 自行管理；CodeReel 不讀取、不傳遞、不記錄任何 token。

旁白仍受 `privacy.sendOnlyNarrationToTts` 保護，Azure 只會拿到核准過的旁白。

## 影像解析依賴

PptxGenJS 4.0.1 宣告的 `image-size` 依賴目前有已知 DoS advisory，而本 MVP 不需要讀取外部圖片。`package.json` 因此把該 transitive dependency 覆寫成 `vendor/image-size-disabled` 安全 stub；任何影像解析呼叫都會明確失敗。這可讓 `npm audit` 維持 0 漏洞，也避免未審核圖片進入解析器。

未來若加入程式碼截圖或外部資產，必須新增獨立的 raster asset adapter、格式 allowlist、像素與檔案大小上限，並移除或重新評估此 stub。

## 尚未涵蓋

- 深度 secret scanning（例如 Gitleaks）與 SBOM／license scanning 尚未內建。
- Windows ACL、網路 egress firewall 與獨立 sandbox 需由執行環境提供。
- 不保證所有文字中的秘密都能靠 regex 發現；來源 repo 仍應先自行清理。
- 不支援自動執行專案，因此不會錄製動態 UI 或真實測試畫面。

若發現安全問題，請先停止處理該 repo，保留 `state.json` 與 logs，且不要把可能含敏感內容的 `source-bundle.txt` 對外分享。
