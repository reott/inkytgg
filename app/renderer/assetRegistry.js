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
var assetsDir = path.join(tggRoot, "assets");

// Cached asset map: { assetId: absoluteFilePath }
var assetMap = {};
// Cached disk fallback map: { variableName: { fileStem: absoluteFilePath } }
var sceneAssetMap = {};
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

function scanImagesRecursive(dir) {
    var results = [];
    if (!fs.existsSync(dir)) return results;

    var entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return results;
    }

    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results = results.concat(scanImagesRecursive(fullPath));
        } else if (entry.isFile()) {
            var ext = path.extname(entry.name).toLowerCase();
            if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") {
                results.push(fullPath);
            }
        }
    }

    return results;
}

function buildSceneAssetMap() {
    var map = {};
    var files = scanImagesRecursive(assetsDir);

    for (var i = 0; i < files.length; i++) {
        var absPath = files[i];
        var relPath = path.relative(assetsDir, absPath).replace(/\\/g, "/");
        var parts = relPath.split("/").filter(Boolean);
        if (parts.length < 2) continue;

        var variableName = parts[0];
        var fileStem = path.parse(parts[parts.length - 1]).name;

        if (!map[variableName]) map[variableName] = {};
        if (!(fileStem in map[variableName])) {
            map[variableName][fileStem] = absPath;
        }
    }

    return map;
}

/**
 * Load (or reload) the asset registry from disk.
 */
function reloadRegistry() {
    assetMap = {};
    sceneAssetMap = {};
    registryLoaded = false;
    loadError = null;

    if (!fs.existsSync(tggRoot)) {
        loadError = "TGG project not found at: " + tggRoot;
        console.warn("AssetRegistry: " + loadError);
        return false;
    }

    if (!fs.existsSync(assetsDir)) {
        loadError = "assets directory not found at: " + assetsDir;
        console.warn("AssetRegistry: " + loadError);
        return false;
    }

    sceneAssetMap = buildSceneAssetMap();

    try {
        if (fs.existsSync(registryPath)) {
            var content = fs.readFileSync(registryPath, "utf8");
            assetMap = parseRegistryFile(content);
        } else {
            console.warn("AssetRegistry: asset_registry.gd not found at: " + registryPath + " (using disk fallback only)");
        }
        registryLoaded = true;
        console.log(
            "AssetRegistry: Loaded " +
            Object.keys(assetMap).length +
            " registry assets and " +
            Object.keys(sceneAssetMap).length +
            " scene folders"
        );
        return true;
    } catch (e) {
        console.warn("AssetRegistry: Failed to read asset_registry.gd: " + (e.message || e) + " (using disk fallback only)");
        registryLoaded = true;
        return true;
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

function resolveSceneAssetPath(variableName, assetId) {
    if (!registryLoaded) reloadRegistry();
    if (!assetId || assetId === "") return null;

    // First, prefer explicit registry IDs for backwards compatibility.
    if (assetMap[assetId]) return assetMap[assetId];

    // Then fall back to disk lookup by layer folder + filename stem.
    var folderMap = sceneAssetMap[variableName];
    if (!folderMap) return null;

    var fileStem = path.parse(String(assetId)).name;
    return folderMap[fileStem] || null;
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
    resolveSceneAssetPath: resolveSceneAssetPath,
    reloadRegistry: reloadRegistry,
    getVariableSlots: getVariableSlots,
    getLoadError: getLoadError
};
