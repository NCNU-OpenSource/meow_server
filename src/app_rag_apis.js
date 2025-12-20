// src/app_rag_apis.js
// RAG 和 AI 出題相關的 API 端點
// 這個檔案會被 app.js 引入

const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const rag = require('./rag');
const { pool } = require('./db');

// 設定檔案上傳
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.pdf', '.md', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, Markdown, and TXT files are allowed'));
    }
  }
});

/**
 * 註冊 RAG 相關的 API 路由
 * @param {Express.Application} app - Express app
 * @param {Function} requireAuth - 認證中間件
 * @param {Function} requireRole - 角色檢查中間件
 */
function registerRAGApis(app, requireAuth, requireRole) {

  // =====================
  // 教材管理 APIs
  // =====================

  /**
   * POST /api/teacher/materials/upload
   * 上傳教材檔案（PDF/Markdown）
   */
  app.post('/api/teacher/materials/upload',
    requireAuth,
    requireRole('teacher'),
    upload.single('file'),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ ok: false, error: '沒有上傳檔案' });
        }

        const { title, description } = req.body;
        const filePath = req.file.path;
        const fileType = path.extname(req.file.originalname).toLowerCase();

        // 解析檔案內容
        let content = '';
        if (fileType === '.pdf') {
          if (!rag.isPDFParsingAvailable()) {
            const error = new Error('目前環境無法解析 PDF，請改用 Markdown / TXT，或於伺服器提供 DOMMatrix polyfill 後再試。');
            error.statusCode = 503;
            throw error;
          }

          const buffer = await fs.readFile(filePath);
          content = await rag.parsePDF(buffer);
        } else {
          content = await fs.readFile(filePath, 'utf-8');
          if (fileType === '.md') {
            content = rag.parseMarkdown(content);
          }
        }

        // 加入向量資料庫
        const result = await rag.addToVectorStore(content, {
          title: title || req.file.originalname,
          description,
          uploadedBy: req.session.user.id,
          type: 'file',
          originalName: req.file.originalname
        });

        // 儲存教材記錄到資料庫
        const [dbResult] = await pool.query(
          `INSERT INTO materials (title, content, file_path, uploaded_by, type)
           VALUES (?, ?, ?, ?, ?)`,
          [title || req.file.originalname, content.substring(0, 5000), filePath, req.session.user.id, 'file']
        );

        res.json({
          ok: true,
          materialId: dbResult.insertId,
          chunksAdded: result.chunksAdded,
          message: '教材上傳成功'
        });
      } catch (error) {
        console.error('Material upload error:', error);
        const status = error.statusCode || 500;
        if (req.file?.path) {
          // 清理上傳檔案以免佔用空間
          fs.unlink(req.file.path).catch(() => {});
        }
        res.status(status).json({ ok: false, error: error.message });
      }
    }
  );

  /**
   * POST /api/teacher/materials/hackmd
   * 從 HackMD URL 匯入教材
   */
  app.post('/api/teacher/materials/hackmd',
    requireAuth,
    requireRole('teacher'),
    async (req, res) => {
      try {
        const { url, title, description } = req.body;

        if (!url) {
          return res.status(400).json({ ok: false, error: '需要 HackMD URL' });
        }

        // 獲取 HackMD 內容
        const markdown = await rag.fetchHackMD(url);
        const content = rag.parseMarkdown(markdown);

        // 加入向量資料庫
        const result = await rag.addToVectorStore(content, {
          title: title || 'HackMD 教材',
          description,
          uploadedBy: req.session.user.id,
          type: 'hackmd',
          source: url
        });

        // 儲存到資料庫
        const [dbResult] = await pool.query(
          `INSERT INTO materials (title, content, source_url, uploaded_by, type)
           VALUES (?, ?, ?, ?, ?)`,
          [title || 'HackMD 教材', content.substring(0, 5000), url, req.session.user.id, 'hackmd']
        );

        res.json({
          ok: true,
          materialId: dbResult.insertId,
          chunksAdded: result.chunksAdded,
          message: 'HackMD 教材匯入成功'
        });
      } catch (error) {
        console.error('HackMD import error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({ ok: false, error: error.message });
      }
    }
  );

  /**
   * GET /api/teacher/materials
   * 獲取教材列表（已在原 app.js 中，這裡更新實作）
   */
  app.get('/api/teacher/materials',
    requireAuth,
    requireRole('teacher'),
    async (req, res) => {
      try {
        const [rows] = await pool.query(
          `SELECT m.*, u.username as uploaded_by_name
           FROM materials m
           LEFT JOIN users u ON m.uploaded_by = u.id
           ORDER BY m.created_at DESC`
        );
        res.json({ ok: true, rows });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    }
  );

  // =====================
  // AI 出題 APIs
  // =====================

  /**
   * POST /api/teacher/questions/generate
   * 使用 AI 生成題目（包含腳本）
   */
  app.post('/api/teacher/questions/generate',
    requireAuth,
    requireRole('teacher'),
    async (req, res) => {
      try {
        const { topic, count = 1, useAIScripts = true } = req.body;

        if (!topic) {
          return res.status(400).json({ ok: false, error: '需要題目主題' });
        }

        const generatedQuestions = [];

        if (useAIScripts) {
          // 使用 AI 生成完整題目（包含腳本）
          for (let i = 0; i < count; i++) {
            const question = await rag.generateQuestionWithScripts(topic);
            generatedQuestions.push(question);

            // 避免 rate limit
            if (i < count - 1) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
        } else {
          // 舊方式：只生成題目，使用已有的腳本
          const [faults] = await pool.query(
            `SELECT DISTINCT fault_id, type, difficulty FROM questions ORDER BY id`
          );

          const availableFaults = faults.map(f => ({
            fault_id: f.fault_id,
            type: f.type,
            description: `${f.difficulty} level ${f.type} fault`
          }));

          for (let i = 0; i < count; i++) {
            const question = await rag.generateQuestion(topic, availableFaults);

            // 找到對應的 fault 和 check 路徑
            const [existingQ] = await pool.query(
              `SELECT fault_path, check_path, check_id FROM questions WHERE fault_id = ? LIMIT 1`,
              [question.fault_id]
            );

            if (existingQ.length > 0) {
              question.fault_path = existingQ[0].fault_path;
              question.check_path = existingQ[0].check_path;
              question.check_id = existingQ[0].check_id;
            } else {
              question.fault_path = `/opt/faults/${question.fault_id}.sh`;
              question.check_path = `/opt/checks/check_${question.fault_id.replace('fault_', '')}.sh`;
              question.check_id = `check_${question.fault_id.replace('fault_', '')}`;
            }

            question.type = question.type || 'ai-generated';
            generatedQuestions.push(question);

            // 避免 rate limit
            if (i < count - 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }

        res.json({
          ok: true,
          questions: generatedQuestions,
          message: `成功生成 ${generatedQuestions.length} 個題目${useAIScripts ? '（含 AI 腳本）' : ''}`
        });
      } catch (error) {
        console.error('Question generation error:', error);
        res.status(500).json({ ok: false, error: error.message });
      }
    }
  );

  /**
   * POST /api/teacher/questions/save-generated
   * 儲存 AI 生成的題目到資料庫（包含腳本內容）
   */
  app.post('/api/teacher/questions/save-generated',
    requireAuth,
    requireRole('teacher'),
    async (req, res) => {
      try {
        const { questions } = req.body;

        if (!Array.isArray(questions) || questions.length === 0) {
          return res.status(400).json({ ok: false, error: '需要題目陣列' });
        }

        const savedIds = [];
        for (const q of questions) {
          // 檢查是否有 AI 生成的腳本
          const hasScripts = q.fault_script && q.check_script;

          if (hasScripts) {
            // 有 AI 腳本：保存腳本內容到數據庫
            const [result] = await pool.query(
              `INSERT INTO questions (title, body, difficulty, type, fault_id, fault_path, fault_script, check_id, check_path, check_script, enabled)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                q.title,
                q.body,
                q.difficulty || 'medium',
                q.type || 'ai-generated',
                q.fault_id,
                q.fault_path || null, // AI 生成的題目可能沒有實體檔案路徑
                q.fault_script,
                q.check_id,
                q.check_path || null,
                q.check_script,
                1
              ]
            );
            savedIds.push(result.insertId);
          } else {
            // 沒有 AI 腳本：使用舊方式保存（只保存路徑）
            const [result] = await pool.query(
              `INSERT INTO questions (title, body, difficulty, type, fault_id, fault_path, check_id, check_path, enabled)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                q.title,
                q.body,
                q.difficulty || 'medium',
                q.type || 'ai-generated',
                q.fault_id,
                q.fault_path,
                q.check_id,
                q.check_path,
                1
              ]
            );
            savedIds.push(result.insertId);
          }
        }

        res.json({
          ok: true,
          savedCount: savedIds.length,
          questionIds: savedIds,
          message: '題目已儲存'
        });
      } catch (error) {
        console.error('Save questions error:', error);
        res.status(500).json({ ok: false, error: error.message });
      }
    }
  );

  // =====================
  // SRL 提示卡 APIs
  // =====================

  /**
   * POST /api/student/hint
   * 獲取 SRL 提示卡
   */
  app.post('/api/student/hint',
    requireAuth,
    requireRole('student'),
    async (req, res) => {
      try {
        const { question_id } = req.body;
        const studentId = req.session.user.id;

        // 獲取題目資訊
        const [questions] = await pool.query(
          `SELECT * FROM questions WHERE id = ?`,
          [question_id]
        );

        if (questions.length === 0) {
          return res.status(404).json({ ok: false, error: '題目不存在' });
        }

        const question = questions[0];

        // 獲取學生該題的嘗試次數
        const [attempts] = await pool.query(
          `SELECT COUNT(*) as count FROM attempts
           WHERE student_id = ? AND question_id = ? AND passed = 0`,
          [studentId, question_id]
        );

        const attemptCount = attempts[0].count;

        // 生成提示
        const hint = await rag.generateHint(question, attemptCount);

        // 記錄提示使用
        await pool.query(
          `INSERT INTO hints (student_id, question_id, hint_level, hint_text)
           VALUES (?, ?, ?, ?)`,
          [studentId, question_id, hint.hint_level, hint.hint_text]
        );

        res.json({
          ok: true,
          hint
        });
      } catch (error) {
        console.error('Hint generation error:', error);
        res.status(500).json({ ok: false, error: error.message });
      }
    }
  );

  /**
   * GET /api/teacher/rag/stats
   * 獲取 RAG 系統統計資訊
   */
  app.get('/api/teacher/rag/stats',
    requireAuth,
    requireRole('teacher'),
    async (req, res) => {
      try {
        const [materialCount] = await pool.query(`SELECT COUNT(*) as count FROM materials`);
        const [questionCount] = await pool.query(`SELECT COUNT(*) as count FROM questions WHERE type = 'ai-generated'`);

        res.json({
          ok: true,
          stats: {
            totalMaterials: materialCount[0].count,
            totalChunks: rag.vectorStore.documents.length,
            aiGeneratedQuestions: questionCount[0].count,
            vectorStoreSize: rag.vectorStore.embeddings.length
          }
        });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    }
  );

  attachRagConfigRoute(app, requireAuth, requireRole);
}

/**
 * 將 RAG 設定能力路由掛載到 app（獨立定義避免 module 載入時引用 app）
 */
function attachRagConfigRoute(app, requireAuth, requireRole) {
  if (!app) {
    throw new Error('attachRagConfigRoute 需要有效的 app 物件');
  }

  app.get('/api/teacher/rag/config',
    requireAuth,
    requireRole('teacher'),
    async (req, res) => {
      try {
        res.json({
          ok: true,
          pdfParsingAvailable: rag.isPDFParsingAvailable(),
          hackmdTokenConfigured: Boolean(process.env.HACKMD_TOKEN)
        });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    }
  );
}

module.exports = { registerRAGApis };
