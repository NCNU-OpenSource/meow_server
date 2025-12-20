// src/rag.js
// RAG (Retrieval-Augmented Generation) 服務
// 負責教材處理、向量化、檢索和 AI 出題

const OpenAI = require('openai');
const fs = require('fs').promises;

let pdfParse = null;
let pdfParseError = null;

function ensureDomPolyfills() {
  if (typeof DOMMatrix === 'undefined') {
    global.DOMMatrix = class DOMMatrix {
      constructor() {}
      multiply() { return this; }
      translate() { return this; }
      scale() { return this; }
      rotate() { return this; }
      skewX() { return this; }
      skewY() { return this; }
      inverse() { return this; }
      transformPoint(point = { x: 0, y: 0 }) { return point; }
      toFloat32Array() { return new Float32Array(16); }
      toFloat64Array() { return new Float64Array(16); }
    };
  }

  if (typeof Path2D === 'undefined') {
    global.Path2D = class Path2D {};
  }

  if (typeof ImageData === 'undefined') {
    global.ImageData = class ImageData {
      constructor(data, width, height) {
        this.data = data || null;
        this.width = width || 0;
        this.height = height || 0;
      }
    };
  }
}

ensureDomPolyfills();

try {
  pdfParse = require('pdf-parse');
} catch (error) {
  pdfParseError = error;
  console.warn('[RAG] pdf-parse 模組初始化失敗，PDF 解析功能將停用：', error.message);
  console.warn('       若需啟用，請升級至 Node.js 20+ 或在環境中提供 DOMMatrix / ImageData / Path2D polyfill。');
}

function isPDFParsingAvailable() {
  return Boolean(pdfParse);
}

// 初始化 OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'your-api-key-here'
});

// 簡易向量資料庫（記憶體版本）
// 生產環境建議使用 Pinecone, Weaviate, 或 ChromaDB
const vectorStore = {
  documents: [],
  embeddings: []
};

/**
 * 從文字內容提取 chunks
 * @param {string} text - 原始文字
 * @param {number} chunkSize - 每個 chunk 的大小（字元數）
 * @returns {Array<string>} - 切分後的 chunks
 */
