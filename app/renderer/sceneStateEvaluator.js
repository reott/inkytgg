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

// Set window.DEBUG_SCENE_EVAL = true in DevTools to trace branch selection.
function dbg() {
    try {
        if (typeof window !== "undefined" && window.DEBUG_SCENE_EVAL) {
            console.log.apply(console, ["[scene-eval]"].concat([].slice.call(arguments)));
        }
    } catch (e) { /* ignore */ }
}

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
        var variablesState = story.variablesState;
        var getVarWithName = variablesState && variablesState.GetVariableWithName;
        if (typeof getVarWithName !== "function") return vars;

        // Variable names to snapshot. Prefer the full list of declared
        // globals — inkjs' state.ToJson() only serializes variables whose
        // value differs from their declared initial value, so vars that
        // still hold their default (e.g. `emote = ""`) would be missed.
        var names = [];
        var defaults = variablesState._defaultGlobalVariables;
        if (defaults && typeof defaults.forEach === "function") {
            defaults.forEach(function (v, name) { names.push(name); });
        } else {
            var state = story.state;
            var jsonStr = state.ToJson ? state.ToJson() : (state.toJson && state.toJson());
            if (!jsonStr) return vars;
            var stateObj = JSON.parse(jsonStr);
            var vs = stateObj.variablesState;
            if (!vs || typeof vs !== "object") return vars;
            names = Object.keys(vs);
        }

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
 * Is this runtime object a Divert? (Duck-typed: the compiled runtime
 * classes are minified inside the inkjs bundle, so we identify a Divert
 * by its target-pointer field.)
 */
function isDivert(obj) {
    return !!obj && obj._targetPointer !== undefined && !obj.content;
}

/**
 * If `obj` is a Divert that statically points at a real story location,
 * return its target path — otherwise null. We skip diverts we can't or
 * shouldn't follow: variable targets, external calls, the conditional
 * branch-jump machinery ink generates (`{"->":".^.b","c":true}`), and
 * relative paths that point at internal containers rather than real
 * story content.
 */
function divertTargetPath(obj) {
    if (!isDivert(obj)) return null;
    if (obj.variableDivertName || obj.isExternal || obj.isConditional) return null;
    var tp = obj._targetPath;
    if (!tp || tp.isRelative) return null;
    return tp;
}

/**
 * Is this runtime object something a reader would call "branch content"?
 * That's text that actually gets printed (non-whitespace) or a variable
 * assignment (`~ var = ...`). Control commands, condition evaluation,
 * native calls and diverts are routing machinery, not content.
 */
function isRealContentObject(obj) {
    if (!obj) return false;
    // VariableAssignment: own props { variableName, isNewDeclaration, isGlobal }
    if (typeof obj.variableName === "string" && typeof obj.isNewDeclaration === "boolean") {
        return true;
    }
    // StringExpression: own field `_isNewline` marks the class; only text
    // with non-whitespace content counts (glue/newlines don't).
    if (typeof obj.value === "string" && obj._isNewline !== undefined && obj.value.trim() !== "") {
        return true;
    }
    return false;
}

/**
 * Walk a container's content tree (not through diverts) and collect
 * info about what's inside:
 *  - firstContentLine: earliest source line of "real content" (printed
 *    text or variable assignment)
 *  - minLine/maxLine: range of all source lines touched (incl. routing)
 *  - storyDiverts: target paths of diverts that lead onward through the
 *    story (see divertTargetPath).
 *
 * Recurses into both `content` and `namedContent` — ink stores the
 * conditional-branch bodies of `{ -cond: -> a -else: -> b }` in *named*
 * sub-containers (`b`), which hold the actual `-> a` / `-> b` diverts.
 * Stops recursing at the given depth.
 */
