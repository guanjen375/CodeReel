# TaskBoard

TaskBoard 是一個極小型任務 API，用來示範服務啟動、建立任務與讀取任務。

需求：

- Node.js 20 或更新版本
- 可用的 3030 連接埠

## 快速開始

在專案根目錄執行：

```bash
npm install
npm start
```

## 驗收

建立任務：

```bash
curl -X POST http://localhost:3030/tasks -d '{"title":"閱讀文件"}'
```

讀取任務：`curl http://localhost:3030/tasks`
