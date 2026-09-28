/**
 * Reproduces the German story's character-choice shape:
 *   * [fayola] -> Fayola_001
 *   * [raul]   -> Raul_001
 *   ~ emotebox = "..."          // leftover weave on the last option
 *   === Fayola_001
 *
 * A cursor inside Raul_001 must take the Raul divert, not skip it because
 * the weave assignment looks like local branch content.
 */
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

var source = [
    "VAR emote = \"\"",
    "VAR emotebox = \"\"",
    "VAR active_char = \"\"",
    "",
    "Wähle einen Charakter.",
    "",
    "* [ #choose_char_fayola] -> Fayola_001",
    "* [ #choose_char_raul] -> Raul_001",
    "",
    "~ emotebox = \"emotebox_locket_gold\"",
    "=== Fayola_001",
    "~ active_char = \"fayola\"",
    "~ emote = \"emote_fayola\"",
    "Fayola says hello.",
    "-> END",
    "",
    "=== Raul_001",
    "~ active_char = \"raul\"",
    "~ emote = \"emote_raul\"",
    "Raul says hello.",
    "-> END",
    ""
].join("\n");

function FakeFile(rel, val) { this._r = rel; this._v = val; }
FakeFile.prototype.relativePath = function () { return this._r; };
FakeFile.prototype.getValue = function () { return this._v; };
var mainFile = new FakeFile("test.ink", source);
var project = { mainInk: mainFile, activeInkFile: mainFile, files: [mainFile] };
global.DEBUG_SCENE_EVAL = true;

function evalAt(line) {
    captured = [];
    SceneViewStub.lastVariables = null;
    SceneViewStub.lastError = null;
    evaluator.evaluateAtLine(line, "test.ink", project);
    var pick = captured.filter(function (l) { return l.indexOf("chooseBranchIndex") >= 0; });
    return {
        vars: SceneViewStub.lastVariables || {},
        error: SceneViewStub.lastError,
        pick: pick[pick.length - 1] || ""
    };
}

var srcLines = source.split("\n");
var fayolaLine = srcLines.indexOf("Fayola says hello.") + 1;
var raulLine = srcLines.indexOf("Raul says hello.") + 1;

var fail = 0;
function check(name, ok, detail) {
    if (ok) console.error("pass  " + name);
    else { fail++; console.error("FAIL  " + name + "  " + detail); }
}

var fayola = evalAt(fayolaLine);
check(
    "fayola text shows fayola emote",
    fayola.vars.emote === "emote_fayola" && fayola.vars.active_char === "fayola",
    "emote=" + fayola.vars.emote + " active_char=" + fayola.vars.active_char + " pick=" + fayola.pick
);

var raul = evalAt(raulLine);
check(
    "raul text shows raul emote (must follow -> Raul_001)",
    raul.vars.emote === "emote_raul" && raul.vars.active_char === "raul",
    "emote=" + raul.vars.emote + " active_char=" + raul.vars.active_char + " pick=" + raul.pick
);

if (fail) process.exit(1);
console.error("all checks passed");
