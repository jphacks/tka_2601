// Existing local Supabase + production device handler, served over a temporary
// loopback HTTP socket. No Docker containers are started or reset.
// Chime enrollment contract (Issue #61): app RPC -> device GET -> device PUT -> app readback.
// SUPABASE_TELEMETRY_DISABLED=1 deno run --frozen --cached-only \
//   --config supabase/functions/device/deno.json --allow-read --allow-env \
//   --allow-run=supabase,docker --allow-net=127.0.0.1,localhost supabase/tests/chime_http_local.ts
import { createClient } from "@supabase/supabase-js";
import { handleDeviceRequest } from "../functions/device/handler.ts";
import { localStatus, sha256Hex } from "../scripts/local.ts";

const status = await localStatus();
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(status.API_URL)) {
  throw new Error(
    "This integration test accepts only an existing local Supabase instance",
  );
}
const options = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};
const admin = createClient(status.API_URL, status.SECRET_KEY, options);
const anon = createClient(status.API_URL, status.PUBLISHABLE_KEY, options);
const residents = [0, 1].map(() =>
  createClient(status.API_URL, status.PUBLISHABLE_KEY, options)
);
const userIds: string[] = [];
const householdIds = [crypto.randomUUID(), crypto.randomUUID()];
// index 0 and 1 are paired devices of household 0 and 1; index 2 is unpaired
const deviceIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const deviceKeys = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
let checks = 0;
let server: Deno.HttpServer<Deno.NetAddr> | undefined;

