# Manual platform validation (macOS)

Some behavior can only be proven with the real platform: input methods, screen
readers and trackpads. Run the production smoke with the platform trace on, do
the steps below, and keep the trace — it records each platform event and the
runtime's resulting focus, committed text, selection (scalar offsets), preedit
and IME candidate area.

```bash
node bin/mun.mjs compile examples/NativeProductionSmoke.mun /tmp/smoke.json
```

```bash
MUN_NATIVE_TRACE=1 native/target/debug/mun-native /tmp/smoke.json 2> /tmp/mun-trace.jsonl
```

Each `MUN_TRACE` line is JSON: `platform` (winit/AccessKit event), `focused`,
`text`, `selection`, `preedit`, `imeAllowed`, `imeArea`.

## Keyboard and focus

1. Tab / Shift-Tab through every control. Expect focus to visit the project
   field, Details, the radio group, controls inside the scroll view (the view
   scrolls to reveal them), each task row's Done/note/Up/Down/Remove, and back.
2. In the radio group, arrow keys select options and skip "Unavailable".

## Korean IME (2-Set Korean)

3. Focus "Project name", select all, type `한국어`. While composing, the trace
   shows `preedit` with the current syllable, and the bound "Text(name)" line
   updates with each partial syllable; the candidate/compose window sits at
   the caret (`imeArea`).
4. Type several syllables, then move the caret into the middle of Korean text
   (arrow keys) and type `가` — it inserts at the caret, not at the end.
5. While a syllable is composing, press Tab. Expected: the syllable is
   committed into the field you left (`text` contains it), focus moves, and no
   stray preedit appears in the next field.
6. Select a range, then compose — the selection is replaced on commit.
7. Backspace while composing edits the composition (platform behavior), then
   deletes committed text once the composition is empty.
8. Click elsewhere in the field while composing: the composition commits, then
   the caret moves to the clicked position.
9. Mix Korean and English (`한글 abc 한`); switch input source mid-field.
10. Press Enter / Tab right after a commit; confirm they are not swallowed.

## Pointer text selection and clipboard

11. Click to place the caret, drag to select across Korean/emoji text,
    Shift-click to extend. Copy, cut, paste (⌘C/⌘X/⌘V) within and between
    fields and another app.

## Scrolling (trackpad)

12. Two-finger scroll inside the scroll view with momentum; scroll past the end
    of the inner view and confirm movement does not leak into an ancestor until
    the inner view is exhausted. Drag the scrollbar thumb; click the track.

## Keyed rows

13. Type a note in "Draft", press Add task, Up/Down, Remove on other rows: the
    note stays with its row; a newly added row starts empty; Done marks stay
    with their rows.

## VoiceOver (⌘F5)

14. VO-Right through the window: buttons, radio options (announced as radio
    buttons with selected state and "dimmed" for Unavailable), text fields read
    their value, the focused field is announced, edited values are re-read.
15. Toggle Details: the conditional content appears/disappears for VoiceOver;
    hidden branches are never read.
16. Controls inside the scroll view are reachable, and VO scrolls them into
    view. In a text field, VO character/word navigation does not split Hangul
    syllables or emoji.

Record pass/fail per step. Windows (UIA/IME) and Linux (AT-SPI/IBus) need the
same pass on those platforms; this checklist does not cover them.
