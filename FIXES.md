# 錯誤修復說明

## 修復日期
2025-12-21

## 修復的問題

### 1. PDF 解析錯誤：DOMMatrix is not defined

**問題描述：**
```
Material upload error: Error: PDF parsing is disabled in this environment：DOMMatrix is not defined
    at Object.parsePDF (/home/ubuntu/lsa-platform/src/rag.js:65:11)
```

**根本原因：**
- `node_modules` 依賴包未安裝
- `pdf-parse` 模組無法載入

**解決方法：**
```bash
npm install
```

**驗證：**
- ✅ PDF parsing 功能現已正常運作
- ✅ 測試通過：`node test-rag.js` 顯示 "PDF parsing available: true"

---

### 2. HackMD 匯入錯誤：403 Forbidden

**問題描述：**
```
HackMD import error: Error: Failed to fetch HackMD: Request failed with status code 403
    at Object.fetchHackMD (/home/ubuntu/lsa-platform/src/rag.js:112:11)
```

**根本原因：**
- HackMD 文件設為私人，無法公開存取
- 未設定 `HACKMD_TOKEN` 環境變數

**解決方法：**

**選項 1：** 將 HackMD 文件設為公開
1. 開啟 HackMD 文件
2. 點選右上角「Share」按鈕
3. 將權限設為「Anyone can view」

**選項 2：** 設定 HACKMD_TOKEN
1. 前往 HackMD 設定頁面取得 API Token
2. 在 `.env` 檔案中加入：
   ```env
   HACKMD_TOKEN=your-hackmd-api-token-here
   ```
3. 重新啟動應用程式

---

## 額外改進

### 錯誤訊息優化

**改進前：**
- 錯誤訊息不夠清楚，使用者不知道如何解決

**改進後：**
- PDF 錯誤：明確提示改用 Markdown 或 TXT 格式
- HackMD 錯誤：提供詳細的解決步驟說明

**程式碼變更位置：**
- `src/app_rag_apis.js:112-130` - PDF 上傳錯誤處理
- `src/app_rag_apis.js:175-193` - HackMD 匯入錯誤處理

---

## 測試結果

```bash
# 測試 RAG 模組載入
$ node test-rag.js
Testing RAG module...

✓ RAG module loaded successfully
✓ PDF parsing available: true

All tests passed!
```

---

## 使用建議

1. **PDF 上傳功能已修復**
   - 現在可以正常上傳 PDF 檔案
   - 系統會自動解析 PDF 內容並加入向量資料庫

2. **HackMD 匯入功能**
   - 建議使用公開文件以避免 403 錯誤
   - 或設定 HACKMD_TOKEN 來存取私人文件

3. **替代方案**
   - 如果 PDF 或 HackMD 遇到問題，可以使用 Markdown (.md) 或純文字 (.txt) 格式上傳教材

---

## 相關檔案

- `src/rag.js` - RAG 核心模組（PDF 解析、HackMD 匯入）
- `src/app_rag_apis.js` - RAG API 端點（錯誤處理優化）
- `package.json` - 依賴套件配置
- `test-rag.js` - RAG 模組測試腳本（新增）