function chunkText(text, chunkSize = 500) {
  const chunks = [];
  const lines = text.split('\n');
  let currentChunk = '';

  for (const line of lines) {
    if ((currentChunk + line).length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = line;
    } else {
      currentChunk += '\n' + line;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * 解析 PDF 檔案
 * @param {Buffer} buffer - PDF 檔案 buffer
 * @returns {Promise<string>} - 提取的文字
 */
async function parsePDF(buffer) {
  if (!pdfParse) {
    const error = new Error(`PDF 解析功能目前停用：${pdfParseError?.message || '缺少 DOM API polyfill 或 Node.js 版本過低'}。請改用 Markdown / TXT 上傳，或升級到 Node.js 20 並提供 DOMMatrix polyfill。`);
    error.statusCode = 503;
    throw error;
  }

  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (error) {
    throw new Error(`PDF parsing failed: ${error.message}`);
  }
}

/**
 * 解析 Markdown 文字
 * @param {string} markdown - Markdown 內容
 * @returns {string} - 純文字
 */
function parseMarkdown(markdown = '') {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')     // 移除程式碼區塊
    .replace(/`([^`]+)`/g, '$1')         // 反引號
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')// 圖片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 連結
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // 粗斜體
    .replace(/^\s{0,3}>\s?/gm, '')       // 引言
    .replace(/^\s{0,3}[-*+]\s+/gm, '')   // 無序清單
    .replace(/^\s*\d+\.\s+/gm, '')       // 有序清單
    .replace(/#{1,6}\s*/g, '')           // 標題
    .replace(/<\/?[^>]+(>|$)/g, ' ')     // HTML 標籤
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 從 HackMD URL 獲取內容
 * @param {string} url - HackMD URL
 * @returns {Promise<string>} - Markdown 內容
 */
async function fetchHackMD(url) {
  const axios = require('axios');
  const headers = { 'User-Agent': 'meow-server-rag' };

  // HackMD URL 格式: https://hackmd.io/@user/note
  // 轉換為 raw 格式: https://hackmd.io/@user/note/download
  const rawUrl = url.endsWith('/download') ? url : `${url}/download`;

  const tryHackMDAPI = async () => {
    const token = process.env.HACKMD_TOKEN;
    if (!token) return null;

    const noteId = (() => {
      try {
        const { pathname } = new URL(url);
        const segments = pathname.split('/').filter(Boolean);
        return segments[segments.length - 1];
      } catch (e) {
        return null;
      }
    })();

    if (!noteId) return null;

    const apiUrl = `https://api.hackmd.io/v1/notes/${noteId}`;
    const response = await axios.get(apiUrl, {
      headers: { ...headers, Authorization: `Bearer ${token}` }
    });

    if (response.data?.content) {
      return response.data.content;
    }

    throw new Error('HackMD API 回傳空內容，請確認 noteId 是否正確');
  };

  try {
    const response = await axios.get(rawUrl, { headers });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const networkCodes = new Set(['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

    if (status === 403) {
      try {
        const apiContent = await tryHackMDAPI();
        if (apiContent) return apiContent;
      } catch (apiError) {
        const friendlyError = new Error(`Failed to fetch HackMD via API: ${apiError.message}`);
        friendlyError.statusCode = apiError.response?.status || 403;
        throw friendlyError;
      }

      const friendlyError = new Error('Failed to fetch HackMD: 403 Forbidden，請確認文件已設為公開，或在環境變數 HACKMD_TOKEN 中提供存取權杖以讀取私人文件');
      friendlyError.statusCode = 403;
      throw friendlyError;
    }

    const isNetwork = networkCodes.has(error.code);
    const fallbackError = new Error(
      isNetwork
        ? `Failed to fetch HackMD: 網路連線失敗（${error.code || 'unknown'}），請稍後再試或確認伺服器能連線 HackMD。`
        : `Failed to fetch HackMD: ${error.message}`
    );
    fallbackError.statusCode = status || (isNetwork ? 502 : undefined);
    const fallbackError = new Error(`Failed to fetch HackMD: ${error.message}`);
    fallbackError.statusCode = status;
    throw fallbackError;
  }
}

/**
 * 生成文字的 embedding
 * @param {string} text - 文字內容
 * @returns {Promise<Array<number>>} - 向量
 */
async function createEmbedding(text) {
  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: text,
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('Embedding creation failed:', error.message);
    // 如果 API 失敗，返回假的向量（開發用）
    return Array(1536).fill(0).map(() => Math.random());
  }
}

/**
 * 計算兩個向量的餘弦相似度
 * @param {Array<number>} a - 向量 A
 * @param {Array<number>} b - 向量 B
 * @returns {number} - 相似度 (0-1)
 */
function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * 將教材加入向量資料庫
 * @param {string} content - 教材內容
 * @param {object} metadata - 教材元資料
 */
async function addToVectorStore(content, metadata = {}) {
  const chunks = chunkText(content);

  for (const chunk of chunks) {
    const embedding = await createEmbedding(chunk);
    vectorStore.documents.push({
      content: chunk,
      metadata,
      timestamp: new Date()
    });
    vectorStore.embeddings.push(embedding);
  }

  return {
    chunksAdded: chunks.length,
    totalChunks: vectorStore.documents.length
  };
}

/**
 * 檢索相關內容
 * @param {string} query - 查詢文字
 * @param {number} topK - 返回前 K 個結果
 * @returns {Promise<Array>} - 相關文件
 */
async function retrieve(query, topK = 3) {
  if (vectorStore.documents.length === 0) {
    return [];
  }

  const queryEmbedding = await createEmbedding(query);

  // 計算所有文件的相似度
  const similarities = vectorStore.embeddings.map((embedding, index) => ({
    index,
    similarity: cosineSimilarity(queryEmbedding, embedding),
    document: vectorStore.documents[index]
  }));

  // 排序並返回 topK
  return similarities
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
    .map(item => ({
      content: item.document.content,
      metadata: item.document.metadata,
      similarity: item.similarity
    }));
}

/**
 * 使用 RAG 生成題目
 * @param {string} topic - 題目主題
 * @param {Array} availableFaults - 可用的 fault 腳本列表
 * @returns {Promise<object>} - 生成的題目
 */
async function generateQuestion(topic, availableFaults) {
  // 檢索相關教材
  const relevantDocs = await retrieve(topic, 3);
  const context = relevantDocs.map(doc => doc.content).join('\n\n');

  // 準備 fault 列表
  const faultList = availableFaults.map(f =>
    `- ${f.fault_id}: ${f.description || f.type}`
  ).join('\n');

  const prompt = `你是一個 Linux 系統管理教學專家。根據以下教材內容，生成一個實作題目。

教材內容：
${context || '（無相關教材，請根據主題生成）'}

主題：${topic}

可用的故障腳本：
${faultList}

請生成一個題目，包含：
1. 題目標題（簡短有力）
2. 題目描述（清楚說明學生要修復什麼問題）
3. 難度（easy/medium/hard）
4. 選擇最適合的 fault_id
5. 學習目標

回傳 JSON 格式：
{
  "title": "題目標題",
  "body": "題目描述（包含情境和提示）",
  "difficulty": "easy",
  "fault_id": "fault_XX",
  "learning_objectives": ["目標1", "目標2"]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "你是一個專業的 Linux 系統管理教學助理，擅長設計實作題目。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(response.choices[0].message.content);
    return result;
  } catch (error) {
    console.error('Question generation failed:', error.message);
    // 如果 API 失敗，返回預設題目
    return {
      title: `${topic} 故障排除`,
      body: `系統發生 ${topic} 相關問題，請診斷並修復。\n\n提示：檢查相關服務和配置檔案。`,
      difficulty: 'medium',
      fault_id: availableFaults[0]?.fault_id || 'fault_01',
      learning_objectives: [`理解 ${topic} 的運作原理`, '掌握故障排除技巧']
    };
  }
}

/**
 * 生成 SRL 提示卡（Self-Regulated Learning）
 * @param {object} question - 題目資訊
 * @param {number} attemptCount - 學生嘗試次數
 * @returns {Promise<object>} - 提示卡內容
 */
async function generateHint(question, attemptCount = 0) {
  const hintLevels = ['subtle', 'detailed', 'solution'];
  const level = hintLevels[Math.min(attemptCount, 2)];

  const prompt = `你是一個教學助理，使用 SRL (Self-Regulated Learning) 方法協助學生。

題目：${question.title}
描述：${question.body}

學生已嘗試 ${attemptCount + 1} 次。

請根據 SRL 原則，提供${level === 'subtle' ? '模糊' : level === 'detailed' ? '詳細' : '解答步驟'}提示：

- subtle (第一次)：引導思考方向，不直接給答案
- detailed (第二次)：提供更具體的診斷方法
- solution (第三次)：提供完整的解決步驟

回傳 JSON 格式：
{
  "hint_level": "${level}",
  "hint_text": "提示內容",
  "next_steps": ["建議步驟1", "建議步驟2"]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "你是一個擅長 SRL 教學法的助教，會循序漸進地引導學生。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      response_format: { type: "json_object" }
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error('Hint generation failed:', error.message);
    // 返回預設提示
    const defaultHints = {
      subtle: {
        hint_level: 'subtle',
        hint_text: '想想這個問題可能與哪個系統服務或配置檔案有關？',
        next_steps: ['檢查系統日誌', '確認服務狀態']
      },
      detailed: {
        hint_level: 'detailed',
        hint_text: '使用 systemctl 或相關命令檢查服務狀態，查看配置檔案是否正確。',
        next_steps: ['執行診斷命令', '檢查配置檔案語法']
      },
      solution: {
        hint_level: 'solution',
        hint_text: '完整解決步驟請參考 check 腳本的提示訊息。',
        next_steps: ['按照步驟執行', '驗證修復結果']
      }
    };
    return defaultHints[level];
  }
}

/**
 * 批量生成題目
 * @param {Array} topics - 主題列表
 * @param {Array} availableFaults - 可用的 fault 腳本
 * @param {number} count - 生成數量
 * @returns {Promise<Array>} - 生成的題目列表
 */
async function batchGenerateQuestions(topics, availableFaults, count = 10) {
  const questions = [];

  for (let i = 0; i < count && i < topics.length; i++) {
    const question = await generateQuestion(topics[i], availableFaults);
    questions.push(question);
    // 避免 API rate limit
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return questions;
}

/**
 * 使用 AI 生成 fault 腳本（破壞系統的腳本）
 * @param {string} topic - 題目主題
 * @param {object} questionData - 題目資訊
 * @returns {Promise<string>} - 生成的 bash 腳本
 */
async function generateFaultScript(topic, questionData) {
  // 檢索相關教材
  const relevantDocs = await retrieve(topic, 3);
  const context = relevantDocs.map(doc => doc.content).join('\n\n');

  const prompt = `你是一個 Linux 系統管理專家。請根據以下題目生成一個 fault 腳本（故障注入腳本）。

題目資訊：
- 標題：${questionData.title}
- 描述：${questionData.body}
- 難度：${questionData.difficulty}
- 主題：${topic}

相關教材：
${context || '（無相關教材）'}

請生成一個 bash 腳本來創建這個故障。腳本要求：

1. **安全性**：
   - 不要刪除關鍵系統檔案（/etc/passwd, /etc/shadow, /boot 等）
   - 不要破壞整個系統
   - 只修改與題目相關的配置

2. **可逆性**：
   - 故障必須可以由學生修復
   - 避免造成永久性損害

3. **典型故障類型**：
   - 服務配置錯誤（配置檔案語法錯誤、參數錯誤）
   - 服務未啟動或停止
   - 權限問題（檔案或目錄權限不正確）
   - 網路配置錯誤
   - 環境變數問題
   - 套件相關問題

4. **腳本格式**：
   - 必須以 #!/bin/bash 開頭
   - 加上適當的錯誤處理
   - 加上註解說明每個步驟
   - 在開頭輸出 "Injecting fault: [故障描述]"

請直接生成 bash 腳本，不要用 markdown 格式包裹。`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "你是一個 Linux 系統管理專家，擅長創建教學用的故障場景。請只輸出 bash 腳本，不要包含其他解釋。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
    });

    let script = response.choices[0].message.content.trim();

    // 清理 markdown 格式（如果有）
    script = script.replace(/^```bash\n?/gm, '').replace(/^```\n?/gm, '');

    // 確保有 shebang
    if (!script.startsWith('#!/bin/bash')) {
      script = '#!/bin/bash\n\n' + script;
    }

    return script;
  } catch (error) {
    console.error('Fault script generation failed:', error.message);
    // 返回預設的簡單故障腳本
    return `#!/bin/bash
# 預設故障腳本 - ${topic}

echo "Injecting fault: ${questionData.title}"

# 停止相關服務（示例）
systemctl stop nginx 2>/dev/null || true

echo "Fault injection completed"
`;
  }
}

