/**
 * TGG Asset Overview - renderer logic.
 *
 * Loads assets from both the asset_registry.gd (registered) and the assets/
 * directory on disk (all images). Cross-references to detect unregistered
 * files. Renders a filterable, searchable grid with click-to-copy.
 * Watches for changes via chokidar for hot reload.
 */

const fs = require("fs");
const path = require("path");
const { ipcRenderer } = require("electron");
const chokidar = require("chokidar");

// ============================================================
// Path resolution (same logic as assetRegistry.js)
// ============================================================

function findTggRoot() {
    var candidates = [];
    // __dirname is .../inkytgg/app/renderer/asset-overview
    candidates.push(path.resolve(__dirname, "..", "..", "..", "..", "tgg"));

    if (process.execPath) {
        var exeDir = path.dirname(process.execPath);
        candidates.push(path.join(exeDir, "tgg"));
        candidates.push(path.resolve(exeDir, "..", "tgg"));
    }

    for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) return candidates[i];
    }
    return candidates[0];
}

var tggRoot = findTggRoot();
var registryPath = path.join(tggRoot, "scripts", "asset_registry.gd");
var assetsDir = path.join(tggRoot, "assets");

// ============================================================
// Image file extensions
// ============================================================

var IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// ============================================================
// Data loading
// ============================================================

/**
 * Parse asset_registry.gd and return { assetId: resPath } map.
 * resPath is the part after "res://", e.g. "assets/backgrounds/locations/foo.png"
 */
function parseRegistry() {
    var map = {};
    if (!fs.existsSync(registryPath)) return map;
    try {
        var content = fs.readFileSync(registryPath, "utf8");
        var regex = /"([^"]+)"\s*:\s*"res:\/\/([^"]+)"/g;
        var match;
        while ((match = regex.exec(content)) !== null) {
            map[match[1]] = match[2];
        }
    } catch (e) {
        console.warn("AssetOverview: Failed to parse registry:", e.message);
    }
    return map;
}

/**
 * Recursively scan a directory for image files.
 * Returns array of absolute paths.
 */
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
            if (IMAGE_EXTENSIONS.has(ext)) {
                results.push(fullPath);
            }
        }
    }
    return results;
}

/**
 * Build the full asset list by cross-referencing registry and disk.
 * Returns { assets: [...], error: string|null }
 *
 * Each asset: {
 *   absPath:      string,   // absolute filesystem path
 *   relPath:      string,   // path relative to assets/ (e.g. "backgrounds/locations/foo.png")
 *   assetId:      string|null, // registry ID if registered, null if not
 *   registered:   boolean,
 *   displayName:  string,   // assetId for registered, filename for unregistered
 *   dirParts:     string[], // directory components for tree (e.g. ["backgrounds", "locations"])
 * }
 */
function loadAssets() {
    if (!fs.existsSync(tggRoot)) {
        return { assets: [], error: "TGG project not found at: " + tggRoot };
    }
    if (!fs.existsSync(assetsDir)) {
        return { assets: [], error: "Assets directory not found at: " + assetsDir };
    }

    // 1. Parse registry: assetId -> resPath
    var registry = parseRegistry();

    // 2. Build reverse map: absolutePath -> assetId
    var pathToId = {};
    var idToRes = registry;
    var ids = Object.keys(idToRes);
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var resPath = idToRes[id]; // e.g. "assets/backgrounds/locations/foo.png"
        var absPath = path.join(tggRoot, resPath);
        // Normalize to handle any OS path differences
        pathToId[path.normalize(absPath)] = id;
    }

    // 3. Scan disk
    var diskFiles = scanImagesRecursive(assetsDir);

    // 4. Build asset list
    var assets = [];
    for (var i = 0; i < diskFiles.length; i++) {
        var absPath = diskFiles[i];
        var normalizedPath = path.normalize(absPath);
        var relPath = path.relative(assetsDir, absPath);
        // Use forward slashes for consistency
        var relPathFwd = relPath.replace(/\\/g, "/");
        var dirParts = path.dirname(relPathFwd).split("/").filter(function (p) { return p && p !== "."; });
        var fileName = path.basename(absPath);

        var assetId = pathToId[normalizedPath] || null;
        assets.push({
            absPath: absPath,
            relPath: relPathFwd,
            assetId: assetId,
            registered: assetId !== null,
            displayName: assetId || fileName,
            dirParts: dirParts,
            fileName: fileName
        });
    }

    // Sort: registered first, then alphabetical by displayName
    assets.sort(function (a, b) {
        if (a.registered !== b.registered) return a.registered ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
    });

    return { assets: assets, error: null };
}

// ============================================================
// Category tree
// ============================================================

/**
 * Build a nested tree from dirParts arrays.
 * Returns { children: { name: { children: {...}, count: N } } }
 */
function buildTree(assets) {
    var root = { children: {}, count: 0, path: "" };
    for (var i = 0; i < assets.length; i++) {
        var parts = assets[i].dirParts;
        var node = root;
        node.count++;
        for (var j = 0; j < parts.length; j++) {
            var part = parts[j];
            if (!node.children[part]) {
                var nodePath = node.path ? node.path + "/" + part : part;
                node.children[part] = { children: {}, count: 0, path: nodePath };
            }
            node = node.children[part];
            node.count++;
        }
    }
    return root;
}

