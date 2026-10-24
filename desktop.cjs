const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

let mainWindow;
let serverPort = 0;
async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.focus(); return; }
  process.env.PORT = '0';
  process.env.DUKASAUTI_DB = path.join(app.getPath('userData'), 'dukasauti.sqlite');
  const { server } = await import('./src/server.js');
  if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  serverPort = server.address().port;
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 900, minHeight: 650,
    backgroundColor: '#f6f7f3',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
}
app.whenReady().then(createWindow);
app.on('activate', createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
