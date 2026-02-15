/**
 * Renders the scene preview as stacked image layers in the #scene-view panel.
 * Uses asset_registry.gd via assetRegistry.js to resolve ink variable values
 * to actual image file paths.
 */

var AssetRegistry = require("./assetRegistry.js").AssetRegistry;

// Map from ink variable name -> data-layer attribute name
var VARIABLE_TO_LAYER = {
    bg:                   "background",
    vignette_shadow:      "vignette_shadow",
    locationbox:          "locationbox",
    pc:                   "pc",
    npc:                  "npc",
    dialogbox:            "dialogbox",
    emotebox:             "emotebox",
    emote:                "emote",
    vignette_js:          "vignette_js",
    ui_button_character:  "ui_button_character",
    ui_button_book:       "ui_button_book"
};

/**
 * Get the <img> element for a specific layer.
 */
function getLayerEl(layerName) {
    return document.querySelector('#scene-view .scene-layer[data-layer="' + layerName + '"]');
}

function getErrorEl() {
    return document.querySelector("#scene-view .scene-error");
}

function getOverlayEl() {
    return document.querySelector("#scene-view .scene-variables-overlay");
}

/**
 * Update the scene by mapping variable values to image layers.
 * @param {Object} variables - { varName: value } map from sceneStateEvaluator
 */
function updateScene(variables) {
    var errEl = getErrorEl();
    if (errEl) {
        errEl.textContent = "";
        errEl.classList.add("hidden");
    }

    // Check if registry loaded
    var registryError = AssetRegistry.getLoadError();
    if (registryError) {
        showError("Asset registry: " + registryError);
    }

    if (!variables || typeof variables !== "object") {
        clearLayers();
        return;
    }

    // Update each visual layer
    var layerVars = Object.keys(VARIABLE_TO_LAYER);
    for (var i = 0; i < layerVars.length; i++) {
        var varName = layerVars[i];
        var layerName = VARIABLE_TO_LAYER[varName];
        var el = getLayerEl(layerName);
        if (!el) continue;

        var assetId = variables[varName];
        if (!assetId || assetId === "") {
            // No asset assigned — hide this layer
            el.style.display = "none";
            el.removeAttribute("src");
            continue;
        }

        var absPath = AssetRegistry.resolveAssetPath(assetId);
        if (absPath) {
            el.src = "file://" + absPath;
            el.style.display = "block";
        } else {
            // Asset ID set but not found in registry — still hide, but log
            el.style.display = "none";
            el.removeAttribute("src");
            console.warn("SceneView: Asset not found in registry: " + assetId + " (variable: " + varName + ")");
        }
    }

    // Update the debug variables overlay
    updateVariablesOverlay(variables);
}

/**
 * Update the toggleable debug variables overlay.
 */
function updateVariablesOverlay(variables) {
    var el = getOverlayEl();
    if (!el) return;

    var names = Object.keys(variables);
    if (names.length === 0) {
        el.innerHTML = "<p class='scene-empty'>No variables</p>";
        return;
    }
    var html = "<ul class='scene-variable-list'>";
    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var val = variables[name];
        var display = val === null || val === undefined ? "null" : String(val);
        html += "<li><span class='scene-var-name'>" + escapeHtml(name) + "</span>: <span class='scene-var-value'>" + escapeHtml(display) + "</span></li>";
    }
    html += "</ul>";
    el.innerHTML = html;
}

function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
}

/**
 * Show an error message overlaid on the scene.
 */
function showError(message) {
    clearLayers();
    var errEl = getErrorEl();
    if (errEl) {
        errEl.textContent = message || "Unknown error";
        errEl.classList.remove("hidden");
    }
}

/**
 * Hide all image layers.
 */
function clearLayers() {
    var layers = document.querySelectorAll("#scene-view .scene-layer");
    for (var i = 0; i < layers.length; i++) {
        layers[i].style.display = "none";
        layers[i].removeAttribute("src");
    }
}

/**
 * Reset the scene to a blank state.
 */
function clear() {
    clearLayers();
    var errEl = getErrorEl();
    if (errEl) {
        errEl.textContent = "";
        errEl.classList.add("hidden");
    }
    var overlayEl = getOverlayEl();
    if (overlayEl) {
        overlayEl.innerHTML = "<p class='scene-empty'>Move cursor to evaluate</p>";
    }
}

/**
 * Toggle the debug variables overlay visibility.
 */
function toggleOverlay() {
    var el = getOverlayEl();
    if (el) {
        el.classList.toggle("hidden");
    }
}

/**
 * Reload the asset registry (e.g. after the writer edits asset_registry.gd).
 */
function reloadAssets() {
    AssetRegistry.reloadRegistry();
}

exports.SceneView = {
    updateScene: updateScene,
    showError: showError,
    clear: clear,
    toggleOverlay: toggleOverlay,
    reloadAssets: reloadAssets
};
