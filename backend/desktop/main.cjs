const { app, BrowserWindow, BrowserView, ipcMain, session } = require('electron');
const path = require('node:path');

const APP_URL = process.env.NANXI_APP_URL || 'http://127.0.0.1:8000';
const CDP_PORT = Number(process.env.NANXI_CDP_PORT || 9222);
let win;
let browserView;

function resizeBrowser() {
  if (!win || !browserView) return;
  const [width, height] = win.getContentSize();
  const sidebarWidth = Math.max(430, Math.min(520, Math.round(width * 0.38)));
  browserView.setBounds({ x: sidebarWidth, y: 0, width: width - sidebarWidth, height });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: '南溪 AI 获客工作区',
    backgroundColor: '#f4f7f7',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  browserView = new BrowserView({ webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:nanxi-platforms' } });
  win.setBrowserView(browserView);
  browserView.webContents.loadURL('https://www.douyin.com');
  win.loadURL(APP_URL + '/#desktop');
  win.on('resize', resizeBrowser);
  win.webContents.on('did-finish-load', resizeBrowser);
  resizeBrowser();
}

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({ video: undefined }));
  ipcMain.handle('platform-open', (_event, url) => browserView?.webContents.loadURL(url));
  ipcMain.handle('platform-back', () => browserView?.webContents.goBack());
  ipcMain.handle('platform-forward', () => browserView?.webContents.goForward());
  ipcMain.handle('platform-reload', () => browserView?.webContents.reload());
  ipcMain.handle('platform-url', () => browserView?.webContents.getURL() || '');
  ipcMain.handle('cdp-config', () => ({ port: CDP_PORT, endpoint: `http://127.0.0.1:${CDP_PORT}` }));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
