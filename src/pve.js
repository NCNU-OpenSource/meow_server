// src/pve.js
// Proxmox VE API 整合
const axios = require('axios');
const https = require('https');

// PVE API 配置
const PVE_CONFIG = {
  host: process.env.PVE_HOST || '192.168.1.100',
  port: parseInt(process.env.PVE_PORT || '8006', 10),
  username: process.env.PVE_USERNAME || process.env.PVE_USER || 'root@pam',
  password: process.env.PVE_PASSWORD || process.env.PVE_PASS || '',
  tokenId: process.env.PVE_TOKEN_ID || '',
  tokenSecret: process.env.PVE_TOKEN_SECRET || '',
  realm: process.env.PVE_REALM || 'pam',
  verifySSL: process.env.PVE_VERIFY_SSL !== 'false', // 預設驗證 SSL
  templateVmid: parseInt(process.env.PVE_TEMPLATE_VMID || '100', 10), // Template VM ID
  storage: process.env.PVE_STORAGE || 'local-lvm', // 儲存位置
  node: process.env.PVE_NODE || 'pve', // Proxmox 節點名稱
};
const USE_PVE_TOKEN = Boolean(PVE_CONFIG.tokenId && PVE_CONFIG.tokenSecret);

// 獲取 PVE API Ticket（認證 Token）
async function getPVETicket() {
  if (USE_PVE_TOKEN) {
    return null;
  }

  if (!PVE_CONFIG.password) {
    throw new Error('PVE_PASSWORD 未設定，請提供帳號密碼或改用 PVE_TOKEN_ID/PVE_TOKEN_SECRET');
  }

  const url = `https://${PVE_CONFIG.host}:${PVE_CONFIG.port}/api2/json/access/ticket`;
  
  const httpsAgent = new https.Agent({
    rejectUnauthorized: PVE_CONFIG.verifySSL,
  });

  try {
    const response = await axios.post(url, {
      username: PVE_CONFIG.username,
      password: PVE_CONFIG.password,
      realm: PVE_CONFIG.realm,
    }, {
      httpsAgent,
    });

    if (response.data && response.data.data) {
      return {
        ticket: response.data.data.ticket,
        CSRFPreventionToken: response.data.data.CSRFPreventionToken,
      };
    }
    throw new Error('無法獲取 PVE Ticket');
  } catch (error) {
    throw new Error(`PVE 認證失敗: ${error.message}`);
  }
}

// 創建 PVE API 請求
async function pveRequest(method, path, data = null, ticket = null) {
  const url = `https://${PVE_CONFIG.host}:${PVE_CONFIG.port}${path}`;
  const httpsAgent = new https.Agent({
    rejectUnauthorized: PVE_CONFIG.verifySSL,
  });

  const config = {
    method,
    url,
    httpsAgent,
    headers: {},
  };

  if (USE_PVE_TOKEN) {
    config.headers['Authorization'] = `PVEAPIToken=${PVE_CONFIG.tokenId}=${PVE_CONFIG.tokenSecret}`;
  } else {
    if (!ticket) {
      ticket = await getPVETicket();
    }
    config.headers['Cookie'] = `PVEAuthCookie=${ticket.ticket}`;
    config.headers['CSRFPreventionToken'] = ticket.CSRFPreventionToken;
  }

  if (data) {
    config.data = data;
  }

  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const msg = error.response?.data?.errors?.[0]?.message || error.message;
    throw new Error(`PVE API 錯誤: ${msg}`);
  }
}

// 獲取下一個可用的 VMID
async function getNextVMID() {
  const ticket = await getPVETicket();
  const data = await pveRequest('GET', `/api2/json/cluster/nextid`, null, ticket);
  return parseInt(data.data, 10);
}

// Clone VM（從 Template 複製）
async function cloneVM(vmid, vmName) {
  const ticket = await getPVETicket();
  const newVmid = vmid || await getNextVMID();
  
  const cloneData = {
    newid: newVmid,
    name: vmName || `student-vm-${newVmid}`,
    storage: PVE_CONFIG.storage,
    full: 0, // 0 = linked clone (快速), 1 = full clone
  };

  // 開始 clone 任務
  const result = await pveRequest('POST', 
    `/api2/json/nodes/${PVE_CONFIG.node}/qemu/${PVE_CONFIG.templateVmid}/clone`, 
    cloneData, ticket);

  const taskId = result.data;
  
  // 等待 clone 完成
  await waitForTask(taskId, ticket);
  
  return { vmid: newVmid, taskId };
}

