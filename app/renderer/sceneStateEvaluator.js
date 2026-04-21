/**
 * Compiles ink source via inkjs, runs the story to the cursor position
 * (choosing the branch that contains the cursor when at choice points),
 * and returns variable state for the scene preview.
 */

const inkjs = require("inkjs");
const SceneView = require("./sceneView.js").SceneView;

var debounceTimer = null;
var DEBOUNCE_MS = 300;
var MAX_STEPS = 10000;

function buildFileHierarchy(project) {
    var hierarchy = {};
    project.files.forEach(function (f) {
        hierarchy[f.relativePath()] = f.getValue();
    });
    return hierarchy;
}

/**
 * Check if debug metadata refers to the cursor's file.
 * Lenient: accepts match if fileName is null/empty (single-file project),
 * or matches the cursorFilePath exactly, or matches by basename.
 */
function fileMatchesCursor(dm, cursorFilePath) {
    if (!dm) return false;
    var name = dm.fileName || dm.sourceName;
    // If no filename in metadata, assume single-file project — accept
    if (!name) return true;
    if (!cursorFilePath) return true;
    if (name === cursorFilePath) return true;
    // Try basename match (e.g. metadata has full path, cursor has relative)
    var dmBase = name.replace(/^.*[/\\]/, "");
    var cursorBase = cursorFilePath.replace(/^.*[/\\]/, "");
    return dmBase === cursorBase;
}

/**
 * Get the source line number from the current story position.
 * Returns {line, fileMatch} or null.
 */
function getCurrentLine(story, cursorFilePath) {
    var dm = story.currentDebugMetadata;
    if (!dm) return null;
    return {
        line: dm.startLineNumber,
        endLine: dm.endLineNumber,
        fileMatch: fileMatchesCursor(dm, cursorFilePath)
    };
}

function coerceValue(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === "object" && val !== null && "value" in val) return val.value;
    if (typeof val === "object" && val !== null && typeof val.valueOf === "function") return val.valueOf();
    return val;
}

function snapshotVariablesState(story) {
    var vars = {};
    try {
        var state = story.state;
        if (!state) return vars;
        var jsonStr = state.ToJson ? state.ToJson() : (state.toJson && state.toJson());
        if (!jsonStr) return vars;
        var stateObj = JSON.parse(jsonStr);
        var vs = stateObj.variablesState;
        if (!vs || typeof vs !== "object") return vars;
        var names = Object.keys(vs);
        var variablesState = story.variablesState;
        var getVarWithName = variablesState.GetVariableWithName;
        if (typeof getVarWithName !== "function") return vars;
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            try {
                var inkObj = getVarWithName.call(variablesState, name);
                vars[name] = coerceValue(inkObj);
            } catch (err) {
                // skip this variable
            }
        }
    } catch (e) {
        // ignore
    }
    return vars;
}

/**
 * Probe the source line where a branch's content actually starts.
 *
 * Right after ChooseChoiceIndex, the runtime pointer sits at the start of the
 * choice's own container — i.e. the `* [...]` line in source. That's not what
 * we want when the choice is a divert (`* [...] -> test1`): the line we care
 * about lives inside the divert target.
 *
 * So we step the story forward via Continue() until the debug metadata moves
 * to a line that is past the choice line itself (or, for inline-content
 * choices, simply lands on the content). We track the minimum line number we
 * see while stepping; that turns out to be the most reliable indicator of
 * where the branch's content begins.
 */
function probeBranchStartLine(story, cursorFilePath, choiceLineHint) {
    var bestLine = Infinity;

    function consider(dm) {
        if (!dm) return;
        if (!fileMatchesCursor(dm, cursorFilePath)) return;
        var line = dm.startLineNumber;
        if (!line) return;
        // Skip the choice's own line — we want the branch content beyond it.
        if (choiceLineHint && line === choiceLineHint) return;
        if (line < bestLine) bestLine = line;
    }

    var safety = 0;
    while (story.canContinue && safety < 50) {
        safety++;
        try {
            story.Continue();
        } catch (e) {
            break;
        }
        consider(story.currentDebugMetadata);
        // Once we've found a content line, one Continue past the choice is
        // typically enough; keep going only while we still don't have one.
        if (bestLine !== Infinity) break;
    }

    return bestLine;
}

