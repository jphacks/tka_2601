// Existing local Supabase + production device handler, served over a temporary
// loopback HTTP socket. No Docker containers are started or reset.
// SUPABASE_TELEMETRY_DISABLED=1 deno run --frozen --cached-only \
//   --config supabase/functions/device/deno.json --allow-read --allow-env \
//   --allow-run=supabase,docker --allow-net=127.0.0.1,localhost supabase/tests/pusher_http_local.ts
import { createClient } from "@supabase/supabase-js";
import { handleDeviceRequest } from "../functions/device/handler.ts";
import type { PusherConfig } from "../functions/device/contract.ts";
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
const deviceIds = [crypto.randomUUID(), crypto.randomUUID()];
const deviceKeys = [crypto.randomUUID(), crypto.randomUUID()];
const shared: PusherConfig = {
  schema_version: 1,
  enabled_pushers: ["p1"],
  assignments: { call_start: "p1", call_end: "p1" },
};
const swapped: PusherConfig = {
  schema_version: 1,
  enabled_pushers: ["p1", "p2"],
  assignments: { call_start: "p2", call_end: "p1" },
};
const capabilities = {
  schema_versions: [1],
  pushers: [{ id: "p1", gpio: 7 }, { id: "p2", gpio: 8 }],
};
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
  if (remaining.error || remaining.data.length > 0) {
    errors.push(new Error("Local device fixtures remain"));
  }
  if (errors.length) {
    throw new AggregateError(errors, "Local integration test cleanup failed");
  }
  console.log(
    "PASS: temporary HTTP server stopped and all fixture households/users/devices removed",
  );
}