// 等待任務完成
async function waitForTask(taskId, ticket, timeout = 300000) { // 5 分鐘超時
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const status = await pveRequest('GET', 
      `/api2/json/nodes/${PVE_CONFIG.node}/tasks/${taskId}/status`, null, ticket);
    
    if (status.data.status === 'stopped') {
      if (status.data.exitstatus === 'OK') {
        return true;
      }
      throw new Error(`任務失敗: ${status.data.exitstatus}`);
    }
    
    // 等待 2 秒後再檢查
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  throw new Error('任務超時');
}

// 建立 Snapshot
async function createSnapshot(vmid, snapshotName) {
  const ticket = await getPVETicket();
  
  const result = await pveRequest('POST',
    `/api2/json/nodes/${PVE_CONFIG.node}/qemu/${vmid}/snapshot`,
    { snapname: snapshotName, description: 'Clean start snapshot' },
    ticket);

  const taskId = result.data;
  await waitForTask(taskId, ticket);
  
  return { snapshotName, taskId };
}

// Rollback 到 Snapshot
async function rollbackToSnapshot(vmid, snapshotName) {
  const ticket = await getPVETicket();
  
  const result = await pveRequest('POST',
    `/api2/json/nodes/${PVE_CONFIG.node}/qemu/${vmid}/snapshot/${snapshotName}/rollback`,
    {},
    ticket);

  const taskId = result.data;
  await waitForTask(taskId, ticket);
  
  return { snapshotName, taskId };
}

// 啟動 VM
async function startVM(vmid) {
  const ticket = await getPVETicket();
  
  const result = await pveRequest('POST',
    `/api2/json/nodes/${PVE_CONFIG.node}/qemu/${vmid}/status/start`,
    {},
    ticket);

  const taskId = result.data;
  await waitForTask(taskId, ticket);
  
  return { vmid, taskId };
}

// 停止 VM
async function stopVM(vmid) {
  const ticket = await getPVETicket();
  
  const result = await pveRequest('POST',
    `/api2/json/nodes/${PVE_CONFIG.node}/qemu/${vmid}/status/stop`,
    {},
    ticket);

  const taskId = result.data;
  await waitForTask(taskId, ticket);
  
  return { vmid, taskId };
}

// 刪除 VM
async function destroyVM(vmid) {
  const ticket = await getPVETicket();
  
  // 先停止 VM
  try {
    await stopVM(vmid);
  } catch (e) {
    // 如果已經停止，忽略錯誤
  }
  
  const result = await pveRequest('DELETE',
    `/api2/json/nodes/${PVE_CONFIG.node}/qemu/${vmid}`,
    null,
    ticket);

  return { vmid, deleted: true };
}

// 獲取 VM 狀態
async function getVMStatus(vmid) {
  const ticket = await getPVETicket();
  
  const data = await pveRequest('GET',
    `/api2/json/nodes/${PVE_CONFIG.node}/qemu/${vmid}/status/current`,
    null,
    ticket);

  return data.data;
}

// 獲取 VM 的 IP 地址（從 QEMU Guest Agent 或配置）
async function getVMIP(vmid) {
  try {
    const status = await getVMStatus(vmid);
    // 嘗試從 guest-agent 獲取 IP
    if (status.agent && status.agent['network-interfaces']) {
      const interfaces = status.agent['network-interfaces'];
      for (const iface of interfaces) {
        if (iface['ip-addresses'] && iface['ip-addresses'].length > 0) {
          for (const ip of iface['ip-addresses']) {
            if (ip['ip-address-type'] === 'ipv4' && !ip['ip-address'].startsWith('127.')) {
              return ip['ip-address'];
            }
          }
        }
      }
    }
    
    // 如果無法從 guest-agent 獲取，返回 null（需要手動配置）
    return null;
  } catch (error) {
    console.error(`無法獲取 VM ${vmid} 的 IP:`, error.message);
    return null;
  }
}

// 檢查 PVE 連線
async function checkPVEConnection() {
  try {
    await getPVETicket();
    return { ok: true, message: 'PVE 連線正常' };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

module.exports = {
  cloneVM,
  createSnapshot,
  rollbackToSnapshot,
  startVM,
  stopVM,
  destroyVM,
  getVMStatus,
  getVMIP,
  checkPVEConnection,
  getNextVMID,
  PVE_CONFIG,
};
