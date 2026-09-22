/**
 * Regression sweep: cursors across the whole story (sampled every 10
 * lines), verifying that evaluation completes without error and produces
 * a variables snapshot at all.
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

var errors = 0;
var noVars = 0;
var checked = 0;
for (var line = 10; line <= srcLines.length; line += 10) {
    checked++;
    SceneViewStub.lastVariables = null;
    SceneViewStub.lastError = null;
    evaluator.evaluateAtLine(line, "test.ink", project);
    if (SceneViewStub.lastError) {
        errors++;
        console.error("ERROR at cursor " + line + ": " + SceneViewStub.lastError);
    } else if (!SceneViewStub.lastVariables) {
        noVars++;
        console.error("no vars at cursor " + line);
    }
}
console.error("checked " + checked + " cursors: " + errors + " errors, " + noVars + " missing vars");
