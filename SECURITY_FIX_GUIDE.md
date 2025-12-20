# 登入安全性修復指南

## 問題描述

原始系統存在嚴重的安全漏洞：
1. **無密碼驗證** - 任何人只需輸入使用者名稱即可登入
2. **自動創建帳號** - 不存在的使用者會被自動創建
3. **無 SQL Injection 防護** - 使用 parameterized queries 但仍有風險

## 修復內容 (2025-12-20)

### 1. 新增密碼驗證機制

#### 修改文件：`src/app.js`
**之前的程式碼**:
```javascript
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
```

**修復後的程式碼**:
```javascript
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username) return res.status(400).json({ ok: false, error: 'missing username' });
  if (!password) return res.status(400).json({ ok: false, error: 'missing password' });

  try {
    const user = await dbHelpers.verifyUser(username, password);

    if (!user) {
      return res.status(401).json({ ok: false, error: '帳號或密碼錯誤' });
    }

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
```

### 2. 新增 bcrypt 密碼加密

#### 安裝依賴
```bash
npm install bcrypt
```

#### 修改文件：`src/db.js`
新增以下函數：

```javascript
// 創建新用戶（含密碼）
createUser: async (username, password, role) => {
  const bcrypt = require('bcrypt');
  const password_hash = await bcrypt.hash(password, 10);

  const [result] = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
    [username, password_hash, role]
  );

  const [newRows] = await pool.query(`SELECT * FROM users WHERE id = ?`, [result.insertId]);
  return newRows[0];
},

// 更新用戶密碼
updateUserPassword: async (username, password) => {
  const bcrypt = require('bcrypt');
  const password_hash = await bcrypt.hash(password, 10);

  const [result] = await pool.query(
    `UPDATE users SET password_hash = ? WHERE username = ?`,
    [password_hash, username]
  );

  return result.affectedRows > 0;
},

// 驗證用戶登入
verifyUser: async (username, password) => {
  const bcrypt = require('bcrypt');
  const [rows] = await pool.query(`SELECT * FROM users WHERE username = ?`, [username]);

  if (!rows[0]) {
    return null; // 用戶不存在
  }

  const user = rows[0];

  // 如果用戶沒有設置密碼（舊數據），自動設置密碼為用戶名
  if (!user.password_hash) {
    await pool.query(
      `UPDATE users SET password_hash = ? WHERE id = ?`,
      [await bcrypt.hash(username, 10), user.id]
    );
    user.password_hash = await bcrypt.hash(username, 10);
  }

  // 驗證密碼
  const isValid = await bcrypt.compare(password, user.password_hash);

  if (!isValid) {
    return null; // 密碼錯誤
  }

  return user;
},
```

### 3. 初始化現有用戶的密碼

建立了 `init_passwords.js` 腳本來為所有沒有密碼的用戶設置預設密碼（密碼 = 用戶名）。

```bash
node init_passwords.js
```

## 測試結果

### ✅ 通過的測試

#### 測試 1: 正確的帳號密碼
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"teacher","password":"teacher"}'
```
**結果**: `{"ok":true,"user":{"id":4,"role":"teacher","username":"teacher"}}`

#### 測試 2: 錯誤的密碼
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"teacher","password":"wrongpassword"}'
```
**結果**: `{"ok":false,"error":"帳號或密碼錯誤"}`

#### 測試 3: 不存在的帳號
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"hacker123","password":"password"}'
```
**結果**: `{"ok":false,"error":"帳號或密碼錯誤"}`

#### 測試 4: SQL Injection 防護
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin\" OR \"1\"=\"1","password":"anything"}'
```
**結果**: `{"ok":false,"error":"帳號或密碼錯誤"}`

## 預設帳號密碼

所有現有用戶的預設密碼都已設置為其使用者名稱：

| 使用者名稱 | 角色 | 密碼 |
|-----------|------|------|
| teacher | teacher | teacher |
| teacher1 | teacher | teacher1 |
| student | student | student |
| student1 | student | student1 |
| student2 | student | student2 |
| bob | student | bob |
| uytrew | student | uytrew |

**⚠️ 重要安全建議**:
1. 所有用戶應在首次登入後立即修改密碼
2. 建議實作密碼修改功能
3. 建議實作密碼強度檢查（最少 8 字元、包含大小寫字母和數字）
4. 考慮實作登入失敗次數限制和帳號鎖定機制

## 安全性提升

### 修復前
- ❌ 無需密碼即可登入
- ❌ 任何人都能創建帳號
- ❌ 無登入失敗記錄
- ❌ Session 無過期時間

### 修復後
- ✅ 需要正確的密碼才能登入
- ✅ 密碼使用 bcrypt 加密（salt rounds = 10）
- ✅ 防止 SQL Injection（使用 parameterized queries）
- ✅ 統一的錯誤訊息（防止帳號枚舉）
- ✅ 401 狀態碼表示認證失敗

## 後續建議

### 1. 實作密碼修改功能
建議新增以下 API：
```javascript
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const username = req.session.user.username;

  // 驗證舊密碼
  const user = await dbHelpers.verifyUser(username, oldPassword);
  if (!user) {
    return res.status(401).json({ ok: false, error: '舊密碼錯誤' });
  }

  // 更新密碼
  await dbHelpers.updateUserPassword(username, newPassword);

  res.json({ ok: true, message: '密碼已更新' });
});
```

### 2. 實作註冊功能（教師端）
教師應該能夠創建學生帳號並設定初始密碼：
```javascript
app.post('/api/teacher/students/create', requireAuth, requireRole('teacher'), async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await dbHelpers.createUser(username, password, 'student');
    res.json({ ok: true, user: { id: user.id, username: user.username } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});
```

### 3. 實作登入失敗限制
防止暴力破解攻擊：
- 同一 IP 地址 5 次失敗後鎖定 15 分鐘
- 同一帳號 3 次失敗後鎖定 5 分鐘
- 記錄所有失敗的登入嘗試

### 4. Session 安全性
- 設定 Session 過期時間（建議 30 分鐘無活動自動登出）
- 使用 HTTPS（生產環境必須）
- 設定 Cookie 的 `secure` 和 `httpOnly` 屬性

### 5. 密碼政策
- 最少 8 字元
- 至少包含一個大寫字母
- 至少包含一個小寫字母
- 至少包含一個數字
- 至少包含一個特殊字元（可選）

### 6. 雙因素認證 (2FA)
考慮為教師帳號實作 2FA 以提升安全性。

## 清理測試帳號

建議刪除測試和惡意帳號：
```bash
mysql -u lsa -plsa123 -D lsa -e "DELETE FROM users WHERE username IN ('test\\' OR \\'1\\'=\\'', 'uytrew');"
```

## 檢查清單

- [x] 實作密碼驗證
- [x] 使用 bcrypt 加密密碼
- [x] 為現有用戶設置預設密碼
- [x] 測試正確密碼登入
- [x] 測試錯誤密碼被拒絕
- [x] 測試不存在的帳號被拒絕
- [x] 測試 SQL Injection 防護
- [ ] 實作密碼修改功能
- [ ] 實作註冊功能
- [ ] 實作登入失敗限制
- [ ] 設定 Session 過期時間
- [ ] 實作密碼強度檢查
- [ ] 啟用 HTTPS
- [ ] 清理測試帳號

## 相關檔案

- `src/app.js` - 登入 API 修改
- `src/db.js` - 密碼驗證函數
- `init_passwords.js` - 密碼初始化腳本
- `package.json` - 新增 bcrypt 依賴

## 參考資料

- [bcrypt 文檔](https://www.npmjs.com/package/bcrypt)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