/**
 * 使用 AI 生成 check 腳本（驗證修復的腳本）
 * @param {string} topic - 題目主題
 * @param {object} questionData - 題目資訊
 * @param {string} faultScript - 對應的 fault 腳本
 * @returns {Promise<string>} - 生成的驗證腳本
 */
async function generateCheckScript(topic, questionData, faultScript) {
  const prompt = `你是一個 Linux 系統管理專家。請根據以下題目和 fault 腳本，生成一個 check 腳本（驗證修復的腳本）。

題目資訊：
- 標題：${questionData.title}
- 描述：${questionData.body}
- 難度：${questionData.difficulty}

對應的 fault 腳本：
\`\`\`bash
${faultScript}
\`\`\`

請生成一個 bash 腳本來檢查學生是否成功修復了問題。腳本要求：

1. **檢查項目**：
   - 驗證服務是否正常運行
   - 檢查配置檔案是否正確
   - 驗證權限設定
   - 測試功能是否正常

2. **輸出格式**：
   - 如果修復成功：輸出 "PASS" 並以 exit 0 結束
   - 如果修復失敗：輸出具體的錯誤訊息並以 exit 1 結束
   - 可以提供多個檢查點，每個都有清楚的訊息

3. **腳本格式**：
   - 必須以 #!/bin/bash 開頭
   - 使用 set -e 確保錯誤時停止（但在需要繼續的地方用 || true）
   - 加上註解說明每個檢查步驟

4. **提供提示**：
   - 如果檢查失敗，給出有幫助的提示
   - 不要直接給出答案，但要指出問題方向

請直接生成 bash 腳本，不要用 markdown 格式包裹。`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "你是一個 Linux 系統管理專家，擅長創建驗證腳本。請只輸出 bash 腳本，不要包含其他解釋。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
    });

    let script = response.choices[0].message.content.trim();

    // 清理 markdown 格式（如果有）
    script = script.replace(/^```bash\n?/gm, '').replace(/^```\n?/gm, '');

    // 確保有 shebang
    if (!script.startsWith('#!/bin/bash')) {
      script = '#!/bin/bash\n\n' + script;
    }

    return script;
  } catch (error) {
    console.error('Check script generation failed:', error.message);
    // 返回預設的檢查腳本
    return `#!/bin/bash
# 預設檢查腳本 - ${topic}

# 檢查服務狀態（示例）
if systemctl is-active --quiet nginx; then
    echo "PASS: Service is running"
    exit 0
else
    echo "FAIL: Service is not running"
    echo "Hint: Check service status with 'systemctl status nginx'"
    exit 1
fi
`;
  }
}

