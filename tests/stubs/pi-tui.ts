// Re-export only the TUI runtime used by pi-goal-x tests. Importing the package
// root initializes unrelated media/native modules and dominates cold startup.
export { Editor } from "@earendil-works/pi-tui/dist/components/editor.js";
export { Text } from "@earendil-works/pi-tui/dist/components/text.js";
export { Key, matchesKey } from "@earendil-works/pi-tui/dist/keys.js";
export { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui/dist/utils.js";