function check(name: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  checks++;
  console.log(`PASS: ${name}`);
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => same(left[key], right[key]));
}
async function sql(query: string) {
  const process = new Deno.Command("docker", {
    args: [
      "exec",
      "-i",
      "supabase_db_tka_2601",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(query));
  await writer.close();
  const output = await process.output();
  if (output.code !== 0) throw new Error("Local SQL setup/cleanup failed");
}
async function required<T>(
  operation: PromiseLike<{ data: T; error: unknown }>,
): Promise<T> {
  const { data, error } = await operation;
  if (error) throw new Error("Local Supabase fixture operation failed");
  return data;
}

async function cleanup() {
  const errors: Error[] = [];
  if (server) {
    try {
      await server.shutdown();
    } catch {
      errors.push(new Error("Temporary HTTP server shutdown failed"));
    }
  }
  const households = await admin.from("households").delete().in(
    "id",
    householdIds,
  );
  if (households.error) {
    errors.push(new Error("Local household fixture cleanup failed"));
  }
  const devices = await admin.from("devices").delete().in("id", deviceIds);
  if (devices.error) errors.push(new Error("Local device fixture cleanup failed"));
  for (const user of userIds) {
    const result = await admin.auth.admin.deleteUser(user);
    if (result.error) {
      errors.push(new Error("Local Auth fixture cleanup failed"));
    }
  }
  const remaining = await admin.from("devices").select("id").in(
    "id",
    deviceIds,
  );
  const leftovers = await admin.from("device_chime_enrollment").select(
    "device_id",
  ).in("device_id", deviceIds);
  if (
    remaining.error || remaining.data.length > 0 || leftovers.error ||
    leftovers.data.length > 0
  ) {
    errors.push(new Error("Local device or enrollment fixtures remain"));
  }
  if (errors.length) {
    throw new AggregateError(errors, "Local integration test cleanup failed");
  }
  console.log(
    "PASS: temporary HTTP server stopped and all fixture households/users/devices/enrollment rows removed",
  );
}

try {
  // Refresh PostgREST's schema after the tested local migration, without restarting it.
  await sql("notify pgrst, 'reload schema';");
  for (let i = 0; i < 2; i++) {
    const email = `chime-http-${crypto.randomUUID()}@example.test`;
    const password = `Chime-${crypto.randomUUID()}-9!`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error || !created.data.user) {
      throw new Error("Local Auth fixture creation failed");
    }
    userIds.push(created.data.user.id);
    await required(
      admin.from("households").insert({
        id: householdIds[i],
        name: "Chime HTTP integration fixture",
      }),
    );
    await required(
      admin.from("household_members").insert({
        household_id: householdIds[i],
        user_id: userIds[i],
        role: "owner",
      }),
    );
    const loggedIn = await residents[i].auth.signInWithPassword({
      email,
      password,
    });
    if (loggedIn.error) throw new Error("Local resident authentication failed");
  }
  for (let i = 0; i < 3; i++) {
    await required(
      admin.from("devices").insert({
        id: deviceIds[i],
        household_id: i < 2 ? householdIds[i] : null,
        name: "Chime HTTP integration fixture",
        mode: "normal",
      }),
    );
    const hash = await sha256Hex(deviceKeys[i]);
    await sql(
      `insert into public.device_keys(key_hash,device_id) values ('${hash}','${
        deviceIds[i]
      }');`,
    );
  }
  const handlerErrors: unknown[] = [];
  server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      try {
        return await handleDeviceRequest(req, admin);
      } catch (error) {
        handlerErrors.push(error);
        return Response.json({ error: "handler failure" }, { status: 500 });
      }
    },
  );
  const base = `http://127.0.0.1:${server.addr.port}/functions/v1/device`;
  const device = async (
    method: string,
    path: string,
    index = 0,
    body?: unknown,
    key: string | null = deviceKeys[index],
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: JSON.parse(text),
      bytes: new TextEncoder().encode(text).length,
    };
  };
  const get = (index = 0) => device("GET", "/chime-enrollment", index);
  const put = (body: unknown, index = 0) =>
    device("PUT", "/chime-enrollment-status", index, body);
  const report = (
    handled_seq: number,
    phase: string,
    reason: string | null = null,
    registered = false,
  ) => ({ handled_seq, phase, reason, registered });
  const request = (index: number, deviceIndex: number, action: string) =>
    residents[index].rpc("request_chime_enrollment", {
      p_device_id: deviceIds[deviceIndex],
      p_action: action,
    });
  const read = async (index: number) =>
    await required(
      admin.from("device_chime_enrollment").select("*").eq(
        "device_id",
        deviceIds[index],
      ).maybeSingle(),
    );

  // Authentication and the empty state
  check(
    "HTTP chime GET requires a device key",
    (await device("GET", "/chime-enrollment", 0, undefined, null)).status ===
      401,
  );
  check(
    "HTTP chime PUT requires a device key",
    (await device("PUT", "/chime-enrollment-status", 0, report(0, "idle"), null))
      .status === 401,
  );
  check(
    "unknown device key is rejected",
    (await device("GET", "/chime-enrollment", 0, undefined, crypto.randomUUID()))
      .status === 401,
  );
  const empty = await get();
  check(
    "before any request the device reads request_seq 0 and no action",
    empty.status === 200 &&
      same(empty.body, {
        contract_version: 1,
        paired: true,
        request_seq: 0,
        action: null,
      }),
  );
  check("empty GET creates no row", await read(0) === null);
  const unpaired = await get(2);
  check(
    "an unpaired device reads an empty request with paired false",
    unpaired.status === 200 &&
      same(unpaired.body, {
        contract_version: 1,
        paired: false,
        request_seq: 0,
        action: null,
      }),
  );
  check(
    "an unpaired device cannot report (409) and creates no row",
    (await put(report(0, "idle"), 2)).status === 409 && await read(2) === null,
  );

  // Boot report before any app request, then an impossible one
  const boot = await put(report(0, "idle", null, true));
  check(
    "boot report at sequence 0 creates the row with registered true",
    boot.status === 200 && boot.body.request_seq === 0 &&
      boot.body.handled_seq === 0 && boot.body.registered === true,
  );
  check(
    "report for a request the app never made is rejected (409)",
    (await put(report(1, "noise", null, true))).status === 409,
  );

  // Data API boundaries before the first request
  check(
    "anonymous Data API cannot read chime enrollment",
    (await anon.from("device_chime_enrollment").select("*")).error?.code ===
      "42501",
  );
  const foreign = await request(1, 0, "start");
  check(
    "resident cannot request on another household's device (PT404)",
    foreign.error?.code === "PT404",
  );
  const unclaimed = await request(0, 2, "start");
  check(
    "resident cannot request on an unclaimed device (PT409)",
    unclaimed.error?.code === "PT409",
  );
  const badAction = await request(0, 0, "stop");
  check(
    "invalid action is rejected (22023) and the sequence does not move",
    badAction.error?.code === "22023" && (await read(0)).request_seq === 0,
  );

  // Start request -> device GET -> progress -> app readback
  const started = await request(0, 0, "start");
  check(
    "resident start request returns request_seq 1",
    !started.error && started.data === 1,
  );
  const first = await get();
  check(
    "device GET returns exactly the desired side for request 1",
    first.status === 200 &&
      same(first.body, {
        contract_version: 1,
        paired: true,
        request_seq: 1,
        action: "start",
      }) && first.bytes < 256,
  );
  const idleView = await required(
    residents[0].from("device_chime_enrollment").select("*").eq(
      "device_id",
      deviceIds[0],
    ).single(),
  );
  check(
    "app readback right after a request shows idle with the previous registered kept",
    idleView.request_seq === 1 && idleView.action === "start" &&
      idleView.handled_seq === 0 && idleView.phase === "idle" &&
      idleView.reason === null && idleView.registered === true,
  );
  for (const phase of ["noise", "listen", "analyze", "saving"]) {
    const response = await put(report(1, phase, null, true));
    const view = await required(
      residents[0].from("device_chime_enrollment").select("phase,handled_seq")
        .eq("device_id", deviceIds[0]).single(),
    );
    check(
      `device reports ${phase}; the resident reads it`,
      response.status === 200 && response.body.phase === phase &&
        view.phase === phase && view.handled_seq === 1,
    );
  }
  const done = await put({ ...report(1, "done", null, true) });
  const doneRow = await read(0);
  check(
    "done report stores registered true, stamps reported_at and keeps the request",
    done.status === 200 && doneRow.phase === "done" &&
      doneRow.registered === true && doneRow.request_seq === 1 &&
      doneRow.action === "start" && typeof doneRow.reported_at === "string",
  );
  check(
    "repeating the same report is idempotent",
    (await put(report(1, "done", null, true))).status === 200,
  );

  // Isolation
  const hidden = await residents[1].from("device_chime_enrollment").select("*");
  check(
    "other household cannot read the first device row",
    !hidden.error && hidden.data.length === 0,
  );
  const forged = await residents[0].from("device_chime_enrollment").update({
    phase: "done",
    handled_seq: 1,
  }).eq("device_id", deviceIds[0]);
  check("app cannot forge a device report", forged.error?.code === "42501");
  const forgedRequest = await residents[0].from("device_chime_enrollment")
    .update({ request_seq: 50 }).eq("device_id", deviceIds[0]);
  check("app cannot assign request_seq directly", forgedRequest.error?.code === "42501");
  const forgedInsert = await residents[1].from("device_chime_enrollment").insert({
    device_id: deviceIds[1],
  });
  check("app cannot insert a row directly", forgedInsert.error?.code === "42501");
  const forgedDelete = await residents[0].from("device_chime_enrollment")
    .delete().eq("device_id", deviceIds[0]);
  check(
    "app cannot delete a row directly",
    forgedDelete.error?.code === "42501" && await read(0) !== null,
  );
  const appCallsDevice = await residents[0].rpc("device_report_chime_enrollment", {
    p_device_id: deviceIds[0],
    p_handled_seq: 1,
    p_phase: "done",
    p_reason: null,
    p_registered: true,
  });
  check(
    "app cannot call the device report RPC",
    appCallsDevice.error?.code === "42501",
  );
  check(
    "body device_id cannot redirect a report (strict body, 400) and the other device stays untouched",
    (await put({ ...report(1, "done", null, true), device_id: deviceIds[1] }))
      .status === 400 && await read(1) === null,
  );
  check(
    "the other device reports only its own row",
    (await put(report(0, "idle"), 1)).status === 200 &&
      (await read(1)).request_seq === 0 && (await read(0)).phase === "done",
  );

  // Cancel request resets the progress but not registered
  const cancel = await request(0, 0, "cancel");
  check("resident cancel request returns request_seq 2", !cancel.error && cancel.data === 2);
  const afterCancel = await get();
  check(
    "device GET now returns the cancel action",
    same(afterCancel.body, {
      contract_version: 1,
      paired: true,
      request_seq: 2,
      action: "cancel",
    }),
  );
  const reset = await read(0);
  check(
    "a new request resets phase to idle and reason to null but keeps handled_seq and registered",
    reset.phase === "idle" && reset.reason === null && reset.handled_seq === 1 &&
      reset.registered === true,
  );

  // Sequence conflicts
  check(
    "skipping ahead of request_seq is rejected (409)",
    (await put(report(3, "cancelled"))).status === 409,
  );
  check(
    "going back below handled_seq is rejected (409)",
    (await put(report(0, "idle"))).status === 409,
  );
  check(
    "rejected reports leave the row unchanged",
    (await read(0)).phase === "idle" && (await read(0)).handled_seq === 1,
  );
  const cancelled = await put(report(2, "cancelled", null, true));
  check(
    "cancel is acknowledged at handled_seq 2",
    cancelled.status === 200 && cancelled.body.handled_seq === 2 &&
      cancelled.body.phase === "cancelled",
  );
  check(
    "a report for the previous request is now behind handled_seq (409)",
    (await put(report(1, "done", null, true))).status === 409,
  );

  // Failure with a reason, then a retry after a new start request
  const restart = await request(0, 0, "start");
  check("a fresh start request returns request_seq 3", restart.data === 3);
  const failed = await put(report(3, "failed", "too_noisy", true));
  const failedView = await required(
    residents[0].from("device_chime_enrollment").select("phase,reason").eq(
      "device_id",
      deviceIds[0],
    ).single(),
  );
  check(
    "failed carries the reason to the resident",
    failed.status === 200 && failedView.phase === "failed" &&
      failedView.reason === "too_noisy",
  );
  check(
    "a new request clears the failure reason",
    !(await request(0, 0, "start")).error && (await read(0)).reason === null &&
      (await read(0)).phase === "idle",
  );

  // Strict body validation over HTTP
  for (
    const [name, body] of [
      ["unknown phase", report(4, "running")],
      ["reason without failed", report(4, "done", "busy")],
      ["unknown reason", report(4, "failed", "broken")],
      ["string registered", { ...report(4, "done"), registered: "true" }],
      ["missing registered", { handled_seq: 4, phase: "done", reason: null }],
      ["fractional handled_seq", report(4.5, "done")],
      ["negative handled_seq", report(-1, "done")],
    ] as const
  ) {
    check(`invalid report is rejected (400): ${name}`, (await put(body)).status === 400);
  }
  check(
    "invalid reports changed nothing",
    (await read(0)).handled_seq === 3 && (await read(0)).request_seq === 4,
  );
  check(
    "production HTTP handler completed without unexpected errors",
    handlerErrors.length === 0,
  );
  console.log(`PASS: ${checks} real HTTP/Auth/Data API/DB checks`);
} finally {
  await cleanup();
}
