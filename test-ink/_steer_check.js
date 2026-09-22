/**
 * End-to-end check v3: only text-line cursors. For a cursor on a text
 * line, the preview must show the last `~ emote` assignment executed in
 * the batch containing that text (i.e. the nearest assignment above it,
 * skipping comments/blank lines, within the same knot).
 */
var fs = require("fs");
var path = require("path");

global.window = global;
var captured = [];
console.log = function () { captured.push(Array.prototype.slice.call(arguments).join(" ")); };

var SceneViewStub = {
    lastVariables: null, lastError: null,
    updateScene: function (v) { this.lastVariables = v; },
    showError: function (m) { this.lastError = m; },
    clear: function () {}
};
var sceneViewPath = require.resolve(path.join(__dirname, "..", "app", "renderer", "sceneView.js"));
require.cache[sceneViewPath] = {
    id: sceneViewPath, filename: sceneViewPath, loaded: true,
    exports: { SceneView: SceneViewStub }
};
var evaluator = require(path.join(__dirname, "..", "app", "renderer", "sceneStateEvaluator.js")).SceneStateEvaluator;

var source = fs.readFileSync(path.join(__dirname, "tgg-the-elektrit-conspiracy-a-001-test.ink"), "utf8");
var srcLines = source.split("\n");

function FakeFile(rel, val) { this._r = rel; this._v = val; }
FakeFile.prototype.relativePath = function () { return this._r; };
FakeFile.prototype.getValue = function () { return this._v; };
var mainFile = new FakeFile("test.ink", source);
var project = { mainInk: mainFile, activeInkFile: mainFile, files: [mainFile] };
global.DEBUG_SCENE_EVAL = false;

// Precompute comment ranges (/* ... */ blocks)
var inComment = new Array(srcLines.length).fill(false);
var inside = false;
for (var i = 0; i < srcLines.length; i++) {
    var line = srcLines[i];
    if (inside) {
        inComment[i] = true;
        if (line.indexOf("*/") >= 0) inside = false;
    } else if (line.trim().indexOf("/*") === 0 && line.indexOf("*/") < 0) {
        inside = true;
        inComment[i] = true;
    } else if (line.trim().indexOf("/*") === 0) {
        inComment[i] = true;
    }
}

function isTextLineIdx(idx) {
    var t = srcLines[idx].trim();
    if (!t || inComment[idx]) return false;
    if (t[0] === "~" || t[0] === "*" || t[0] === "-" || t[0] === "{" || t[0] === "}") return false;
    if (t.indexOf("//") === 0) return false;
    if (t.indexOf("====") === 0) return false;
    if (/^=+\s/.test(t) || t === "=") return false;
    if (t.indexOf("->") === 0) return false;
    if (t.indexOf("VAR ") === 0 || t.indexOf("LIST ") === 0) return false;
    if (t.indexOf("DONE") === 0) return false;
    return true;
}

function lastEmoteBefore(idx) {
    for (var m = idx; m >= 0; m--) {
        if (inComment[m]) continue;
        var mm = srcLines[m].trim().match(/^~\s*emote\s*=\s*"([^"]*)"/);
        if (mm) return mm[1];
    }
    return null;
}

// Collect all text-line cursors inside the branch content knots
// (skip the main flow before the first choice to keep the run fast)
var textCursors = [];
for (var j = 200; j < srcLines.length; j++) {
    if (isTextLineIdx(j)) textCursors.push(j + 1);
}

var pass = 0, fail = 0;
var failures = [];
for (var c = 0; c < textCursors.length; c++) {
    var cur = textCursors[c];
    var expected = lastEmoteBefore(cur - 1);
    if (expected === null) continue;
    SceneViewStub.lastVariables = null;
    SceneViewStub.lastError = null;
    evaluator.evaluateAtLine(cur, "test.ink", project);
    var vars = SceneViewStub.lastVariables;
    if (!vars) { fail++; failures.push({ cursor: cur, expected: expected, actual: "(no vars)", src: srcLines[cur - 1].trim().slice(0, 40) }); continue; }
    var actual = vars.emote;
    if (actual === expected) pass++;
    else { fail++; failures.push({ cursor: cur, expected: expected, actual: actual, src: srcLines[cur - 1].trim().slice(0, 40) }); }
}
console.error(pass + " passed, " + fail + " failed  (of " + textCursors.length + " text cursors)");
failures.forEach(function (f) {
    console.error("  cursor " + f.cursor + " \"" + f.src + "\"");
    console.error("      expected " + f.expected);
    console.error("      got      " + f.actual);
});
