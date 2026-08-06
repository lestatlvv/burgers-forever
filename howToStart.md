# How to start the Demo Store PoC

## One-command (recommended)

From `burgers-forever.webflow/`:

```bash
npm run start:all   # Demo Store :5500 + Kokoro TTS :7860
npm run stop:all    # stop both
```

TTS is resolved from `../text-to-speech`, `../experiments/text-to-speech`, or `TTS_ROOT`.

## Manual

### 1. Assistive speech (Kokoro)

```bash
cd /path/to/text-to-speech
./scripts/run_web.sh
```

→ [http://127.0.0.1:7860](http://127.0.0.1:7860)

### 2. Demo Store

```bash
cd burgers-forever.webflow
python3 -m http.server 5500 --bind 127.0.0.1
```

→ [http://127.0.0.1:5500/](http://127.0.0.1:5500/)

## Controls

| Key | Action |
| --- | --- |
| Arrow keys | Move focus |
| Enter | Select / activate |
| `V` | Cycle assistive volume |