/**
 * At a choice point, determine which branch to take.
 *
 * For each branch we probe the source line where its content starts, then
 * pick the last branch whose start line is <= the cursor line (branches are
 * in ascending source order). If the cursor is before all branches we fall
 * back to choice 0.
 */
function chooseBranchIndex(story, cursorFilePath, cursorLine) {
    var choices = story.currentChoices;
    if (!choices || choices.length === 0) return 0;
    if (choices.length === 1) return 0;

    var savedState = story.state.ToJson();

    var branchStartLines = [];
    for (var i = 0; i < choices.length; i++) {
        story.state.LoadJson(savedState);
        try {
            story.ChooseChoiceIndex(i);
        } catch (e) {
            branchStartLines.push(Infinity);
            continue;
        }
        // Read the line of the choice itself so the probe can skip past it.
        var choiceDm = story.currentDebugMetadata;
        var choiceLine = (choiceDm && choiceDm.startLineNumber) ? choiceDm.startLineNumber : null;
        var startLine = probeBranchStartLine(story, cursorFilePath, choiceLine);
        branchStartLines.push(startLine);
    }

    story.state.LoadJson(savedState);

    var bestBranch = 0;
    var bestLine = -Infinity;
    for (var j = 0; j < branchStartLines.length; j++) {
        if (branchStartLines[j] <= cursorLine && branchStartLines[j] >= bestLine) {
            bestBranch = j;
            bestLine = branchStartLines[j];
        }
    }

    return bestBranch;
}

/**
 * Run the story from the beginning, stopping at the cursor position.
 * Returns the variable state at that point.
 */
function runToCursor(story, cursorFilePath, cursorLine) {
    var steps = 0;
    var lastVars = snapshotVariablesState(story);

    while (steps < MAX_STEPS) {
        steps++;

        if (story.canContinue) {
            // Snapshot vars BEFORE this Continue() in case we overshoot
            var prevVars = snapshotVariablesState(story);

            story.Continue();

            var info = getCurrentLine(story, cursorFilePath);

            if (info && info.fileMatch && info.line >= cursorLine) {
                // We've reached or passed the cursor line.
                // Return the CURRENT state (assignments up to this text have executed).
                return snapshotVariablesState(story);
            }

            // Update last known vars
            lastVars = snapshotVariablesState(story);

        } else if (story.currentChoices && story.currentChoices.length > 0) {
            var idx = chooseBranchIndex(story, cursorFilePath, cursorLine);
            story.ChooseChoiceIndex(idx);
        } else {
            // End of story
            return snapshotVariablesState(story);
        }
    }

    return lastVars;
}

function evaluateAtLine(cursorLine, cursorFilePath, project) {
    if (!project || !project.mainInk) {
        SceneView.clear();
        return;
    }

    var mainSource = project.mainInk.getValue();
    var fileHierarchy = buildFileHierarchy(project);
    var fileHandler = new inkjs.JsonFileHandler(fileHierarchy);
    var options = new inkjs.CompilerOptions(
        project.mainInk.relativePath(),
        [],
        false,
        null,
        fileHandler
    );
    var compiler = new inkjs.Compiler(mainSource, options);
    var story;
    try {
        story = compiler.Compile();
    } catch (e) {
        SceneView.showError(e && e.message ? e.message : String(e));
        return;
    }
    if (compiler.errors && compiler.errors.length > 0) {
        SceneView.showError(compiler.errors.join("\n"));
        return;
    }

    // Suppress runtime errors/warnings from throwing
    story.onError = function () {};

    try {
        var variables = runToCursor(story, cursorFilePath, cursorLine);
        SceneView.updateScene(variables);
    } catch (e) {
        SceneView.showError(e && e.message ? e.message : String(e));
    }
}

function evaluateAtCursorDebounced(cursorLine, project) {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!project || !project.activeInkFile) {
        SceneView.clear();
        return;
    }
    var cursorFilePath = project.activeInkFile.relativePath();
    debounceTimer = setTimeout(function () {
        debounceTimer = null;
        evaluateAtLine(cursorLine, cursorFilePath, project);
    }, DEBOUNCE_MS);
}

exports.SceneStateEvaluator = {
    evaluateAtCursor: evaluateAtCursorDebounced,
    evaluateAtLine: evaluateAtLine
};
