#!/usr/bin/env node
// 將所有用戶密碼重設為 bob123

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'lsa',
    password: process.env.DB_PASS || 'lsa123',
    database: process.env.DB_NAME || 'lsa',
  });

  try {
    console.log('正在重設所有用戶密碼為: bob123');

    // 獲取所有用戶
    const [users] = await pool.query('SELECT id, username, role FROM users');

    if (users.length === 0) {
      console.log('沒有找到任何用戶');
      process.exit(0);
    }

    console.log(`找到 ${users.length} 個用戶`);

    // 統一密碼: bob123
    const newPassword = 'bob123';
    const password_hash = await bcrypt.hash(newPassword, 10);

    for (const user of users) {
      await pool.query(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        [password_hash, user.id]
      );

      console.log(`✅ ${user.username} (${user.role}) - 密碼已重設為: bob123`);
    }

    console.log('\n所有用戶密碼已重設為: bob123');
    console.log('現在可以使用任何帳號 + 密碼 bob123 登入');

  } catch (error) {
    console.error('錯誤:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
