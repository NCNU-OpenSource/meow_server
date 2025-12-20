// src/app.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const cors = require('cors');

const { dbHelpers } = require('./db');
const { runSSH } = require('./ssh');
const {
  cloneVM,
  createSnapshot,
  rollbackToSnapshot,
  startVM,
  getVMIP,
  checkPVEConnection,
  PVE_CONFIG,
} = require('./pve');
const { pveQueue } = require('./queue');
const { registerRAGApis } = require('./app_rag_apis');

const app = express();

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret',
  resave: false,
  saveUninitialized: false,
}));

// 靜態頁
app.use(express.static(path.join(__dirname, '..', 'public')));

// === 小工具：權限 ===
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.status(401).json({ ok: false, error: '未登入' });
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.session?.user?.role === role) return next();
    return res.status(403).json({ ok: false, error: '權限不足' });
  };
}

// === 獲取學生 VM 連線資訊 ===
async function getStudentVmConn(studentId) {
  const assignment = await dbHelpers.getVmAssignment(studentId);
  if (!assignment || !assignment.vm_ip) {
    return null;
  }

  const host = assignment.vm_ip;
  const port = parseInt(process.env.VM_SSH_PORT || '22', 10);
  const username = process.env.VM_SSH_USER || 'trainer';
  const privateKeyPath = process.env.VM_SSH_KEY_PATH;

  if (!privateKeyPath) {
    return null;
  }

  return { host, port, username, privateKeyPath };
}

// === 執行腳本（支持 AI 生成的腳本或文件系統中的腳本）===
async function executeScript(conn, scriptContent, scriptPath, scriptType = 'fault') {
  if (!conn) {
    throw new Error('VM 連線資訊不存在');
  }

  try {
    if (scriptContent) {
      // AI 生成的腳本：寫入臨時文件並執行
      const tempPath = `/tmp/${scriptType}_${Date.now()}.sh`;

      // 1. 寫入腳本內容到 VM
      const writeCmd = `cat > ${tempPath} << 'EOFSCRIPT'\n${scriptContent}\nEOFSCRIPT`;
      await runSSH({ ...conn, command: writeCmd });

      // 2. 添加執行權限
      await runSSH({ ...conn, command: `chmod +x ${tempPath}` });

      // 3. 執行腳本
      const result = await runSSH({ ...conn, command: `sudo ${tempPath}` });

      // 4. 清理臨時文件
      await runSSH({ ...conn, command: `rm -f ${tempPath}` }).catch(() => {});

      return result;
    } else if (scriptPath) {
      // 使用文件系統中的腳本
      const cmd = `sudo ${scriptPath}`;
      return await runSSH({ ...conn, command: cmd });
    } else {
      throw new Error('沒有可執行的腳本內容或路徑');
    }
  } catch (error) {
    throw new Error(`腳本執行失敗: ${error.message}`);
  }
}

// === health check ===
app.get('/api/health', async (req, res) => {
  const pveStatus = await checkPVEConnection();
  res.json({ 
    ok: true, 
    time: new Date().toISOString(),
    pve: pveStatus,
  });
});

// === auth ===
app.post('/api/auth/login', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ ok: false, error: 'missing username' });

  const role = username.includes('teacher') ? 'teacher' : 'student';

  try {
    const user = await dbHelpers.getOrCreateUser(username, role);
    
    req.session.user = {
      id: user.id,
      role: user.role,
      username: user.username,
    };

    res.json({ ok: true, user: req.session.user });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ ok: true, user: req.session.user || null });
});

// === pages ===
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'views', 'login.html')));
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, '..', 'views', 'student.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(__dirname, '..', 'views', 'teacher.html')));

// =====================
// Student APIs
// =====================

