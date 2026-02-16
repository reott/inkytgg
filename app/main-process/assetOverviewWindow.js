const electron = require('electron');
const BrowserWindow = electron.BrowserWindow;
const path = require("path");

const electronWindowOptions = {
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "TGG Asset Overview",
    autoHideMenuBar: true,
    webPreferences: {
        preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
        nodeIntegration: true,
        contextIsolation: false
    }
};

var assetOverviewWindow = null;

function AssetOverviewWindow(theme) {
    var w = new BrowserWindow(electronWindowOptions);
    w.loadURL("file://" + __dirname + "/../renderer/asset-overview/overview.html");

    w.webContents.on("did-finish-load", () => {
        w.webContents.send("change-theme", theme);
        w.setMenu(null);
        w.show();
    });

    this.browserWindow = w;

    w.on("close", () => {
        assetOverviewWindow = null;
    });
}

AssetOverviewWindow.openAssetOverview = function (theme) {
    if (assetOverviewWindow == null) {
        assetOverviewWindow = new AssetOverviewWindow(theme);
    } else {
        assetOverviewWindow.browserWindow.focus();
    }
    return assetOverviewWindow;
};

AssetOverviewWindow.changeTheme = function (theme) {
    if (assetOverviewWindow != null) {
        assetOverviewWindow.browserWindow.webContents.send("change-theme", theme);
    }
};

exports.AssetOverviewWindow = AssetOverviewWindow;
