# How to start the Demo Store PoC

## One-command (recommended)

From the parent `PO/` folder (or from `burgers-forever/`):

```bash
npm run install:env   # create TTS venv + install Python deps
npm start             # Demo Store :5500 + Kokoro TTS :7860
npm stop              # stop both
```

Aliases: `npm run start:all` / `npm run stop:all`.

TTS is resolved from `../text-to-speech`, `../experiments/text-to-speech`, or `TTS_ROOT`.

See `../HOW_TO_INSTALL_AND_RUN.md` for full prerequisites (Python, Node, VC++ Redistributable on Windows).

## Controls

| Key | Action |
| --- | --- |
| Arrow keys | Move focus |
| Enter | Select / activate |
| `V` | Cycle assistive volume |
