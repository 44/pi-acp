// src/pi-extension-ask-user.ts
var FREEFORM_OPTION = "Other (type an answer)";
var PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: {
      type: "string",
      description: "The single question to ask the user."
    },
    context: {
      type: "string",
      description: "Short summary of what you already found, shown above the question (optional)."
    },
    options: {
      type: "array",
      description: "Choices to offer. Omit for a free-form answer.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "Short title for this option" },
          description: { type: "string", description: "Optional detail explaining the option" }
        },
        required: ["title"]
      }
    },
    allowFreeform: {
      type: "boolean",
      description: `Also allow a typed answer alongside the options. Default: true.`
    }
  },
  required: ["question"]
};
function asText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function normalizeOptions(value) {
  if (!Array.isArray(value)) return [];
  const options = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const title2 = asText(entry);
      if (title2) options.push({ title: title2 });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const rec = entry;
    const title = asText(rec.title);
    if (!title) continue;
    const description = asText(rec.description);
    options.push(description ? { title, description } : { title });
  }
  return options;
}
function dialogTitle(question, context) {
  return context ? `${question}

${context}` : question;
}
function finish(question, options, answer, cancelled) {
  const text = cancelled ? `The user cancelled the question: ${question}` : answer ?? "The user did not answer.";
  return {
    content: [{ type: "text", text }],
    details: { question, options, answer, cancelled }
  };
}
async function ask(params, signal, ctx) {
  const question = asText(params.question);
  if (!question) {
    throw new Error('ask_user needs a non-empty "question".');
  }
  const context = asText(params.context);
  const options = normalizeOptions(params.options);
  const labels = options.map((option) => option.description ? `${option.title} \u2014 ${option.description}` : option.title);
  const allowFreeform = params.allowFreeform !== false;
  const title = dialogTitle(question, context);
  const ui = ctx.ui;
  if (!ctx.hasUI || !ui?.select || !ui.input) {
    const optionText = labels.length > 0 ? `

Options:
${labels.map((label) => `- ${label}`).join("\n")}` : "";
    throw new Error(`No interactive UI is available. Ask the user in chat:

${title}${optionText}`);
  }
  if (signal?.aborted) {
    return finish(question, labels, null, true);
  }
  if (labels.length === 0) {
    const typed = await ui.input(title, "Type your answer...");
    const answer = asText(typed);
    return finish(question, labels, answer, answer === null);
  }
  const choices = allowFreeform ? [...labels, FREEFORM_OPTION] : labels;
  const chosen = await ui.select(title, choices);
  if (chosen === void 0) {
    return finish(question, labels, null, true);
  }
  if (chosen === FREEFORM_OPTION) {
    const typed = await ui.input(title, "Type your answer...");
    const answer = asText(typed);
    return finish(question, labels, answer, answer === null);
  }
  return finish(question, labels, chosen, false);
}
function pi_extension_ask_user_default(pi) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: "Ask the user a focused question, optionally with multiple-choice answers. Use it when intent is ambiguous, a decision needs explicit approval, or several valid options exist \u2014 instead of guessing.",
    promptSnippet: "Ask the user one focused question (with optional multiple-choice answers) when guessing would be worse than asking",
    promptGuidelines: [
      "Gather context with tools first, then ask; pass a short summary via the context field so the question stands alone.",
      "Ask one focused question per call. Ask follow-up questions in a later call rather than combining unrelated ones.",
      "Prefer options over open-ended text when the plausible answers are enumerable."
    ],
    exposure: "model-only",
    executionMode: "sequential",
    parameters: PARAMETERS,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => ask(params, signal, ctx)
  });
}
export {
  pi_extension_ask_user_default as default
};