// 題目列表
app.get('/api/student/questions', requireAuth, requireRole('student'), async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const progress = await dbHelpers.getProgress(studentId);
    const questions = await dbHelpers.getQuestions(true);

    const rows = await Promise.all(questions.map(async (q) => {
      const status = await dbHelpers.getQuestionStatus(studentId, q.id);
      return {
        id: q.id,
        title: q.title,
        difficulty: q.difficulty,
        type: q.type,
        fault_id: q.fault_id,
        check_id: q.check_id,
        status,
      };
    }));

    res.json({ 
      ok: true, 
      rows, 
      current_qid: progress.current_qid,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 單題內容
app.get('/api/student/questions/:qid', requireAuth, requireRole('student'), async (req, res) => {
  try {
    const qid = parseInt(req.params.qid, 10);
    const q = await dbHelpers.getQuestion(qid);
    if (!q) return res.status(404).json({ ok: false, error: '題目不存在' });
    
    res.json({ 
      ok: true, 
      q: { 
        id: q.id, 
        title: q.title, 
        difficulty: q.difficulty, 
        type: q.type, 
        fault_id: q.fault_id, 
        check_id: q.check_id, 
        body: q.body 
      } 
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 獲取 VM 連線資訊
app.get('/api/student/vm-info', requireAuth, requireRole('student'), async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const assignment = await dbHelpers.getVmAssignment(studentId);
    
    if (!assignment) {
      return res.json({ 
        ok: true, 
        assigned: false,
        message: '尚未分配 VM，請先按「開始訓練」',
      });
    }

    res.json({
      ok: true,
      assigned: true,
      vmid: assignment.vmid,
      vm_name: assignment.vm_name,
      vm_ip: assignment.vm_ip,
      snapshot_name: assignment.snapshot_name,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 開始訓練：分配 VM + clone + snapshot + 注入第一題 fault
app.post('/api/student/start', requireAuth, requireRole('student'), async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const username = req.session.user.username;

    // 檢查是否已經分配 VM
    let assignment = await dbHelpers.getVmAssignment(studentId);
    
    if (!assignment) {
      // 需要分配新 VM
      const questions = await dbHelpers.getQuestions(true);
      const first = questions[0];
      if (!first) return res.status(500).json({ ok: false, error: '題庫是空的' });

      // 使用佇列執行 PVE 操作
      await pveQueue.add(async () => {
        // Clone VM
        const cloneResult = await cloneVM(null, `student-${username}-${studentId}`);
        const newVmid = cloneResult.vmid;
        
        // 啟動 VM
        await startVM(newVmid);
        
        // 等待 VM 啟動並獲取 IP（可能需要一些時間）
        await new Promise(resolve => setTimeout(resolve, 10000)); // 等待 10 秒
        
        let vmIp = await getVMIP(newVmid);
        // 如果無法自動獲取 IP，使用配置的 IP 模式（需要手動配置）
        if (!vmIp) {
          vmIp = process.env.VM_IP_TEMPLATE 
            ? process.env.VM_IP_TEMPLATE.replace('{vmid}', newVmid)
            : null;
        }

        // 建立 clean_start snapshot
        await createSnapshot(newVmid, 'clean_start');

        // 記錄到數據庫
        await dbHelpers.createVmAssignment(
          studentId, 
          newVmid, 
          `student-${username}-${studentId}`,
          vmIp,
          'clean_start'
        );
      });

      assignment = await dbHelpers.getVmAssignment(studentId);
    }

    // 更新進度
    const questions = await dbHelpers.getQuestions(true);
    const first = questions[0];
    if (!first) return res.status(500).json({ ok: false, error: '題庫是空的' });

    await dbHelpers.updateProgress(studentId, first.id, true);

    // 注入第一題 fault
    const conn = await getStudentVmConn(studentId);
    let injectOutput = '';

    if (conn) {
      try {
        // 使用新的 executeScript 函數（支持 AI 腳本和文件腳本）
        const r = await executeScript(conn, first.fault_script, first.fault_path, 'fault');
        injectOutput = (r.stdout || r.stderr || '').trim();
      } catch (e) {
        injectOutput = `注入失敗: ${e.message}`;
      }
    } else {
      injectOutput = '[警告] 無法連線到 VM，請檢查 VM_SSH_KEY_PATH 和 VM IP 配置';
    }

    res.json({
      ok: true,
      current_qid: first.id,
      injected: first.fault_id,
      inject_output: injectOutput,
      vm_info: {
        vmid: assignment.vmid,
        vm_ip: assignment.vm_ip,
      },
    });
  } catch (error) {
    console.error('Start training error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 驗證當前題目（跑 check）
app.post('/api/student/verify', requireAuth, requireRole('student'), async (req, res) => {
  try {
    const { question_id } = req.body;
    const qid = parseInt(question_id, 10);
    const studentId = req.session.user.id;

    const q = await dbHelpers.getQuestion(qid);
    if (!q) return res.status(404).json({ ok: false, error: '題目不存在' });

    const conn = await getStudentVmConn(studentId);
    if (!conn) {
      // 記錄失敗嘗試
      await dbHelpers.recordAttempt(studentId, qid, false, '', '', '[dry-run] 未設定 VM 連線');
      return res.json({ 
        ok: true, 
        passed: false, 
        output: '[dry-run] 未設定 VM 連線，模擬 fail。' 
      });
    }

    try {
      // 使用新的 executeScript 函數（支持 AI 腳本和文件腳本）
      const r = await executeScript(conn, q.check_script, q.check_path, 'check');
      const passed = (r.code === 0);
      const output = (r.stdout || r.stderr || '').trim();

      // 記錄嘗試
      await dbHelpers.recordAttempt(studentId, qid, passed, r.stdout || '', r.stderr || '', output);

      res.json({
        ok: true,
        passed,
        output,
      });
    } catch (e) {
      await dbHelpers.recordAttempt(studentId, qid, false, '', e.message, '');
      res.status(500).json({ ok: false, error: `驗證失敗: ${e.message}` });
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 下一題：rollback + 注入下一題 fault
app.post('/api/student/next', requireAuth, requireRole('student'), async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const progress = await dbHelpers.getProgress(studentId);
    
    if (!progress.started) {
      return res.status(400).json({ ok: false, error: '尚未開始訓練' });
    }

    const questions = await dbHelpers.getQuestions(true);
    const currentIdx = questions.findIndex(q => q.id === progress.current_qid);
    const next = questions[currentIdx + 1];

    if (!next) {
      return res.json({ ok: true, done: true });
    }

    // 檢查當前題目是否通過
    const currentStatus = await dbHelpers.getQuestionStatus(studentId, progress.current_qid);
    if (currentStatus !== 'passed') {
      return res.status(400).json({ 
        ok: false, 
        error: '當前題目尚未通過驗證，無法進入下一題' 
      });
    }

    const assignment = await dbHelpers.getVmAssignment(studentId);
    if (!assignment) {
      return res.status(500).json({ ok: false, error: 'VM 未分配' });
    }

    // 使用佇列執行 rollback
    await pveQueue.add(async () => {
      await rollbackToSnapshot(assignment.vmid, assignment.snapshot_name);
    });

    // 更新進度
    await dbHelpers.updateProgress(studentId, next.id, true);

    // 注入下一題 fault
    const conn = await getStudentVmConn(studentId);
    let injectOutput = '';

    if (conn) {
      try {
        // 使用新的 executeScript 函數（支持 AI 腳本和文件腳本）
        const r = await executeScript(conn, next.fault_script, next.fault_path, 'fault');
        injectOutput = (r.stdout || r.stderr || '').trim();
      } catch (e) {
        injectOutput = `注入失敗: ${e.message}`;
      }
    } else {
      injectOutput = '[警告] 無法連線到 VM';
    }

    res.json({
      ok: true,
      done: false,
      current_qid: next.id,
      injected: next.fault_id,
      inject_output: injectOutput,
    });
  } catch (error) {
    console.error('Next question error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// =====================
// Teacher APIs
// =====================

// 題目列表（教師端）
app.get('/api/teacher/questions', requireAuth, requireRole('teacher'), async (req, res) => {
  try {
    const questions = await dbHelpers.getQuestions(false);
    res.json({ ok: true, rows: questions });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 教材列表（簡化版，保持兼容）
// =====================
// RAG / AI APIs（教材上傳、AI 出題、提示卡）
// =====================
registerRAGApis(app, requireAuth, requireRole);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  const hostLabel = HOST === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : HOST;
  console.log(`Server running on http://${hostLabel}:${PORT}`);
  if (['127.0.0.1', 'localhost'].includes(HOST)) {
    console.log('⚠️ Server is bound to localhost; remote devices will be unable to connect. Set HOST=0.0.0.0 to allow remote access.');
  }
  console.log(`PVE Config: ${PVE_CONFIG.host}:${PVE_CONFIG.port}`);
  console.log(`AI/RAG功能已啟用（需設定 OPENAI_API_KEY）`);
});