function scanContainer(container, cursorFilePath, info, depth) {
    if (!container || depth > 8) return;

    // The container's own debug metadata (knots usually have none of their own).
    var dm = container._debugMetadata;
    if (dm && dm.startLineNumber && fileMatchesCursor(dm, cursorFilePath)) {
        if (dm.startLineNumber < info.minLine) info.minLine = dm.startLineNumber;
        if (dm.endLineNumber > info.maxLine) info.maxLine = dm.endLineNumber;
    }

    if (container.content && container.content.length > 0) {
        for (var i = 0; i < container.content.length; i++) {
            scanChild(container.content[i], cursorFilePath, info, depth);
        }
    }

    // namedContent is a Map in inkjs (Container). It may be missing on
    // non-container objects.
    var named = container.namedContent;
    if (named && typeof named.forEach === "function") {
        named.forEach(function (child) {
            scanChild(child, cursorFilePath, info, depth);
        });
    }
}

function scanChild(c, cursorFilePath, info, depth) {
    if (!c) return;

    var cdm = c._debugMetadata;
    if (cdm && cdm.startLineNumber && fileMatchesCursor(cdm, cursorFilePath)) {
        if (cdm.startLineNumber < info.minLine) info.minLine = cdm.startLineNumber;
        if (cdm.endLineNumber > info.maxLine) info.maxLine = cdm.endLineNumber;
        if (isRealContentObject(c) && cdm.startLineNumber < info.firstContentLine) {
            info.firstContentLine = cdm.startLineNumber;
        }
    }

    var tp = divertTargetPath(c);
    if (tp) info.storyDiverts.push(tp);

    if (c.content && c.content.length > 0) {
        scanContainer(c, cursorFilePath, info, depth + 1);
    }
}

/**
 * Detect the ink-compiled router pattern generated from
 * `{ -cond: -> a -else: -> b }`:
 *   knot[ arm0(V(EvalStart), Ct(name=cond), V(EvalEnd), X(condDivert->b)),
 *         arm1(X(->b)), V(NoOp), ... ]
 * where each arm holds a named `b` sub-container with the real diverts.
 *
 * Returns the condition variable's name when the knot matches this shape
 * with a *bare variable* condition (`-var:`), else null. Anything more
 * complex (comparisons, `not`) can't be steered by just setting the var.
 */
function routerConditionVar(container) {
    if (!container || !container.content) return null;

    var condName = null;
    (function walk(o, d) {
        if (!o || d > 6 || condName) return;
        // VariableReference: identified by its `pathForCount` field
        if (o.pathForCount !== undefined && typeof o.name === "string" && o.name) {
            // Bare-var check: its parent's content must contain no other
            // value objects (only ControlCommands and the Ct itself).
            var siblings = o.parent && o.parent.content ? o.parent.content : [];
            var valueObjs = 0;
            for (var i = 0; i < siblings.length; i++) {
                var s = siblings[i];
                if (!s) continue;
                if (s.pathForCount !== undefined || s.value !== undefined ||
                    typeof s.variableName === "string") valueObjs++;
            }
            if (valueObjs === 1) condName = o.name;
            return;
        }
        if (o.content) {
            for (var k = 0; k < o.content.length; k++) walk(o.content[k], d + 1);
        }
        var named = o.namedContent;
        if (named && typeof named.forEach === "function") named.forEach(function (c) { walk(c, d + 1); });
    })(container, 0);

    return condName;
}

/**
 * For one router arm container, decide which condition value steers the
 * runtime into it, given the router's condition variable name:
 *  - arm whose condition eval contains the bare Ct(condVar) → true
 *  - arm with no condition eval at all (the `-else:` arm) → false
 *  - anything else → null (can't steer)
 */
