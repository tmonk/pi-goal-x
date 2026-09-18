# Cache breakpoint relocation behind Pi's effort marker

The 0.31.6 breakpoint relocation must survive host payload shapes that place a
message after the request-only goal state. For models with
`supportsMidConvoEffort`, Pi 0.85.1 appends an effort-only marker,
`{role: "system", content: [], output_config: {effort}}`, after the message it
has already marked for caching. The relocation never runs on those models and
#67's amplification returns in full: the breakpoint stays on goal state that is
rewritten every request, and only the prefix ahead of the conversation is
reusable.

Relocation must key on the last message that carries content rather than on the
final array element. Payloads without an explicit marker, implicit-cache
providers, and a trailing message belonging to another extension must continue
to be left untouched.
