/**
 * Focused probe: for each choice point in the test story, print what
 * probeBranchStartLine computes per choice and what the compiled tree
 * looks like along the divert chain.
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
global.DEBUG_SCENE_EVAL = true;

function pickLinesFor(cursor) {
    captured = [];
    evaluator.evaluateAtLine(cursor, "test.ink", project);
    return captured.filter(function (l) { return l.indexOf("chooseBranchIndex") >= 0; });
}

// Choice points and the branch-content regions in the source:
// A @ ~198: negotiation (pass 219-252, fail 255-281) | seduction (pass 284-323, fail 326-352)
// B @ ~590: Raul_0011 (595+) | Clara_001 (807+)
// C @ ~610: negotiation (pass 638-666, fail 668-696) | perception (pass 698-730, fail 732-758) | coolness (pass 760-779, fail 781-801)
// D @ ~824: negotiation (pass 850-887, fail 889-920) | seduction (pass 922-955, fail 956-978) | coolness (pass 978-1010, fail 1011-1038)

var checks = [
    ["A", 240, "negotiation_pass content (should pick branch 0)"],
    ["A", 265, "negotiation_fail content (should pick branch 0)"],
    ["A", 300, "seduction_pass content (should pick branch 1)"],
    ["A", 340, "seduction_fail content (should pick branch 1)"],
    ["B", 650, "Raul region (should pick Raul = branch 0)"],
    ["B", 870, "Clara region (should pick Clara = branch 1)"],
    ["C", 650, "raul negotiation_pass (should pick branch 0)"],
    ["C", 680, "raul negotiation_fail (should pick branch 0)"],
    ["C", 710, "raul perception_pass (should pick branch 1)"],
    ["C", 745, "raul perception_fail (should pick branch 1)"],
    ["C", 775, "raul coolness_pass (should pick branch 2)"],
    ["C", 795, "raul coolness_fail (should pick branch 2)"],
    ["D", 870, "clara negotiation_pass (should pick branch 0)"],
    ["D", 935, "clara seduction_pass (should pick branch 1)"],
    ["D", 995, "clara coolness_pass (should pick branch 2)"],
    ["D", 1020, "clara coolness_fail (should pick branch 2)"]
];

// Identify choice points by their branch-line signature instead of call order.
// A: 2 choices; B: 2 choices; C: 3 choices; D: 3 choices.
function pickFor(lines, choiceCount) {
    var re = new RegExp("lines= ([0-9,]+) → branch (\\d+)");
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(re);
        if (!m) continue;
        var lineCount = m[1].split(",").length;
        if (lineCount === choiceCount) return m[1] + " → branch " + m[2];
    }
    return "(choice point not reached)";
}

for (var i = 0; i < checks.length; i++) {
    var c = checks[i];
    var lines = pickLinesFor(c[1]);
    var choiceCount = { A: 2, B: 2, C: 3, D: 3 }[c[0]];
    // A and B both have 2 choices: disambiguate by line numbers.
    var pick = pickFor(lines, choiceCount);
    if (c[0] === "B") {
        // B's lines are 593,807
        var reB = /lines= 593,807 → branch (\d+)/;
        var mb = lines.join("\n").match(reB);
        pick = mb ? ("593,807 → branch " + mb[1]) : "(not reached)";
    } else if (c[0] === "A") {
        var reA = /lines= 219,284 → branch (\d+)/;
        var ma = lines.join("\n").match(reA);
        pick = ma ? ("219,284 → branch " + ma[1]) : "(not reached)";
    } else if (c[0] === "C") {
        var reC = /lines= 638,698,760 → branch (\d+)/;
        var mc = lines.join("\n").match(reC);
        pick = mc ? ("638,698,760 → branch " + mc[1]) : "(not reached)";
    } else if (c[0] === "D") {
        var reD = /lines= 852,922,980 → branch (\d+)/;
        var md = lines.join("\n").match(reD);
        pick = md ? ("852,922,980 → branch " + md[1]) : "(not reached)";
    }
    console.error("[" + c[0] + "] cursor " + String(c[1]).padEnd(4) + " " + c[2]);
    console.error("      " + pick);
}
