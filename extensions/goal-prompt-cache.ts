import { asRecord } from "./goal-record.ts";

/**
 * Index of the last message that carries content. Pi's persistent-effort
 * support (`supportsMidConvoEffort`) appends an effort-only marker,
 * `{role: "system", content: [], output_config: {effort}}`, after the message
 * it has already marked for caching. A contentless message holds no
 * breakpoint and changes no prefix, so look past it rather than surrender the
 * conversation to the volatile tail.
 */
function tailMessageIndex(messages: readonly unknown[]): number {
 for (let i = messages.length - 1; i >= 0; i--) {
  const content = asRecord(messages[i])?.content;
  const hasContent = typeof content === "string" || Array.isArray(content) ? content.length > 0 : content !== null && content !== undefined;
  if (hasContent) return i;
 }
 return -1;
}

/**
 * Pi marks the final user block for explicit caching. Our request-only state
 * never enters history, so that block cannot be reused on the next request.
 * Move that existing breakpoint to the preceding cacheable history block.
 * Implicit caches and cacheRetention=none have no marker and are untouched.
 * Reuse the provider's TTL and marker count rather than enabling caching here.
 */
export function cacheGoalHistory(payload: unknown, liveContent: string | undefined): unknown {
 const root = asRecord(payload);
 if (!liveContent || !Array.isArray(root?.messages)) return undefined;
 const messages = root.messages;
 const lastIndex = tailMessageIndex(messages);
 const last = asRecord(messages[lastIndex]);
 if (last?.role !== "user" || !Array.isArray(last.content)) return undefined;
 // Bedrock represents its breakpoint as a separate content block.
 const bedrockPoint = asRecord(last.content.at(-1));
 if (asRecord(bedrockPoint?.cachePoint) && asRecord(last.content.at(-2))?.text === liveContent) {
  for (let i = lastIndex - 1; i >= 0; i--) {
   const previous = asRecord(messages[i]);
   if (!Array.isArray(previous?.content) || previous.content.length === 0) continue;
   if (!previous.content.some(block => asRecord(block)?.cachePoint)) previous.content.push(bedrockPoint);
   last.content.pop();
   return payload;
  }
  return undefined;
 }
 const tail = asRecord(last.content.at(-1));
 if (tail?.type !== "text" || tail.text !== liveContent || !asRecord(tail.cache_control)) return undefined;
 for (let i = lastIndex; i >= 0; i--) {
  const message = asRecord(messages[i]);
  if (!message || !["user", "assistant", "tool"].includes(String(message.role))) continue;
  if (typeof message.content === "string" && message.content.length > 0) {
   message.content = [{ type: "text", text: message.content, cache_control: tail.cache_control }];
   delete tail.cache_control;
   return payload;
  }
  if (!Array.isArray(message.content)) continue;
  for (let j = message.content.length - 1; j >= 0; j--) {
   const block = asRecord(message.content[j]);
   // Thinking blocks cannot carry cache_control. Never split/reorder tool pairs.
   if (!block || block === tail || !["text", "image", "tool_use", "tool_result"].includes(String(block.type))) continue;
   block.cache_control ??= tail.cache_control;
   delete tail.cache_control;
   return payload;
  }
 }
 return undefined;
}
