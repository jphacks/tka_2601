# Communication error-handling audit — 2026-10-19

Baseline: `d5f10f2` (`origin/main` at audit start). This is a source audit and local regression check, not proof of deployed provider or physical-device behavior. Counting `catch` statements would not establish coverage; the inventory below follows communication boundaries instead.

## Existing coverage and refactor

| Boundary | Existing handling | Change in this PR |
| --- | --- | --- |
| Mobile → Supabase DB/RPC | `mobile/src/lib/api.ts` checks query/RPC errors and propagates them; screens generally catch them and reset busy state | Shared presentation moved from native auth actions to pure `lib/errors.ts`; ordered translations and cancellation suppression retained |
| Mobile → auth providers | Auth failures propagate; explicit cancellation is silent; OAuth callback errors checked | Safe native error-code inspection, preserving the original rejection for null/undefined instead of throwing during property access |
| Mobile → Expo push registration | Registration failure is logged; sign-out token removal is best effort | Audited, unchanged |
| Device → Supabase Edge → RPC | Bearer validation; malformed JSON/body checks; known visit SQL errors map to 400/403/409; unknown errors propagate to middleware | Extracted request handler and centralized all nine existing SQLSTATE mappings; request-level tests preserve responses and RPC arguments |
| Supabase push → Expo | Network, 429 and 5xx retry with existing delays; permanent errors stop; delivery outcomes persisted by RPC | Discriminated attempt result separates classification from retry control; retry count, delays and messages retained |
| E84 → backend relay → LiveKit/model services | Start/conversation deadlines, validation, error frames, close codes, task cancellation; v2 handles unexpected processing errors | Fifteen existing relay error codes centralized as `StrEnum`; validation branches clarified with original evaluation order |
| Backend → device settings/history API | HTTP timeouts, status checks, network/parse failure logging and fallback | Audited, unchanged |
| E84 ↔ M5 TCP / backend WebSocket | Partial bytes retained, transient socket backpressure tolerated, send/partial-receive deadlines, EOF/protocol rejection and connection cleanup | Named internal receive outcomes and one shared transient-error predicate; public integer result contract unchanged |
| M5 receiver / device Wi-Fi | Nonblocking sends, packet validation, idle/progress deadlines, disconnect cleanup and bounded reconnect scheduling | Audited, unchanged; host receiver and servo safety regressions run |

Implementation entry points: `mobile/src/lib/{api,auth,authActions,push,errors}.ts*`, `supabase/functions/{device,push}/`, `backend/voice-agent/door_backend/{relay,relay_v2,api,supabase_history}.py`, `PSOC_Edge_E84/source/{voice_transport,voice_stream,wifi_reconnect,m5_link}.c`, and `M5Stack_Basic_E84_Link/stream_receiver.cpp`. Legacy upload implementations were inspected for timeout/error returns but were not refactored.

## Remaining gaps requiring separate behavior decisions

- `mobile/src/lib/auth.tsx`: session bootstrap has no rejection handler; membership lookup failure becomes `household = null`, indistinguishable from no membership.
- `mobile/src/app/join.tsx`: invite lookup failure becomes “invite not found.” Distinguishing network failure would change screen states.
- `mobile/src/lib/authActions.ts`: Apple profile-name update does not inspect its returned error. Push-token removal during sign-out remains best effort.
- `supabase/functions/push/index.ts`: malformed webhook JSON/shapes rely on outer failure handling rather than explicit validation responses.
- `supabase/functions/push/expo.ts`: no explicit fetch deadline; ticket array members are not individually schema-validated. Adding either changes failure/retry behavior.
- `backend/voice-agent/door_backend/relay.py`: unexpected v1 streaming failures may escape without an error frame; failure in `link.aclose()` can prevent subsequent room deletion.
- `backend/voice-agent/door_backend/api.py`: malformed model-health response shapes can raise `AttributeError`, outside the existing exception list.

These are findings, not newly implemented recovery policies. No new retries, timeout values, response messages, schemas, auth rules, or device actions are introduced.

## Validation

- Backend: **124 tests passed**; two existing short JWT fixture-key warnings.
- Edge Functions: **25 tests passed**; `deno check` passes both device and push entrypoints.
- Mobile: **6 tests passed** (`npm test`, Node 22.22.3); TypeScript check passed. Changed error/auth modules and tests pass ESLint.
- Full mobile lint remains blocked by baseline findings: `auth.tsx:50` (`react-hooks/set-state-in-effect`) and an unused `View` warning in `settings/instructions.tsx:3`. Both were reproduced on an `origin/main` archive with the same temporary Expo ESLint setup. The repository lacks committed ESLint setup; no lint dependencies/configuration were added to this PR.
- E84: **72 tests run, 71 passed, 1 skipped** using the backend virtualenv (the optional full-source WAV is absent). Transport harness passes **4,901 checks per configuration**, paired and unpaired, with address/undefined-behavior sanitizers.
- M5: `bash M5Stack_Basic_E84_Link/tests/run.sh` passed all protocol, receiver, calibration, timing, servo release, manual/disabled and invalid-configuration cases with sanitizers.
- No live Supabase/Expo/LiveKit requests, mobile device session, firmware flashing, or physical intercom/servo operation was used as evidence.
