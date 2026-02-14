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
 * At a choice point, determine which branch to take.
 *
 * After ChooseChoiceIndex(i), currentDebugMetadata gives the source line
 * where the branch content starts. Since branches appear in source order,
 * we pick the last branch whose start line is <= the cursor line.
 * If cursor is before all branches, we default to choice 0.
 */
function chooseBranchIndex(story, cursorFilePath, cursorLine) {
    var choices = story.currentChoices;
    if (!choices || choices.length === 0) return 0;
    if (choices.length === 1) return 0;

    var savedState = story.state.ToJson();

    // For each branch, find its source start line by checking
    // currentDebugMetadata right after choosing (before any Continue).
    var branchStartLines = [];
    for (var i = 0; i < choices.length; i++) {
        if (i > 0) story.state.LoadJson(savedState);
        story.ChooseChoiceIndex(i);

        var dm = story.currentDebugMetadata;
        var startLine = (dm && dm.startLineNumber) ? dm.startLineNumber : Infinity;
        branchStartLines.push(startLine);
    }

    story.state.LoadJson(savedState);

    // Pick the last branch whose start line is <= cursor line.
    // Branches are in ascending source order.
    var bestBranch = 0;
    for (var i = 0; i < branchStartLines.length; i++) {
        if (branchStartLines[i] <= cursorLine) {
            bestBranch = i;
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