function armConditionValue(arm, condVar) {
    if (!arm || !arm.content) return null;
    var sawCondVar = false;
    var sawOtherValue = false;
    for (var i = 0; i < arm.content.length; i++) {
        var c = arm.content[i];
        if (!c) continue;
        if (c.pathForCount !== undefined && typeof c.name === "string") {
            if (c.name === condVar) sawCondVar = true; else sawOtherValue = true;
        } else if (typeof c.variableName === "string" || c.value !== undefined) {
            sawOtherValue = true;
        }
    }
    if (sawCondVar && !sawOtherValue) return true;   // `-condVar:` arm
    if (!sawCondVar && !sawOtherValue) return false; // `-else:` arm
    return null;
}

/**
 * Like the branch probe used for picking, but returns full route info so
 * the caller can steer conditional routers toward the cursor. Returns
 * { startLine, routes } or null when the choice can't be probed.
 *
 * Each route is { targetPath, startLine, endLine, conditionVar,
 * conditionValue }:
 *  - targetPath: where the route's divert points (a content knot)
 *  - startLine / endLine: source range of that content
 *  - conditionVar / conditionValue: when the route goes through a
 *    conditional router (`{ -var: -> a -else: -> b }`), the variable
 *    whose value selects this route, and the value that steers into it.
 */
function probeBranchRoutes(story, choice, cursorFilePath) {
    try {
        if (!choice || !choice.targetPath) return null;
        var result = story.ContentAtPath(choice.targetPath);
        if (!result || !result.obj) return null;

        var info = scanOneContainer(result.obj, cursorFilePath);
        if (info.firstContentLine !== Infinity) {
            return { startLine: info.firstContentLine, routes: [] };
        }

        var routes = collectRoutes(story, result.obj, cursorFilePath, {}, 0);
        var best = Infinity;
        for (var r = 0; r < routes.length; r++) {
            if (routes[r].startLine < best) best = routes[r].startLine;
        }
        return { startLine: best, routes: routes };
    } catch (e) {
        return null;
    }
}

/**
 * Scan one container for real content and onward routes.
 * Returns { firstContentLine, minLine, maxLine, storyDiverts } — see
 * scanContainer for field semantics. If the container itself holds real
 * content, firstContentLine is its earliest line.
 */
function scanOneContainer(container, cursorFilePath) {
    var info = {
        firstContentLine: Infinity,
        minLine: Infinity,
        maxLine: -Infinity,
        storyDiverts: []
    };
    scanContainer(container, cursorFilePath, info, 0);
    return info;
}

/**
 * Collect the "routes" out of a routing-only container: each route is a
 * divert whose target holds real content (directly or after further
 * hops). Machinery diverts (rejoin NoOps like `-> knot.2`) are skipped
 * because we only accept targets that are containers holding real content.
 *
 * When the routing container is a conditional router
 * (`{ -cond: -> a -else: -> b }`), each route is annotated with the
 * condition variable and the boolean value that steers the runtime into
 * that route's arm.
 */
function collectRoutes(story, container, cursorFilePath, seen, depth) {
    var routes = [];
    if (!container || depth > 6) return routes;

    var info = scanOneContainer(container, cursorFilePath);
    if (info.firstContentLine !== Infinity) return routes; // content here: no routes needed

    var condVar = routerConditionVar(container);

    // Direct story diverts found anywhere in this container (including
    // router arms' `b` sub-containers).
    for (var d = 0; d < info.storyDiverts.length; d++) {
        var tp = info.storyDiverts[d];
        var key = tp.toString();
        if (seen[key]) continue;

        var targetResult = null;
        try {
            targetResult = story.ContentAtPath(tp);
        } catch (e) { continue; }
        if (!targetResult || !targetResult.obj) continue;
        var target = targetResult.obj;

        // Which router arm (if any) does this divert live in?
        var condValue = null;
        if (condVar) {
            var arm = findOwningArm(container, tp);
            condValue = arm ? armConditionValue(arm, condVar) : null;
        }

        // Resolve chains: if target is itself routing-only, recurse.
        var subInfo = scanOneContainer(target, cursorFilePath);
        if (subInfo.firstContentLine !== Infinity) {
            seen[key] = true;
            routes.push({
                targetPath: tp,
                startLine: subInfo.minLine,
                endLine: subInfo.maxLine,
                conditionVar: condValue !== null ? condVar : null,
                conditionValue: condValue
            });
        } else {
            seen[key] = true;
            var subRoutes = collectRoutes(story, target, cursorFilePath, seen, depth + 1);
            for (var s = 0; s < subRoutes.length; s++) {
                routes.push({
                    targetPath: subRoutes[s].targetPath,
                    startLine: subRoutes[s].startLine,
                    endLine: subRoutes[s].endLine,
                    conditionVar: subRoutes[s].conditionVar || (condValue !== null ? condVar : null),
                    conditionValue: subRoutes[s].conditionValue !== null && subRoutes[s].conditionValue !== undefined
                        ? subRoutes[s].conditionValue : condValue
                });
            }
        }
    }
    return routes;
}

