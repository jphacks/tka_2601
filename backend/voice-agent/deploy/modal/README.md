# Modal inference endpoints

The Pi and Mac mini host only the Monban API and LiveKit Agent worker. Modal serves three
versioned HTTPS endpoints: Ollama-compatible v20 chat, Kotoba-Whisper v2.1 transcription,
and Irodori TTS v4.1 Small-MF. All endpoints require a bearer token. ASR and TTS keep one
container warm at all times (`min_containers=1`, L4 or A10) so the first reply of a call does
not wait for a cold start. The LLM scales to zero (`min_containers=0`) and keeps a GPU for
at most 60 seconds after the last request; the API wakes it when a call starts.

## Deploy

Run these commands from `backend/voice-agent` on a machine with Modal CLI access:

```sh
python3 -m pip install -r deploy/modal/requirements.txt
modal setup
modal volume create monban-v20-models
modal volume create monban-asr-cache
modal volume create monban-speech-cache
```

Create three random bearer secrets locally. Store the values in the production environment
file and create the Modal secret without committing either file:

```sh
modal secret create monban-inference \
  MONBAN_LLM_API_TOKEN='<random LLM token>' \
  MONBAN_ASR_API_TOKEN='<random ASR token>' \
  MONBAN_TTS_API_TOKEN='<random TTS token>'
```

Upload the 5.3 GB model directly from labpc to avoid needing another 5.3 GB of free disk
space on the API host. In PowerShell on labpc, install the CLI, resolve the exact blob used
by the registered tag, and upload it as `v20.gguf` (the source blob is not modified):

```powershell
py -m pip install -r deploy/modal/requirements.txt
modal setup
$tag = "monban-reception-v20-e4b-qlora-q4km:20261109"
$line = (ollama show --modelfile $tag | Select-String '^FROM ').Line
$blob = $line -replace '^FROM\s+', ''
modal volume put monban-v20-models $blob v20.gguf
```

If `modal volume create` has not yet been run, create the three named volumes from the
Deploy section first. Then import the uploaded blob and deploy the endpoints:

```sh
modal run deploy/modal/llm.py::prepare_model
modal run deploy/modal/asr.py::prepare_model
modal run deploy/modal/tts.py::prepare_model
modal deploy deploy/modal/llm.py
modal deploy deploy/modal/asr.py
modal deploy deploy/modal/tts.py
```

Each `modal deploy` prints its HTTPS URL. Put those URLs in `.env.production` as
`DOOR_OLLAMA_BASE_URL`, `DOOR_ASR_BASE_URL`, and `DOOR_TTS_BASE_URL`. Set the matching
`DOOR_*_API_KEY` values to the bearer secrets above. The v20 API preserves its Ollama model
ID and tool-call support; STT and TTS use OpenAI-compatible audio routes. The speech.cpp
Irodori voice is `none` unless a consented reference voice is separately provisioned.

## Pi / Mac mini API host

Copy `.env.production.example` to `.env.production`, fill the Managed LiveKit credentials,
Modal endpoint URLs/tokens and Google OAuth values. The existing Raspberry Pi Tunnel is
locally managed: preserve its current ingress routes, add `monban-api.shionkk.f5.si` to
`http://127.0.0.1:8093`, then point that DNS record to the Pi Tunnel after the local API
health check passes. Keep `/docs` behind Cloudflare Access; leave
`/oauth/google/callback` reachable so Google's browser redirect can complete. The API
callback checks `state` and its HttpOnly cookie.

On a 64-bit Raspberry Pi OS, run:

```sh
docker compose --env-file .env.production -f compose.production.yaml config
docker compose --env-file .env.production -f compose.production.yaml up -d --build
docker compose --env-file .env.production -f compose.production.yaml ps
curl https://$DOOR_PUBLIC_API_HOSTNAME/healthz
```

`/api/status` does not probe on-demand Modal services because that would wake their GPUs.
It reports `inference_mode: "on-demand"` and unknown model readiness until a LiveKit Agent
session prewarms them. The first session after scale-down may wait while models start.

## Model promotion note

This endpoint deploys the exact v20 candidate by tag. Keep the model ID and GGUF hash in the
deployment notes. V20 previously missed the recorded edge-case adoption gate, so verify its
tool outcomes and failure responses in the current Agent flow before presenting it as the
production model. Do not change or overwrite the lab PC's registered Ollama model.
