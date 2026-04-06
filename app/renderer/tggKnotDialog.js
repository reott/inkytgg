const i18n = require("./i18n.js");

var DEFAULT_PROMPT_TEXT = "Wähle eine Fähigkeit.";
var NAME_PATTERN = /^[A-Za-z0-9_]+$/;
var CHARACTERS = ["fayola", "raul", "clara"];
var ABILITIES = [
    { id: "negotiation", label: "Negotiation", className: "negotiation" },
    { id: "seduction", label: "Seduction", className: "seduction" },
    { id: "perception", label: "Perception", className: "perception" },
    { id: "coolness", label: "Coolness", className: "coolness" }
];

var events = {
    getExistingText: () => "",
    insertSnippet: () => {},
    focusEditor: () => {}
};

var els = {};

function init(newEvents) {
    events = newEvents || events;

    els.backdrop = document.getElementById("tgg-knot-dialog-backdrop");
    els.form = document.getElementById("tgg-knot-dialog-form");
    els.error = document.getElementById("tgg-knot-dialog-error");
    els.promptText = document.getElementById("tgg-knot-prompt-text");
    els.baseName = document.getElementById("tgg-knot-base-name");
    els.character = document.getElementById("tgg-knot-character");
    els.abilities = Array.from(document.querySelectorAll(".tgg-knot-ability input"));
    els.cancelButton = document.getElementById("tgg-knot-cancel");
    els.insertButton = document.getElementById("tgg-knot-insert");

    populateCharacterOptions();
    resetForm();

    els.form.addEventListener("submit", onSubmit);
    els.cancelButton.addEventListener("click", close);
    els.backdrop.addEventListener("click", function (event) {
        if (event.target === els.backdrop) close();
    });

    els.baseName.addEventListener("blur", function () {
        els.baseName.value = sanitiseBaseName(els.baseName.value);
    });

    document.addEventListener("keydown", function (event) {
        if (els.backdrop.classList.contains("hidden")) return;
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        }
    });
}

function populateCharacterOptions() {
    var html = "";
    for (var i = 0; i < CHARACTERS.length; i++) {
        var character = CHARACTERS[i];
        html += '<option value="' + character + '">' + character + '</option>';
    }
    els.character.innerHTML = html;
}

function open() {
    resetForm();
    els.backdrop.classList.remove("hidden");
    els.baseName.focus();
    els.baseName.select();
}

function close() {
    els.backdrop.classList.add("hidden");
    clearError();
    events.focusEditor();
}

function resetForm() {
    els.promptText.value = DEFAULT_PROMPT_TEXT;
    els.baseName.value = "";
    els.character.value = CHARACTERS[0];
    clearAbilities();
    if (els.abilities[0]) els.abilities[0].checked = true;
    clearError();
}

function clearAbilities() {
    for (var i = 0; i < els.abilities.length; i++) {
        els.abilities[i].checked = false;
    }
}

function onSubmit(event) {
    event.preventDefault();
    clearError();

    var promptText = (els.promptText.value || "").trim();
    var baseName = sanitiseBaseName(els.baseName.value);
    var character = els.character.value;
    var abilities = getSelectedAbilities();
    var branchCount = abilities.length;

    els.baseName.value = baseName;

    var validationError = validateForm(promptText, baseName, branchCount, abilities);
    if (validationError) {
        showError(validationError);
        return;
    }

    var generatedNames = buildGeneratedNames(baseName, abilities);
    var duplicateName = findDuplicateName(events.getExistingText(), generatedNames);
    if (duplicateName) {
        showError(i18n._("Name already exists in this text:") + " " + duplicateName);
        return;
    }

    var snippet = buildSnippet(promptText, baseName, character, abilities);
    events.insertSnippet(snippet);
    close();
}

function validateForm(promptText, baseName, branchCount, abilities) {
    if (!promptText) return i18n._("Please enter the prompt text.");
    if (!baseName) return i18n._("Please enter a name.");
    if (!NAME_PATTERN.test(baseName)) {
        return i18n._("The name may only contain letters, numbers, and underscores.");
    }
    if (branchCount < 1 || branchCount > 4) {
        return i18n._("Please select between 1 and 4 abilities.");
    }
    return null;
}

function getSelectedAbilities() {
    var selected = [];
    for (var i = 0; i < els.abilities.length; i++) {
        if (els.abilities[i].checked) selected.push(els.abilities[i].value);
    }
    return selected;
}

function sanitiseBaseName(value) {
    value = (value || "").trim().toLowerCase();
    value = value.replace(/[^a-z0-9_]+/g, "_");
    value = value.replace(/_+/g, "_");
    value = value.replace(/^_+|_+$/g, "");

    if (/^\d/.test(value)) value = "knot_" + value;

    return value;
}

function buildGeneratedNames(baseName, abilities) {
    var names = [baseName + "_end"];
    for (var i = 0; i < abilities.length; i++) {
        names.push(baseName + "_" + abilities[i]);
        names.push(baseName + "_" + abilities[i] + "_pass");
        names.push(baseName + "_" + abilities[i] + "_fail");
    }
    return names;
}

function findDuplicateName(text, generatedNames) {
    for (var i = 0; i < generatedNames.length; i++) {
        var name = generatedNames[i];
        var regex = new RegExp("(^|[^A-Za-z0-9_])" + escapeRegExp(name) + "($|[^A-Za-z0-9_])");
        if (regex.test(text)) return name;
    }
    return null;
}

function buildSnippet(promptText, baseName, character, abilities) {
    var sections = [];
    var lines = [promptText, ""];

    for (var i = 0; i < abilities.length; i++) {
        lines.push("* [ #" + character + "_" + abilities[i] + "] -> " + baseName + "_" + abilities[i]);
    }

    sections.push(lines.join("\n"));

    for (var j = 0; j < abilities.length; j++) {
        var branchName = baseName + "_" + abilities[j];
        sections.push([
            "================================= " + branchName + " =================================",
            "{",
            "    -value_test_passed:",
            "        -> " + branchName + "_pass",
            "    -else:",
            "        -> " + branchName + "_fail",
            "}"
        ].join("\n"));
    }

    for (var k = 0; k < abilities.length; k++) {
        var passFailBaseName = baseName + "_" + abilities[k];
        sections.push([
            "================================= " + passFailBaseName + "_pass =================================",
            "",
            "",
            "-> " + baseName + "_end"
        ].join("\n"));

        sections.push([
            "================================= " + passFailBaseName + "_fail =================================",
            "",
            "",
            "-> " + baseName + "_end"
        ].join("\n"));
    }

    sections.push("================================= " + baseName + "_end =================================");

    return sections.join("\n\n") + "\n";
}

function showError(message) {
    els.error.textContent = message;
    els.error.classList.remove("hidden");
}

function clearError() {
    els.error.textContent = "";
    els.error.classList.add("hidden");
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

exports.TggKnotDialog = {
    init: init,
    open: open,
    close: close
};