/**
 * Find which router arm container (direct child of `router`) contains the
 * divert with target path `tp` (directly or inside its named `b`).
 * Returns the arm container or null.
 */
function findOwningArm(router, tp) {
    if (!router || !router.content) return null;
    for (var i = 0; i < router.content.length; i++) {
        var arm = router.content[i];
        if (!arm || !arm.content) continue;
        var found = false;
        (function walk(o, d) {
            if (!o || d > 5 || found) return;
            var isDiv = o._targetPointer !== undefined && !o.content;
            if (isDiv && o._targetPath && o._targetPath.toString() === tp.toString()) found = true;
            if (o.content) for (var k = 0; k < o.content.length; k++) walk(o.content[k], d + 1);
            var named = o.namedContent;
            if (named && typeof named.forEach === "function") named.forEach(function (c) { walk(c, d + 1); });
        })(arm, 0);
        if (found) return arm;
    }
    return null;
}

/**
 * At a choice point, determine which branch to take.
 *
 * For each branch we probe the source line where its content starts, then
 * pick the branch whose start line is closest to (and <= ) the cursor line.
 * If the cursor is before all branches we fall back to choice 0.
 *
 * Returns the chosen index. When the chosen branch routes through a
 * conditional router (e.g. `{ -var: -> pass -else: -> fail }`), we also
 * record (on `story._scenePreviewSteer`) which condition variable should
 * be forced so the runtime follows the route whose content range contains
 * the cursor — otherwise the router would always take its default arm.
 */
function chooseBranchIndex(story, cursorFilePath, cursorLine) {
    var choices = story.currentChoices;
    if (!choices || choices.length === 0) return 0;
    if (choices.length === 1) return 0;

    var branchStartLines = [];
    var branchRoutes = [];
    for (var i = 0; i < choices.length; i++) {
        var ch = choices[i];
        var tp = ch && ch.targetPath && ch.targetPath.toString ? ch.targetPath.toString() : "?";
        var probed = probeBranchRoutes(story, ch, cursorFilePath);
        var line = probed ? probed.startLine : Infinity;
        branchStartLines.push(line);
        branchRoutes.push(probed ? probed.routes : []);
        dbg("  choice", i, "target=", tp, "startLine=", line, "routes=", describeRoutes(probed && probed.routes));
    }

    var bestBranch = 0;
    var bestLine = -Infinity;
    for (var j = 0; j < branchStartLines.length; j++) {
        if (branchStartLines[j] <= cursorLine && branchStartLines[j] >= bestLine) {
            bestBranch = j;
            bestLine = branchStartLines[j];
        }
    }

    // Steer conditional routers on the chosen branch toward the cursor:
    // find the route whose content start is closest to (and <=) the cursor
    // and remember its condition var + value so the runtime takes that arm.
    var steer = null;
    var routes = branchRoutes[bestBranch];
    if (routes && routes.length > 0) {
        var bestRoute = null;
        for (var r = 0; r < routes.length; r++) {
            var route = routes[r];
            if (route.startLine <= cursorLine &&
                (bestRoute === null || route.startLine > bestRoute.startLine)) {
                bestRoute = route;
            }
        }
        // No route at/below the cursor (cursor before all branch content)?
        // Steer to the earliest route so the preview shows the branch start.
        if (bestRoute === null) {
            for (var r2 = 0; r2 < routes.length; r2++) {
                if (bestRoute === null || routes[r2].startLine < bestRoute.startLine) {
                    bestRoute = routes[r2];
                }
            }
        }
        if (bestRoute && bestRoute.conditionVar && bestRoute.conditionValue !== null) {
            steer = { varName: bestRoute.conditionVar, value: bestRoute.conditionValue };
        }
    }
    story._scenePreviewSteer = steer;
    dbg("chooseBranchIndex cursor=", cursorLine, "lines=", branchStartLines, "→ branch", bestBranch,
        "steer=", steer);
    return bestBranch;
}

