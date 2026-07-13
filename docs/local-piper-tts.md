# Local Swedish Piper TTS

The Third Place includes a small, repo-owned HTTP sidecar around Piper. It is
separate from the Node application and exposes only the API surface the voice
director needs:

- `GET /health`
- `GET /v1/models`
- `POST /v1/audio/speech` with `response_format: "wav"`

## Start it

```bash
npm run setup:tts
npm run start:tts
```

`setup:tts` creates an ignored `.venv-tts`, installs the verified compatibility
set `piper-tts==1.4.2`, `onnxruntime==1.24.4`, `pathvalidate==3.3.1` and
`numpy==2.4.4`, then downloads two Swedish voices into the persistent, ignored
`.cache/piper-tts` directory. Every cached file is checked for its exact size
and SHA-256 before use. Re-running setup reuses valid files.
The setup prefers Python 3.11 through `uv`, which has the widest tested
Piper/ONNX wheel coverage; `PIPER_TTS_BOOTSTRAP_PYTHON` can override it.

Setup reads exactly the repository's `.env` before resolving any Piper paths.
The venv must be a dedicated `.venv-tts` directory below the repository. It is
recursively replaced only when its own `.the-third-place-piper-runtime` marker
exists; an existing unmarked directory or symlink is left untouched. Cache and
runtime paths that escape the repository are rejected.

The default application configuration is:

```dotenv
TTS_BASE_URL=http://127.0.0.1:8179/v1
TTS_MODEL=piper-sv
TTS_VOICE=lisa-warm
TTS_FORMAT=wav
```

The sidecar always binds to `127.0.0.1`; port `8179` is the configurable default.
It is never exposed to ngrok guests. Remote browsers receive short-lived audio
through the authenticated application route instead. `PIPER_TTS_API_KEY` is an
optional defense in depth for the loopback hop; when enabled, set the same
value as `TTS_API_KEY` for the Node application.

Requests require JSON, a known model and voice alias, at most 600 input
characters, a declared body of at most 16 KiB and a finite speed. The sidecar
accepts only WAV output, limits generated audio to 4 MiB, rate-limits callers,
bounds concurrent synthesis and never logs text or authorization headers.

## Voice assets and provenance

Voice downloads are pinned to the immutable upstream revision
`e21c7de8d4eab79b902f0d61e662b3f21664b8d2` in
[`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices).

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `sv_SE-lisa-medium.onnx` | 63,511,038 | `94cae912b31d6e9140d3f5160f1815951588600c7a9e43d539ba1e81a110d131` |
| Lisa config | 7,239 | `51e48b65d7427aee9e8e736b370ff4fe6e3e45e47a56e5d8819647b7076ffb0a` |
| Lisa model card | 198 | `952c05227c175d48aafe40eb73935d8cf6b7a214ad4f9772b4180c084e5094c3` |
| `sv_SE-nst-medium.onnx` | 63,104,526 | `df011f56825a59dd1efc080c38a65a1ef70407e60f63050e9246f43a3d7e471e` |
| NST config | 4,157 | `d45dd74cbb4eca58694bf04a97e243044092476f28a55ae26424f0653086980a` |
| NST model card | 306 | `c85d3e26e47d93e9d9b8572d3c89537c3f8ff212595cb9a3fbd2e07c19432317` |

The upstream repository declares MIT metadata. NST's model card identifies its
source dataset as CC0 and says it was trained by KBLab at the National Library
of Sweden. Lisa's model card says it was fine-tuned from the Norwegian
`talesyntese` voice but does not state an explicit dataset/model license. The
assets are therefore opt-in downloads rather than committed distributables;
any redistribution must review the downloaded model cards and upstream terms.

Piper `1.4.2` is GPL-3.0-or-later. It remains an independently installed
sidecar process rather than a linked Node dependency. See `THIRD_PARTY_NOTICES.md`.
The four compatibility-critical packages above are version-pinned, but the
remaining transitive Python dependency graph is not yet distributed as a
cross-platform hash-locked wheel set. Do not describe the Python environment
as fully reproducible; a hashed platform lock is a separate hardening step.

## Resident profiles

The two base voices expose several bounded prosody aliases, such as
`lisa-warm`, `lisa-bright`, `nst-calm` and `nst-deep`. Every resident has one
hand-authored stable profile in `server/personaVoices.ts`. The voice director
sends its provider voice and speed to Piper and publishes language/rate/pitch
metadata for a disclosed browser fallback. New residents must add a profile;
there is deliberately no name- or gender-inference fallback.

After the app and sidecar are running, require real audio in the existing voice
smoke test with `EXPECT_TTS=true npm run smoke:voice`. It fetches the protected
audio URL as a room member and verifies the WAV container.
