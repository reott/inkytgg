/**
 * Parses the Godot asset_registry.gd file at runtime to map
 * semantic asset IDs to absolute filesystem paths for the scene preview.
 *
 * Path resolution strategy (tries in order):
 *   1. Dev mode:  ../../../tgg  relative to __dirname (app/renderer/)
 *   2. Packaged:  tgg/ inside the exe's directory  (e.g. Inky-win32-x64/tgg/)
 *   3. Packaged:  tgg/ adjacent to the exe's directory (e.g. alongside Inky-win32-x64/)
 */

const fs = require("fs");
const path = require("path");

/**
 * Search for the tgg project root in multiple locations.
 * Returns the first path that exists, or a fallback (for error reporting).
 */
function findTggRoot() {
    var candidates = [];

    // 1. Dev mode: __dirname is .../inkytgg/app/renderer
    candidates.push(path.resolve(__dirname, "..", "..", "..", "tgg"));

    // 2–3. Packaged mode: relative to the Electron executable
    if (process.execPath) {
        var exeDir = path.dirname(process.execPath);
        // tgg inside the app folder  (Inky-win32-x64/tgg/)
        candidates.push(path.join(exeDir, "tgg"));
        // tgg next to the app folder (parent/tgg/)
        candidates.push(path.resolve(exeDir, "..", "tgg"));
    }

    for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) return candidates[i];
    }

    // None found — return first candidate so the error message is useful
    return candidates[0];
}

var tggRoot = findTggRoot();

var registryPath = path.join(tggRoot, "scripts", "asset_registry.gd");
var assetsRoot = path.join(tggRoot);

// Cached asset map: { assetId: absoluteFilePath }
var assetMap = {};
var registryLoaded = false;
var loadError = null;

// The ink variable names that correspond to visual layer slots.
// These match asset_manager.gd's handle_variable_change keys.
var VARIABLE_SLOTS = [
    "bg",
    "vignette_shadow",
    "locationbox",
    "pc",
    "npc",
    "dialogbox",
    "emotebox",
    "emote",
    "vignette_js",
    "ui_button_character",
    "ui_button_book",
    "ui_menu"
];

/**
 * Parse the ASSETS dictionary from asset_registry.gd.
 * Matches lines like: "bg_bridge_airship_02": "res://assets/backgrounds/locations/bridge-airship-02.png",
 */
function parseRegistryFile(content) {
    var map = {};
    var regex = /"([^"]+)"\s*:\s*"res:\/\/([^"]+)"/g;
    var match;
    while ((match = regex.exec(content)) !== null) {
        var assetId = match[1];
        var resPath = match[2]; // e.g. "assets/backgrounds/locations/bridge-airship-02.png"
        var absPath = path.join(assetsRoot, resPath);
        map[assetId] = absPath;
    }
    return map;
}

/**
 * Load (or reload) the asset registry from disk.
 */
function reloadRegistry() {
    assetMap = {};
    registryLoaded = false;
    loadError = null;

    if (!fs.existsSync(tggRoot)) {
        loadError = "TGG project not found at: " + tggRoot;
        console.warn("AssetRegistry: " + loadError);
        return false;
    }

    if (!fs.existsSync(registryPath)) {
        loadError = "asset_registry.gd not found at: " + registryPath;
        console.warn("AssetRegistry: " + loadError);
        return false;
    }

    try {
        var content = fs.readFileSync(registryPath, "utf8");
        assetMap = parseRegistryFile(content);
        registryLoaded = true;
        console.log("AssetRegistry: Loaded " + Object.keys(assetMap).length + " assets from " + registryPath);
        return true;
    } catch (e) {
        loadError = "Failed to read asset_registry.gd: " + (e.message || e);
        console.warn("AssetRegistry: " + loadError);
        return false;
    }
}

/**
 * Given an asset ID (e.g. "bg_bridge_airship_02"), return the absolute
 * filesystem path to the PNG file, or null if not found.
 */
function resolveAssetPath(assetId) {
    if (!registryLoaded) reloadRegistry();
    if (!assetId || assetId === "") return null;
    return assetMap[assetId] || null;
}

/**
 * Returns the list of ink variable names that map to visual layers.
 */
function getVariableSlots() {
    return VARIABLE_SLOTS.slice();
}

/**
 * Returns the last load error, or null if loaded successfully.
 */
function getLoadError() {
    if (!registryLoaded) reloadRegistry();
    return loadError;
}

// Load on first require
reloadRegistry();

exports.AssetRegistry = {
    resolveAssetPath: resolveAssetPath,
    reloadRegistry: reloadRegistry,
    getVariableSlots: getVariableSlots,
    getLoadError: getLoadError
};
