const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { app, BrowserWindow, shell, dialog, ipcMain, safeStorage } = require('electron');
const { startServer } = require('./server');

let mainWindow = null;
let localServer = null;
let localOrigin = '';

function connectionConfigPath() {
  return path.join(app.getPath('userData'), 'connection-config.json');
}

function groupConfigPath() {
  return path.join(app.getPath('userData'), 'group-config.json');
}

function imageUploadConfigPath() {
  return path.join(app.getPath('userData'), 'image-upload-config.json');
}

async function loadConnectionConfig() {
  try {
    const raw = await fs.readFile(connectionConfigPath(), 'utf8');
    const saved = JSON.parse(raw);
    let authCode = '';
    if (saved.authCode && safeStorage.isEncryptionAvailable()) {
      authCode = safeStorage.decryptString(Buffer.from(saved.authCode, 'base64'));
    }
    return { authCode, tableUrl: String(saved.tableUrl || '') };
  } catch (error) {
    if (error.code === 'ENOENT') return { authCode: '', tableUrl: '' };
    throw error;
  }
}

async function saveConnectionConfig(_event, config) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 安全存储当前不可用，授权码未保存');
  }
  const authCode = String(config?.authCode || '').trim();
  const tableUrl = String(config?.tableUrl || '').trim();
  if (!authCode || !tableUrl) throw new Error('授权码和多维表格链接不能为空');
  const payload = {
    authCode: safeStorage.encryptString(authCode).toString('base64'),
    tableUrl,
    savedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(connectionConfigPath()), { recursive: true });
  await fs.writeFile(connectionConfigPath(), JSON.stringify(payload, null, 2), 'utf8');
  return { ok: true };
}

async function loadGroupConfig() {
  try {
    const raw = await fs.readFile(groupConfigPath(), 'utf8');
    const saved = JSON.parse(raw);
    return { groups: Array.isArray(saved.groups) ? saved.groups : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { groups: [] };
    throw error;
  }
}

async function saveGroupConfig(_event, config) {
  const groups = (Array.isArray(config?.groups) ? config.groups : []).slice(0, 50).map(group => ({
    name: String(group?.name || '').trim().slice(0, 60),
    accounts: (Array.isArray(group?.accounts) ? group.accounts : [])
      .map(account => String(account || '').trim().slice(0, 100))
      .filter(Boolean)
      .slice(0, 200),
  })).filter(group => group.name);
  if (!groups.length) throw new Error('至少保留一个分组');
  const payload = { groups, savedAt: new Date().toISOString() };
  await fs.mkdir(path.dirname(groupConfigPath()), { recursive: true });
  await fs.writeFile(groupConfigPath(), JSON.stringify(payload, null, 2), 'utf8');
  return { ok: true };
}

function normalizeImageUploadConfig(config) {
  const startRow = Math.max(1, Math.min(10000, Math.trunc(Number(config?.startRow) || 2)));
  const parsedEndRow = Math.trunc(Number(config?.endRow) || 0);
  const endRow = parsedEndRow >= startRow ? parsedEndRow : '';
  const folders = (Array.isArray(config?.folders) ? config.folders : [])
    .slice(0, 30)
    .map(folder => ({
      path: String(folder?.path || '').trim(),
      perRow: Math.max(1, Math.min(50, Math.trunc(Number(folder?.perRow) || 1))),
    }))
    .filter(folder => folder.path);
  return {
    fieldName: String(config?.fieldName || '').trim().slice(0, 100),
    startRow,
    endRow,
    append: Boolean(config?.append),
    folders,
  };
}

async function loadImageUploadConfig() {
  try {
    const raw = await fs.readFile(imageUploadConfigPath(), 'utf8');
    return normalizeImageUploadConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeImageUploadConfig({});
    throw error;
  }
}

function saveImageUploadConfigSync(config) {
  const normalized = normalizeImageUploadConfig(config);
  const payload = { ...normalized, savedAt: new Date().toISOString() };
  const filePath = imageUploadConfigPath();
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { ok: true, config: normalized };
}

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

async function scanImageFolder(folderPath) {
  const root = path.resolve(String(folderPath || ''));
  const files = [];
  const walk = async (directory, depth = 0) => {
    if (depth > 8 || files.length >= 5000) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    for (const entry of entries) {
      if (files.length >= 5000) break;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath, depth + 1);
      else if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fs.stat(fullPath);
        files.push({ path: fullPath, name: entry.name, size: stat.size });
      }
    }
  };
  await walk(root);
  return { path: root, name: path.basename(root), files };
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

async function createWindow() {
  if (!localServer) {
    localServer = await startServer(0, '127.0.0.1');
    localOrigin = `http://127.0.0.1:${localServer.address().port}`;
  }

  mainWindow = new BrowserWindow({
    title: '小红书采集 · 飞书上传',
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7f8fb',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(localOrigin)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(localOrigin);
}

if (gotSingleInstanceLock) {
  ipcMain.handle('connection-config:load', loadConnectionConfig);
  ipcMain.handle('connection-config:save', saveConnectionConfig);
  ipcMain.handle('group-config:load', loadGroupConfig);
  ipcMain.handle('group-config:save', saveGroupConfig);
  ipcMain.handle('image-upload-config:load', loadImageUploadConfig);
  ipcMain.on('image-upload-config:save-sync', (event, config) => {
    try {
      event.returnValue = saveImageUploadConfigSync(config);
    } catch (error) {
      event.returnValue = { ok: false, error: error.message };
    }
  });
  ipcMain.handle('images:select-folders', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择图片文件夹',
      properties: ['openDirectory', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('images:scan-folders', async (_event, folderPaths) => {
    const paths = (Array.isArray(folderPaths) ? folderPaths : []).slice(0, 30);
    return Promise.all(paths.map(scanImageFolder));
  });

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(createWindow).catch(error => {
    dialog.showErrorBox('启动失败', error.message);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (localServer?.listening) localServer.close();
});