try {
  // Refresh PostgREST's schema after the tested local migration, without restarting it.
  await sql("notify pgrst, 'reload schema';");
  for (let i = 0; i < 2; i++) {
    const email = `pusher-http-${crypto.randomUUID()}@example.test`;
    const password = `Pusher-${crypto.randomUUID()}-9!`;
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
        name: "Pusher HTTP integration fixture",
      }),
    );
    await required(
      admin.from("household_members").insert({
        household_id: householdIds[i],
        user_id: userIds[i],
        role: "owner",
      }),
    );
    await required(
      admin.from("devices").insert({
        id: deviceIds[i],
        household_id: householdIds[i],
        name: "Pusher HTTP integration fixture",
        mode: "normal",
      }),
    );
    const hash = await sha256Hex(deviceKeys[i]);
    await sql(
      `insert into public.device_keys(key_hash,device_id) values ('${hash}','${
        deviceIds[i]
      }');`,
    );
    const loggedIn = await residents[i].auth.signInWithPassword({
      email,
      password,
    });
    if (loggedIn.error) throw new Error("Local resident authentication failed");
  }
  await required(
    admin.from("shop_services").insert(
      Array.from({ length: 100 }, (_, index) => ({
        household_id: householdIds[0],
        name: `${index}-` + "x".repeat(30),
        sort_order: index,
      })),
    ),
  );
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
    path: string,
    index = 0,
    body?: unknown,
    key: string | null = deviceKeys[index],
  ) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "PUT",
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
  const report = (revision: number, config: PusherConfig) => ({
    applied_revision: revision,
    applied_config: config,
    apply_error: null,
    runtime_status: "normal",
    capabilities,
  });
  const read = async (index: number) =>
    await required(
      admin.from("device_pusher_settings").select("*").eq(
        "device_id",
        deviceIds[index],
      ).maybeSingle(),
    );

  check(
    "HTTP settings require a device key",
    (await device("/pusher-settings", 0, undefined, null)).status === 401,
  );
  check(
    "unknown device key is rejected",
    (await device("/pusher-settings", 0, undefined, crypto.randomUUID()))
      .status ===
      401,
  );
  check(
    "anonymous Data API cannot read pusher state",
    (await anon.from("device_pusher_settings").select("*")).error?.code ===
      "42501",
  );
  const foreignSave = await residents[0].rpc("save_pusher_settings", {
    p_device_id: deviceIds[1],
    p_expected_revision: 0,
    p_config: shared,
  });
  check(
    "resident cannot save another household's settings",
    foreignSave.error?.code === "PT403",
  );
  const saved = await residents[0].rpc("save_pusher_settings", {
    p_device_id: deviceIds[0],
    p_expected_revision: 0,
    p_config: shared,
  });
  check(
    "real authenticated app RPC saves one shared pusher",
    !saved.error && saved.data.desired_revision === 1 &&
      saved.data.applied_revision === null,
  );
  const first = await device("/settings");
  check(
    "HTTP GET returns exact desired shared configuration",
    first.status === 200 && first.body.pusher_settings.desired_revision === 1 &&
      same(first.body.pusher_settings.desired_config, shared),
  );
  check(
    "fixture full settings exceed the firmware response buffer",
    first.bytes > 4096,
  );
  const lightweight = await device("/pusher-settings");
  check(
    "dedicated HTTP settings omit large shop and report fields",
    lightweight.status === 200 &&
      same(lightweight.body, {
        contract_version: 1,
        paired: true,
        pusher_settings: { desired_revision: 1, desired_config: shared },
      }) &&
      lightweight.bytes < 512,
  );
  const other = await device("/pusher-settings", 1);
  check(
    "other device GET cannot receive first device settings",
    other.status === 200 && other.body.pusher_settings === null,
  );
  const ack = await device("/pusher-status", 0, {
    ...report(1, shared),
    device_id: deviceIds[1],
  });
  check(
    "HTTP ACK uses authenticated device identity",
    ack.status === 200 && ack.body.applied_revision === 1,
  );
  const stored = await read(0);
  check(
    "real DB readback confirms shared settings and application time",
    stored.applied_revision === 1 && same(stored.applied_config, shared) &&
      typeof stored.applied_at === "string",
  );
  check(
    "body device id cannot create a report for another device",
    await read(1) === null,
  );
  const isolation = await residents[1].from("device_pusher_settings").select(
    "*",
  );
  check(
    "other household cannot read the first device report",
    !isolation.error && isolation.data.length === 0,
  );
  const forged = await residents[0].from("device_pusher_settings").update({
    applied_revision: 99,
  }).eq("device_id", deviceIds[0]);
  check(
    "app cannot forge a device application report",
    forged.error?.code === "42501",
  );
  const swappedSave = await residents[0].rpc("save_pusher_settings", {
    p_device_id: deviceIds[0],
    p_expected_revision: 1,
    p_config: swapped,
  });
  check(
    "real app RPC saves swapped assignment as revision two",
    !swappedSave.error && swappedSave.data.desired_revision === 2 &&
      swappedSave.data.applied_revision === 1,
  );
  const next = await device("/pusher-settings");
  check(
    "HTTP GET receives both swapped physical assignments",
    next.status === 200 && next.body.pusher_settings.desired_revision === 2 &&
      same(next.body.pusher_settings.desired_config, swapped) &&
      next.bytes < 512,
  );
  const nextAck = await device("/pusher-status", 0, report(2, swapped));
  const nextStored = await read(0);
  check(
    "HTTP ACK and DB readback agree on revision-two swapped mapping",
    nextAck.status === 200 && nextStored.applied_revision === 2 &&
      same(nextStored.applied_config, swapped),
  );
  check(
    "HTTP late ACK cannot regress device state",
    (await device("/pusher-status", 0, report(1, shared))).status === 409,
  );
  check(
    "HTTP future ACK is rejected",
    (await device("/pusher-status", 0, report(3, shared))).status === 409,
  );
  check(
    "HTTP same revision with different config is rejected",
    (await device("/pusher-status", 0, report(2, shared))).status === 409,
  );
  const stale = await residents[0].rpc("save_pusher_settings", {
    p_device_id: deviceIds[0],
    p_expected_revision: 1,
    p_config: shared,
  });
  check(
    "real Data API preserves compare-and-swap conflict",
    stale.error?.code === "PT409",
  );
  const otherSave = await residents[1].rpc("save_pusher_settings", {
    p_device_id: deviceIds[1],
    p_expected_revision: 0,
    p_config: shared,
  });
  check(
    "second household can independently save its own pusher",
    !otherSave.error && otherSave.data.desired_revision === 1,
  );
  const foreignAck = await device("/pusher-status", 0, {
    ...report(1, shared),
    device_id: deviceIds[1],
  });
  check(
    "foreign body id cannot redirect an old ACK to another device",
    foreignAck.status === 409 && (await read(1)).applied_revision === null,
  );
  check(
    "second device can report its own actual applied mapping",
    (await device("/pusher-status", 1, report(1, shared))).status === 200 &&
      (await read(1)).applied_revision === 1,
  );
  check(
    "production HTTP handler completed without unexpected errors",
    handlerErrors.length === 0,
  );
  console.log(`PASS: ${checks} real HTTP/Auth/Data API/DB checks`);
} finally {
  await cleanup();
}
