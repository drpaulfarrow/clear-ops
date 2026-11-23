/**
 * Models that take no images (23 Nov 2026). Some of the open-weight models the workforce runs on
 * through OpenRouter are text only. When a worker on one opens an image file, the Read tool hands the
 * model the picture, OpenRouter answers "400 No endpoints found that support image input", and the
 * whole run ends as an API error with its work unreported.
 *
 * That stopped the first plan on its first evening. Step four built an app shell, took screenshots of
 * it to check its own work, opened one, and died. The retry found the work in the tree, took the
 * screenshots again, opened one, and died, three times, and then three times more the next morning.
 * Nothing about the failure said what it was, so nothing could be done differently the next time.
 *
 * Two things cure it, both in code:
 *   - a run on a model known to take no images cannot open an image file at all: the Read is refused
 *     before it happens (a PreToolUse hook in the SDK runner), with a plain reason, and the worker is
 *     told so in its prompt and carries on by other means;
 *   - the service learns which models those are from the failure itself: the first run to die this
 *     way has its model remembered (settings.textOnlyModels) and is run again at once with the guard
 *     on, so no model costs more than one such run, and none costs a job.
 * Learning from the refusal needs no list of what each model accepts and cannot go stale with one.
 *
 * Refusing the picture means nobody looks at the page. So where a larger tier runs on a model not
 * known to be text only, a run that needs to look switches to it instead (Paul, 23 Nov 2026: "if it
 * NEEDS to use images, it should switch"): the Read of an image stops the cheap run where it stands,
 * and the job carries on at once on that tier, fresh, with the work so far in its folder. Only the
 * runs that open a picture pay for the larger model. With no such tier, the refusal above stands.
 */
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "./store.js";

/** The tiers a run switches to when it needs to look at an image, in order of preference. */
export const VISION_ALIASES = ["opus", "fable"] as const;

/** A file the Read tool would hand to the model as a picture. */
export const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif|heic|ico)$/i;
/** How many models are remembered. Past it the oldest go. */
export const TEXT_ONLY_MAX = 30;

/** True for the failure a provider gives when a model that takes no images was sent one. */
export function isImageInputFailure(failure: { detail?: string } | string | undefined): boolean {
  const text = typeof failure === "string" ? failure : (failure?.detail ?? "");
  return /support(?:s|ing)? image input|image input (?:is )?not supported|does(?: not|n't) support images?\b|images? (?:are|is) not supported/i.test(text);
}

/** The models known to take no images, by the id each run was sent to. */
export function textOnlyModels(store: Pick<Store, "settings">): string[] {
  return store.settings().textOnlyModels ?? [];
}

export function isTextOnly(store: Pick<Store, "settings">, model: string): boolean {
  return textOnlyModels(store).includes(model);
}

/** Remembers that a model takes no images. Returns true when that is news. */
export function rememberTextOnly(store: Pick<Store, "settings" | "setSetting">, model: string): boolean {
  const known = textOnlyModels(store);
  if (!model || known.includes(model)) return false;
  store.setSetting("textOnlyModels", [...known, model].slice(-TEXT_ONLY_MAX));
  return true;
}

/** What a worker on such a model is told, at the end of its task. */
export const TEXT_ONLY_NOTE = `\n\nThe model you are running on cannot take images. Never open an image file (a screenshot, a diagram, a photo) with the Read tool: it is refused, because it would end your run. You can still make screenshots for a pull request and commit them; just do not open them. Check a page by what can be read as text instead: its HTML, a test, the status and headers of a request, an accessibility or DOM dump. Say in your report what you could not look at.`;

/** What the refused Read says, as the tool's answer. */
export const IMAGE_READ_REFUSAL = "This model cannot take images, so opening an image file would end the run. The file has not been read. Do not try again or open it another way. Check the thing by what can be read as text (its HTML, a test, a request's status, a DOM dump), and say in your report that you could not look at the picture.";

/** The PreToolUse hook: refuses a Read of an image file, and lets every other call through untouched. */
export const refuseImageRead: HookCallback = async (input) => {
  const call = input as { hook_event_name?: string; tool_name?: string; tool_input?: unknown };
  if (call.hook_event_name !== "PreToolUse" || call.tool_name !== "Read") return {};
  const file = (call.tool_input as { file_path?: unknown } | undefined)?.file_path;
  if (typeof file !== "string" || !IMAGE_FILE.test(file.trim())) return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: IMAGE_READ_REFUSAL } };
};

/**
 * The tier a run on a text-only model switches to when it needs to see an image: the first of
 * VISION_ALIASES that runs on another model not known to be text only. Undefined when there is none.
 */
export function visionAlias(store: Pick<Store, "settings">, current: string, resolve: (alias: string) => string): string | undefined {
  return VISION_ALIASES.find((alias) => {
    const model = resolve(alias);
    return model !== current && !isTextOnly(store, model);
  });
}

/** What the stopped run is told by the refused Read (it ends there, so it reads this only in its record). */
export const IMAGE_SWITCH_STOP = "This model cannot take images, so the run stops here and the job carries on at once on a model that can, with the work so far in its folder.";

/**
 * The PreToolUse hook for a run that may switch: a Read of an image file is refused and the run is
 * stopped where it stands, and onNeed is told which file, so the service can carry the job on with a
 * model that can see it. Every other call is untouched.
 */
export function stopForImage(onNeed: (file: string) => void): HookCallback {
  return async (input) => {
    const call = input as { hook_event_name?: string; tool_name?: string; tool_input?: unknown };
    if (call.hook_event_name !== "PreToolUse" || call.tool_name !== "Read") return {};
    const file = (call.tool_input as { file_path?: unknown } | undefined)?.file_path;
    if (typeof file !== "string" || !IMAGE_FILE.test(file.trim())) return {};
    onNeed(file.trim());
    return { continue: false, stopReason: IMAGE_SWITCH_STOP, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: IMAGE_SWITCH_STOP } };
  };
}

/** What the run that carries the job on is told, at the end of its task. */
export function switchedNote(file: string | undefined, from: string): string {
  const what = file ? `when it needed to look at ${file.split("/").pop()}` : "when it opened an image";
  return `\n\nThis job started on ${from}, which cannot take images, and that run stopped ${what}. You are carrying it on, on a model that can see images. The work so far is in your working folder (check git status and the branch): pick up from there rather than starting again, and look at the picture yourself.`;
}
