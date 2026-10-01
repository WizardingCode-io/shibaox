# The composer: attachments, actions, voice (0.2.9)

2026-10-01. Andre: "tenho que conseguir drag and drop qualquer tipo de ficheiro para ser lido,
editado e/ou utilizado como referência; aquele trovão… é para activar". The three controls of the
mockup's composer (+, bolt, mic) become real.

## Attachments
- Drop any files on the conversation (the thread or the composer) or pick them with **+**: they
  show as chips above the text (name, size, remove) and go with the next message. Up to 20 files
  and 25 MB per message.
- `POST /runs` takes `attachments: [{ name, content (base64), mime? }]`. The daemon writes them
  into the turn's workspace under `attachments/<name>` (names made safe, `-2` on a clash) right
  after the workspace exists, records each as a `file_changed` of node `you` (they show as chips
  and under Outputs, and in `shibaox files`), and appends to the message:
  `[Attached files]\n- attachments/report.csv (12 KB, text/csv)`. The model reads them with its
  file tools (text, CSV, code, Markdown; an image is a file it can hand to tools that take one).
- A first message of a new conversation carries attachments the same way.
- Not yet (next slice): images as vision input to the model; a local image as a Higgsfield
  reference (the daemon doing Higgsfield's two-step upload); text out of PDF and DOCX.

## Actions (the bolt)
- A menu above the bolt: **Run a workflow** (every workflow of the org that is not a
  conversation: name and description; picking one prefills "Run <name>: " and the next message
  starts that workflow in this conversation instead of a chat turn, with the text as its input),
  **Generate an image…** / **Generate a video…** (prefill a prompt for Higgsfield), **Attach
  files…** (the picker).

## Voice (the mic)
- With the browser's speech recognition (Chrome): the mic listens and the words land in the
  text; press again to stop. Without it (the desktop app, Safari, Firefox) the mic is not shown.

## Design system
- `Composer` gains `value`/`onChange` (controlled text), `attachments` + `onAttach(files)` +
  `onRemoveAttachment(index)` + `dropping` (a highlighted border while files hover), `onActionsClick`
  + `actionsMenu` + `onActionsMenuClose` (like the model menu), `onVoice` + `listening` + `voice`
  (false hides the mic). Drag and drop handlers on the composer itself; the app adds the thread.