/**
 * Compact human-readable dump of routes for the dbg trace.
 */
function describeRoutes(routes) {
    if (!routes || routes.length === 0) return "(none)";
    var parts = [];
    for (var i = 0; i < routes.length; i++) {
        var r = routes[i];
        parts.push("L" + r.startLine + "-" + r.endLine +
            (r.conditionVar ? "(" + r.conditionVar + "=" + r.conditionValue + ")" : "") +
            "→" + (r.targetPath ? r.targetPath.toString() : "?"));
    }
    return "[" + parts.join(", ") + "]";
}

/**
 * Force a story variable so a conditional router takes the desired arm.
 * Uses the variablesState proxy-style accessor `$` (name, value) which
 * wraps SetGlobal and enforces declaration. Non-destructive to preview:
 * this is a preview-only story instance anyway.
 */
function applySteer(story, steer) {
    try {
        var vs = story.variablesState;
        if (!vs) return;
        if (typeof vs.$ === "function") {
            vs.$(steer.varName, steer.value);
            dbg("  steered ", steer.varName, "=", steer.value);
            return;
        }
        // Fallback: direct SetGlobal(name, inkjs Value) if reachable
        if (typeof vs.SetGlobal === "function") {
            vs.SetGlobal(steer.varName, steer.value);
        }
    } catch (e) {
        dbg("  steer failed:", e && e.message);
    }
}

/**
 * Run the story from the beginning, stopping at the cursor position.
 * Returns the variable state at that point.
 */
function runToCursor(story, cursorFilePath, cursorLine) {
    var steps = 0;
    var lastVars = snapshotVariablesState(story);
    dbg("runToCursor cursorLine=", cursorLine, "file=", cursorFilePath);

    while (steps < MAX_STEPS) {
        steps++;

        if (story.canContinue) {
            story.Continue();

            var info = getCurrentLine(story, cursorFilePath);
            dbg("  after Continue line=", info && info.line, "fileMatch=", info && info.fileMatch);

            if (info && info.fileMatch && info.line >= cursorLine) {
                dbg("  -> stopping at line", info.line, ">= cursor", cursorLine);
                return snapshotVariablesState(story);
            }

            lastVars = snapshotVariablesState(story);

        } else if (story.currentChoices && story.currentChoices.length > 0) {
            var idx = chooseBranchIndex(story, cursorFilePath, cursorLine);
            dbg("  ChooseChoiceIndex(", idx, ")");

            // Steer conditional routers (skill checks like
            // `{ -value_test_passed: -> pass -else: -> fail }`) toward the
            // cursor: force the condition variable before choosing, so the
            // runtime takes the arm whose content we're previewing.
            var steer = story._scenePreviewSteer;
            if (steer && steer.varName) {
                applySteer(story, steer);
            }

            story.ChooseChoiceIndex(idx);
        } else {
            dbg("  end of story, returning current state");
            return snapshotVariablesState(story);
        }
    }

    dbg("  MAX_STEPS reached");
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