/**
 * Prettify a folder name for display.
 * e.g. "welfe_leader" -> "Welfe Leader", "clara-rechts" -> "Clara Rechts"
 */
function prettifyName(folderName) {
    return folderName
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

/**
 * Render the sidebar tree recursively.
 * Returns HTML string.
 */
function renderTreeHTML(node, depth) {
    var childNames = Object.keys(node.children).sort();
    if (childNames.length === 0) return "";
    var html = "";
    for (var i = 0; i < childNames.length; i++) {
        var name = childNames[i];
        var child = node.children[name];
        var hasChildren = Object.keys(child.children).length > 0;
        var indent = depth * 10;
        var arrowHTML = hasChildren ? '<span class="tree-arrow">&#9660;</span>' : '<span class="tree-arrow">&nbsp;</span>';
        html += '<div class="tree-node" data-path="' + escapeAttr(child.path) + '">';
        html += '<div class="tree-label" style="padding-left:' + (14 + indent) + 'px" data-path="' + escapeAttr(child.path) + '">';
        html += arrowHTML;
        html += '<span class="tree-name">' + escapeHTML(prettifyName(name)) + '</span>';
        html += '<span class="tree-count">' + child.count + '</span>';
        html += '</div>';
        if (hasChildren) {
            html += '<div class="tree-children">';
            html += renderTreeHTML(child, depth + 1);
            html += '</div>';
        }
        html += '</div>';
    }
    return html;
}

// ============================================================
// Rendering
// ============================================================

var allAssets = [];
var currentFilter = "__all__";
var currentSearch = "";

function renderGrid() {
    var grid = document.getElementById("asset-grid");
    var emptyState = document.getElementById("empty-state");
    var countEl = document.getElementById("asset-count");

    var filtered = filterAssets(allAssets, currentFilter, currentSearch);

    if (filtered.length === 0) {
        grid.innerHTML = "";
        grid.classList.add("hidden");
        emptyState.classList.remove("hidden");
        countEl.textContent = "0 assets";
        return;
    }

    emptyState.classList.add("hidden");
    grid.classList.remove("hidden");
    countEl.textContent = filtered.length + " asset" + (filtered.length !== 1 ? "s" : "");

    var html = "";
    for (var i = 0; i < filtered.length; i++) {
        var asset = filtered[i];
        var cardClass = "asset-card" + (asset.registered ? "" : " unregistered");
        var badge = asset.registered ? "" : '<span class="unregistered-badge">Unregistered</span>';

        html += '<div class="' + cardClass + '" data-copy="' + escapeAttr(asset.displayName) + '" title="' + escapeAttr(asset.registered ? asset.assetId + '\n' + asset.relPath : asset.relPath) + '">';
        html += '<div class="card-thumb">';
        // Use data-src for lazy loading via IntersectionObserver (prevents GPU crash from loading hundreds of large PNGs at once)
        html += '<img data-src="file://' + escapeAttr(asset.absPath) + '" alt="" />';
        html += badge;
        html += '</div>';
        html += '<div class="card-info">';
        html += '<div class="card-id">' + escapeHTML(asset.displayName) + '</div>';
        if (asset.registered) {
            html += '<div class="card-filename">' + escapeHTML(asset.fileName) + '</div>';
        }
        html += '</div>';
        html += '</div>';
    }
    grid.innerHTML = html;

    // Lazy-load images as they scroll into view
    observeImages();
}

function filterAssets(assets, filter, search) {
    var result = [];
    for (var i = 0; i < assets.length; i++) {
        var a = assets[i];

        // Category filter
        if (filter === "__unregistered__") {
            if (a.registered) continue;
        } else if (filter !== "__all__") {
            // filter is a folder path like "backgrounds/locations"
            var assetFolderPath = a.dirParts.join("/");
            if (assetFolderPath !== filter && assetFolderPath.indexOf(filter + "/") !== 0) {
                continue;
            }
        }

        // Search filter
        if (search) {
            var haystack = (a.displayName + " " + a.fileName + " " + a.relPath).toLowerCase();
            if (haystack.indexOf(search) === -1) continue;
        }

        result.push(a);
    }
    return result;
}

// ============================================================
// Sidebar interactions
// ============================================================

function setupSidebar() {
    // Top-level filters (All, Unregistered)
    var topFilters = document.querySelectorAll(".sidebar-filter");
    for (var i = 0; i < topFilters.length; i++) {
        topFilters[i].addEventListener("click", function (e) {
            setActiveFilter(this.getAttribute("data-filter"), this);
        });
    }

    // Tree labels
    document.getElementById("sidebar-tree").addEventListener("click", function (e) {
        var label = e.target.closest(".tree-label");
        if (label) {
            var filterPath = label.getAttribute("data-path");
            setActiveFilter(filterPath, label);
            e.stopPropagation();
            return;
        }
    });

    // Collapse/expand on arrow or double-click
    document.getElementById("sidebar-tree").addEventListener("dblclick", function (e) {
        var node = e.target.closest(".tree-node");
        if (node && node.querySelector(".tree-children")) {
            node.classList.toggle("collapsed");
        }
    });
}

function setActiveFilter(filter, activeEl) {
    currentFilter = filter;

    // Remove active from all
    var allActive = document.querySelectorAll(".sidebar-filter.active, .tree-label.active");
    for (var i = 0; i < allActive.length; i++) {
        allActive[i].classList.remove("active");
    }
    if (activeEl) activeEl.classList.add("active");

    renderGrid();
}

function updateUnregisteredCount() {
    var count = 0;
    for (var i = 0; i < allAssets.length; i++) {
        if (!allAssets[i].registered) count++;
    }
    var el = document.querySelector(".unregistered-count");
    if (el) {
        el.textContent = count > 0 ? "(" + count + ")" : "";
    }
}

// ============================================================
// Search
// ============================================================

function setupSearch() {
    var input = document.getElementById("search-input");
    var debounceTimer = null;
    input.addEventListener("input", function () {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
            currentSearch = input.value.trim().toLowerCase();
            renderGrid();
        }, 150);
    });
}

