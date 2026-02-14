/**
 * Parses the Godot asset_registry.gd file at runtime to map
 * semantic asset IDs to absolute filesystem paths for the scene preview.
 *
 * REMINDER: The tggRoot path is hardcoded for dev (sibling directories).
 * This will NOT work in a packaged/production build. Add a configuration
 * option or settings dialog for the tgg project path before shipping.
 */

const fs = require("fs");
const path = require("path");

// Resolve the tgg project root relative to this file's location:
// __dirname = .../inkytgg/app/renderer
// Go up 3 levels to the parent of inkytgg, then into tgg
var tggRoot = path.resolve(__dirname, "..", "..", "..", "tgg");

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
