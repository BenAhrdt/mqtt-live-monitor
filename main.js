const { app, BrowserWindow, Menu } = require('electron');

const isDev = !app.isPackaged;

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,

        // 👉 direkt maximiert starten
        show: false, // verhindert flackern

        autoHideMenuBar: true,
        menuBarVisible: false,

        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            devTools: isDev // 👉 nur im DEV erlaubt
        }
    });

    // 👉 Menü komplett killen (inkl. ALT)
    if (!isDev) {
        Menu.setApplicationMenu(null);
    }

    // 👉 DevTools blockieren (extra sicher)
    win.webContents.on('before-input-event', (event, input) => {
        if (!isDev) {
            if (input.key === 'F12') {
                event.preventDefault();
            }

            if (input.control && input.shift && input.key.toLowerCase() === 'i') {
                event.preventDefault();
            }
        }
    });

    // 👉 Rechtsklick deaktivieren (optional)
    if (!isDev) {
        win.webContents.on('context-menu', (e) => {
            e.preventDefault();
        });
    }

    // 👉 URL laden (mit Delay wegen Server)
    setTimeout(() => {
        win.loadURL('http://localhost:3000');

        // 👉 erst anzeigen wenn geladen
        win.once('ready-to-show', () => {
            win.maximize(); // 👈 HIER passiert Vollbild / maximiert
            win.show();
        });

    }, 1000);
}

app.whenReady().then(() => {
    require('./server'); // 👉 JETZT sicher

    createWindow();
});