/**
 * 使用 AI 完整生成題目（包含題目內容和腳本）
 * @param {string} topic - 題目主題
 * @returns {Promise<object>} - 包含題目和腳本的完整資料
 */
async function generateQuestionWithScripts(topic) {
  // 1. 生成題目內容（不需要 availableFaults，因為我們要生成新腳本）
  const questionData = await generateQuestion(topic, []);

  // 2. 生成 fault 腳本
  const faultScript = await generateFaultScript(topic, questionData);

  // 3. 生成 check 腳本
  const checkScript = await generateCheckScript(topic, questionData, faultScript);

  // 4. 生成唯一的 ID
  const timestamp = Date.now();
  const faultId = `ai_fault_${timestamp}`;
  const checkId = `ai_check_${timestamp}`;

  return {
    // 題目資訊
    title: questionData.title,
    body: questionData.body,
    difficulty: questionData.difficulty,
    type: 'ai-generated',
    learning_objectives: questionData.learning_objectives,

    // 腳本
    fault_id: faultId,
    fault_script: faultScript,
    check_id: checkId,
    check_script: checkScript,

    // 元資料
    generated_at: new Date().toISOString(),
    topic: topic
  };
}

module.exports = {
  parsePDF,
  parseMarkdown,
  fetchHackMD,
  addToVectorStore,
  retrieve,
  generateQuestion,
  generateHint,
  batchGenerateQuestions,
  generateFaultScript,
  generateCheckScript,
  generateQuestionWithScripts,
  vectorStore, // 用於測試
  isPDFParsingAvailable
};