// ============================================================
// Click to copy
// ============================================================

var toastTimer = null;

function setupClickToCopy() {
    document.getElementById("asset-grid").addEventListener("click", function (e) {
        var card = e.target.closest(".asset-card");
        if (!card) return;
        var text = card.getAttribute("data-copy");
        if (!text) return;
        navigator.clipboard.writeText(text).then(function () {
            showToast("Copied: " + text);
        }).catch(function () {
            // Fallback: use old execCommand
            var ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            showToast("Copied: " + text);
        });
    });
}

function showToast(message) {
    var toast = document.getElementById("copy-toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
        toast.classList.remove("show");
        setTimeout(function () { toast.classList.add("hidden"); }, 300);
    }, 1500);
}

// ============================================================
// Lazy image loading via IntersectionObserver
// ============================================================

var imageObserver = null;

function setupImageObserver() {
    if (imageObserver) imageObserver.disconnect();
    imageObserver = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) {
                var img = entries[i].target;
                var src = img.getAttribute("data-src");
                if (src) {
                    img.src = src;
                    img.removeAttribute("data-src");
                }
                imageObserver.unobserve(img);
            }
        }
    }, {
        root: document.querySelector(".grid-scroll"),
        rootMargin: "200px" // start loading slightly before visible
    });
}

function observeImages() {
    if (!imageObserver) setupImageObserver();
    var imgs = document.querySelectorAll(".card-thumb img[data-src]");
    for (var i = 0; i < imgs.length; i++) {
        imageObserver.observe(imgs[i]);
    }
}

// ============================================================
// Theme
// ============================================================

ipcRenderer.on("change-theme", function (event, newTheme) {
    var themes = ["dark", "contrast", "focus"];
    for (var i = 0; i < themes.length; i++) {
        document.body.classList.remove(themes[i]);
    }
    if (newTheme && newTheme.toLowerCase() !== "main" && newTheme.toLowerCase() !== "light") {
        document.body.classList.add(newTheme);
    }
});

// ============================================================
// Hot reload via chokidar
// ============================================================

var watcher = null;
var reloadDebounce = null;

function setupWatcher() {
    try {
        var watchPaths = [];
        if (fs.existsSync(registryPath)) watchPaths.push(registryPath);
        if (fs.existsSync(assetsDir)) watchPaths.push(assetsDir);
        if (watchPaths.length === 0) return;

        watcher = chokidar.watch(watchPaths, {
            persistent: true,
            ignoreInitial: true,
            depth: 6,
            usePolling: false,
            awaitWriteFinish: { stabilityThreshold: 300 }
        });

        watcher.on("all", function () {
            if (reloadDebounce) clearTimeout(reloadDebounce);
            reloadDebounce = setTimeout(function () {
                reloadDebounce = null;
                reloadData();
            }, 500);
        });

        watcher.on("error", function (err) {
            console.warn("AssetOverview watcher error:", err);
        });
    } catch (e) {
        console.warn("AssetOverview: Failed to set up file watcher:", e.message);
    }
}

function reloadData() {
    var result = loadAssets();
    allAssets = result.assets;

    var errorEl = document.getElementById("error-state");
    if (result.error) {
        errorEl.textContent = result.error;
        errorEl.classList.remove("hidden");
    } else {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
    }

    // Rebuild sidebar tree
    var tree = buildTree(allAssets);
    document.getElementById("sidebar-tree").innerHTML = renderTreeHTML(tree, 0);
    updateUnregisteredCount();

    renderGrid();
}

// ============================================================
// Helpers
// ============================================================

function escapeHTML(s) {
    var div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
}

function escapeAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// Init
// ============================================================

window.addEventListener("DOMContentLoaded", function () {
    setupImageObserver();
    setupSidebar();
    setupSearch();
    setupClickToCopy();

    // Defer heavy work (disk scan + rendering) so the window paints first
    setTimeout(function () {
        reloadData();
        setupWatcher();
    }, 100);
});
