# Local Voice Reference

Place a reference clip at `voice/katou-reference.wav`. The clip should be 3-10 seconds, contain one clear speaker, and have an exact transcript for `tts_prompt_text` in `config.toml`.

Import a file with:

```bash
bash scripts/import-katovoice.sh /path/to/reference.wav
```

The importer converts supported inputs to mono 32 kHz WAV. This directory deliberately ignores audio files in Git. Only add a voice asset to a public release when its license explicitly permits redistribution.

FMOD `.bank` files are not valid GPT-SoVITS references. Decode an authorized source file to WAV first, then import the WAV.
