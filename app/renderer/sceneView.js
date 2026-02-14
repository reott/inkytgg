/**
 * Renders scene state (variables, errors) in the #player scene view area.
 */

function getVariablesEl() {
    return document.querySelector("#scene-view .scene-variables");
}

function getErrorEl() {
    return document.querySelector("#scene-view .scene-error");
}

function updateScene(variables) {
    var el = getVariablesEl();
    var errEl = getErrorEl();
    if (errEl) {
        errEl.textContent = "";
        errEl.classList.add("hidden");
    }
    if (!el) return;
    el.classList.remove("hidden");
    if (!variables || typeof variables !== "object") {
        el.innerHTML = "<p class='scene-empty'>No variables</p>";
        return;
    }
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

function showError(message) {
    var el = getVariablesEl();
    var errEl = getErrorEl();
    if (el) {
        el.innerHTML = "";
        el.classList.add("hidden");
    }
    if (errEl) {
        errEl.textContent = message || "Unknown error";
        errEl.classList.remove("hidden");
    }
}

function clear() {
    var el = getVariablesEl();
    var errEl = getErrorEl();
    if (el) {
        el.innerHTML = "<p class='scene-empty'>Move cursor to evaluate</p>";
        el.classList.remove("hidden");
    }
    if (errEl) {
        errEl.textContent = "";
        errEl.classList.add("hidden");
    }
}

exports.SceneView = {
    updateScene: updateScene,
    showError: showError,
    clear: clear
};
