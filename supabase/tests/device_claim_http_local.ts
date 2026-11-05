// Real local Auth + PostgREST + claim_device + RLS verification.
// Reuses the running tka_2601 stack; never starts/resets it. Only this run's
// randomly named fixtures are removed. No API keys, JWTs or device keys are logged.
// From the repository root:
// deno run --cached-only --allow-env --allow-run --allow-net=127.0.0.1:56421 \
//   supabase/tests/device_claim_http_local.ts
// Browser QA: add --allow-read=/private/tmp/monban-pairing-browser.json and
// --allow-write=/private/tmp/monban-pairing-browser.json before the script path.
// Then append --browser-fixture, claim via the real UI, --seed-browser-visits,
// and finally --cleanup-browser-fixture. These modes never print credentials.
import { parseEnv, sha256Hex } from "../scripts/local.ts";

const runPrefix = `claim-http-${crypto.randomUUID()}`;
const userIds: string[] = [];
const householdIds: string[] = [];
const deviceIds: string[] = [];
let checks = 0;

function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`FAILED: ${name}`);
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

const cli = Deno.env.get("TEST_SUPABASE_CLI") ?? "supabase";
const statusProcess = await new Deno.Command(cli, {
  args: ["status", "-o", "env"], stdout: "piped", stderr: "piped",
}).output();
if (statusProcess.code !== 0) throw new Error("Local Supabase status failed; no fixtures created");
const status = parseEnv(new TextDecoder().decode(statusProcess.stdout));
const api = status.API_URL;
// Restrict this executable to the already-running local stack.
if (api !== "http://127.0.0.1:56421") throw new Error("Expected existing local API on 127.0.0.1:56421");
const publicKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const adminKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
if (!publicKey || !adminKey) throw new Error("Local API keys are unavailable");

type Result = { status: number; body: any };
async function http(path: string, method = "GET", body?: unknown, token?: string, admin = false): Promise<Result> {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      apikey: admin ? adminKey : publicKey,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(admin ? { authorization: `Bearer ${adminKey}` } : {}),
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const rpc = (name: string, body: unknown, token?: string) => http(`/rest/v1/rpc/${name}`, "POST", body, token);
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function sql<T>(query: string): Promise<T[]> {
  const process = new Deno.Command("docker", {
    args: ["exec", "-i", "supabase_db_tka_2601", "psql", "-U", "postgres", "-d", "postgres", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1"],
    stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(query));
  await writer.close();
  const result = await process.output();
  if (result.code !== 0) throw new Error("Fixture SQL failed; query and credentials omitted");
  const output = new TextDecoder().decode(result.stdout).trim();
  return output ? JSON.parse(output) : [];
}

type User = { id: string; token: string; email: string; password: string };
// Await all fixture creations even if one fails, so finally can remove every
// successfully created row; fail-fast Promise.all can race its own cleanup.
async function settled<T>(jobs: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(jobs);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

async function user(suffix: string): Promise<User> {
  const email = `${runPrefix}-${suffix}@example.com`;
  const password = `Pair-${crypto.randomUUID()}!`;
  const created = await http("/auth/v1/admin/users", "POST", { email, password, email_confirm: true }, undefined, true);
  if (created.status !== 200 && created.status !== 201) throw new Error(`Fixture Auth create failed (${created.status})`);
  const id = created.body.id as string;
  userIds.push(id);
  const login = await http("/auth/v1/token?grant_type=password", "POST", { email, password });
  if (login.status !== 200 || typeof login.body.access_token !== "string") throw new Error(`Fixture Auth login failed (${login.status})`);
  return { id, token: login.body.access_token, email, password };
}

async function household(owner: User, suffix: string): Promise<string> {
  const result = await rpc("create_household", { name: `${runPrefix}-${suffix}` }, owner.token);
  if (result.status !== 200 || typeof result.body !== "string") throw new Error(`Fixture household failed (${result.status})`);
  householdIds.push(result.body);
  return result.body;
}

async function registered(suffix: string): Promise<{ device_id: string; pairing_code: string }> {
  const keyHash = await sha256Hex(`dk_${crypto.randomUUID()}`);
  const rows = await sql<{ device_id: string; pairing_code: string }>(
    `select coalesce(json_agg(t),'[]') from private.register_device(${quote(`${runPrefix}-${suffix}`)},${quote(keyHash)}) t;`,
  );
  if (rows.length !== 1) throw new Error("Fixture registration failed");
  deviceIds.push(rows[0].device_id);
  return rows[0];
}

const devicePath = (id: string, select = "id,household_id,mode") => `/rest/v1/devices?id=eq.${id}&select=${select}`;
async function ownerOf(id: string): Promise<string | null> {
  const rows = await sql<{ household_id: string | null }>(`select coalesce(json_agg(t),'[]') from (select household_id from public.devices where id=${quote(id)}::uuid) t;`);
  return rows[0]?.household_id ?? null;
}

// Optional browser QA lifecycle. The file is private, outside the repository,
// and contains only this explicitly requested disposable local test account.
const browserFixturePath = "/private/tmp/monban-pairing-browser.json";
type BrowserFixture = {
  runPrefix: string; email: string; password: string; userId: string;
  householdId: string; deviceId: string; pairingCode: string; visitIds: string[];
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readBrowserFixture(): Promise<BrowserFixture> {
  const fixture = JSON.parse(await Deno.readTextFile(browserFixturePath)) as BrowserFixture;
  if (!/^claim-http-[0-9a-f-]{36}$/.test(fixture.runPrefix) ||
    fixture.email !== `${fixture.runPrefix}-browser@example.com` ||
    ![fixture.userId, fixture.householdId, fixture.deviceId, ...fixture.visitIds].every((id) => uuidPattern.test(id))) {
    throw new Error("Browser fixture identifiers are invalid; no data changed");
  }
  // Never trust an edited temporary file to authorize deleting another account.
  const identity = await http(`/auth/v1/admin/users/${fixture.userId}`, "GET", undefined, undefined, true);
  if (identity.status !== 200 || identity.body.email !== fixture.email) throw new Error("Browser fixture owner does not match");
  const rows = await sql<{ count: number }>(`select json_build_array(json_build_object('count',count(*))) from public.households where id=${quote(fixture.householdId)}::uuid and name=${quote(`${fixture.runPrefix}-browser`)};`);
  if (rows[0].count !== 1) throw new Error("Browser fixture household does not match");
  return fixture;
}

async function saveBrowserFixture(fixture: BrowserFixture, createNew = false): Promise<void> {
  await Deno.writeTextFile(browserFixturePath, JSON.stringify(fixture, null, 2), { createNew, mode: 0o600 });
  await Deno.chmod(browserFixturePath, 0o600);
}

async function browserMode(mode: string): Promise<void> {
  if (mode === "--browser-fixture") {
    try {
      await Deno.stat(browserFixturePath);
      throw new Error("Browser fixture file already exists; clean it up before creating another");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    try {
      const account = await user("browser");
      const group = await household(account, "browser");
      const device = await registered("browser-device");
      await saveBrowserFixture({
        runPrefix, email: account.email, password: account.password, userId: account.id,
        householdId: group, deviceId: device.device_id, pairingCode: device.pairing_code,
        visitIds: [],
      }, true);
      console.log(`Browser fixture: ${browserFixturePath} (1 user, 1 empty household, 1 unclaimed device; mode 0600)`);
    } catch (error) {
      await cleanupFixtures();
      throw error;
    }
    return;
  }

  const fixture = await readBrowserFixture();
  if (mode === "--cleanup-browser-fixture") {
    // IDs are exactly those in the validated private fixture; names/prefix are
    // checked again by cleanupFixtures. Visit rows cascade from device/group.
    userIds.push(fixture.userId);
    householdIds.push(fixture.householdId);
    deviceIds.push(fixture.deviceId);
    await cleanupFixtures(fixture.runPrefix);
    await Deno.remove(browserFixturePath);
    console.log(`Removed browser fixture and ${browserFixturePath}`);
    return;
  }

  if (await ownerOf(fixture.deviceId) !== fixture.householdId) throw new Error("Claim the device in the actual UI before seeding visits");
  if (fixture.visitIds.length === 0) {
    fixture.visitIds = [crypto.randomUUID(), crypto.randomUUID()];
    await saveBrowserFixture(fixture);
  }
  const now = Date.now();
  const visit = (offset: number) => ({
    chimed_at: new Date(now - offset - 60_000).toISOString(),
    answered_at: new Date(now - offset - 55_000).toISOString(),
    ended_at: new Date(now - offset).toISOString(),
    mode: "normal", status: "ended", intent: "delivery", company: "Browser QA fixture",
    outcome: "leave_at_door", end_reason: "closing",
  });
  const messages = [
    "Browser QA visitor message. ".repeat(24),
    "Browser QA assistant reply. ".repeat(20),
    "Browser QA second visitor turn. ".repeat(24),
    "Browser QA second assistant turn. ".repeat(20),
    "Browser QA third visitor turn. ".repeat(24),
    "Browser QA final assistant reply. ".repeat(20),
  ].map((text, index) => ({ seq: index + 1, speaker: index % 2 ? "ai" : "visitor", text, spoken_at: new Date(now - 50_000 + index * 5000).toISOString() }));
  await sql(`begin;
    do $fixture$ begin
      perform public.device_put_visit(${quote(fixture.deviceId)}::uuid,${quote(fixture.visitIds[0])}::uuid,${quote(JSON.stringify(visit(0)))}::jsonb,${quote(JSON.stringify(messages))}::jsonb);
      perform public.device_put_visit(${quote(fixture.deviceId)}::uuid,${quote(fixture.visitIds[1])}::uuid,${quote(JSON.stringify(visit(300_000)))}::jsonb,'[]'::jsonb);
    end $fixture$;
    commit;`);
  console.log(`Seeded 2 real local visits (6 long messages, 1 empty conversation); IDs are in ${browserFixturePath}`);
}

const browserModes = ["--browser-fixture", "--seed-browser-visits", "--cleanup-browser-fixture"];
const requestedBrowserMode = Deno.args.find((arg) => browserModes.includes(arg));
if (requestedBrowserMode) {
  await browserMode(requestedBrowserMode);
  Deno.exit(0);
}

try {
  const [a, b, c, d, e, noGroup, member] = await settled([
    user("a"), user("b"), user("c"), user("d"), user("e"), user("no-group"), user("member"),
  ]);
  const [ha, hb, hc, hd, he] = await settled([
    household(a, "a"), household(b, "b"), household(c, "c"), household(d, "d"), household(e, "e"),
  ]);
  const invite = await rpc("get_or_create_household_invite", {}, a.token);
  check("owner can create an invite", invite.status === 200 && typeof invite.body === "string");
  const joined = await rpc("accept_household_invite", { token: invite.body }, member.token);
  check("ordinary member joins the first household", joined.status === 200 && joined.body === ha);

  const first = await registered("first");
  const unauth = await rpc("claim_device", { code: first.pairing_code });
  check("anonymous claim is rejected without consuming the code", unauth.status === 401 && unauth.body.code === "42501");
  const adminClaim = await http("/rest/v1/rpc/claim_device", "POST", { code: first.pairing_code }, undefined, true);
  check("service role cannot use the resident claim RPC", adminClaim.status === 403 && adminClaim.body.code === "42501");
  const withoutGroup = await rpc("claim_device", { code: first.pairing_code }, noGroup.token);
  check("authenticated user without household receives PT403", withoutGroup.status === 403 && withoutGroup.body.code === "PT403");
  for (const code of ["not-a-code", "", "!@", null]) {
    const invalid = await rpc("claim_device", { code }, a.token);
    check(`invalid code ${checks} receives PT404`, invalid.status === 404 && invalid.body.code === "PT404");
  }
  const unseen = await http(devicePath(first.device_id), "GET", undefined, a.token);
  check("unpaired device is invisible under resident RLS", unseen.status === 200 && unseen.body.length === 0);
  for (const token of [undefined, a.token]) {
    const codes = await http("/rest/v1/device_pairing_codes?select=code", "GET", undefined, token);
    check("pairing code table is not readable through Data API", [401, 403].includes(codes.status) && codes.body.code === "42501");
  }
  const registrationRpc = await rpc("register_device", { p_name: `${runPrefix}-not-created`, p_key_hash: "0".repeat(64) }, a.token);
  check("administrator registration is not exposed as a public RPC", registrationRpc.status === 404 && registrationRpc.body.code === "PGRST202");

  const prettyCode = ` ${first.pairing_code.slice(0, 4).toLowerCase()} - ${first.pairing_code.slice(4).toLowerCase()} `;
  const claimed = await rpc("claim_device", { code: prettyCode }, a.token);
  check("lowercase, spaces and hyphen claim succeeds", claimed.status === 200 && claimed.body === first.device_id);
  check("claim persists the actual household association", await ownerOf(first.device_id) === ha);
  const owned = await http(devicePath(first.device_id), "GET", undefined, member.token);
  check("same-household member can read the paired device", owned.status === 200 && owned.body[0]?.id === first.device_id);
  const foreign = await http(devicePath(first.device_id), "GET", undefined, b.token);
  check("other household cannot read the paired device", foreign.status === 200 && foreign.body.length === 0);
  const sameGroupReplay = await rpc("claim_device", { code: first.pairing_code }, a.token);
  check("used code still returns PT404 for the already-paired household", sameGroupReplay.status === 404 && sameGroupReplay.body.code === "PT404");
  const otherGroupReplay = await rpc("claim_device", { code: first.pairing_code }, b.token);
  check("used code cannot be replayed by another household", otherGroupReplay.status === 404 && otherGroupReplay.body.code === "PT404");
  const foreignUpdate = await http(devicePath(first.device_id), "PATCH", { mode: "away" }, b.token);
  check("other household update affects no device", foreignUpdate.status === 200 && foreignUpdate.body.length === 0);
  const move = await http(devicePath(first.device_id), "PATCH", { household_id: hb }, a.token);
  check("resident cannot directly overwrite household ownership", move.status === 403 && move.body.code === "42501" && await ownerOf(first.device_id) === ha);
  const keys = await http("/rest/v1/device_keys?select=*", "GET", undefined, a.token);
  check("resident cannot read the device authentication key table", keys.status === 403 && keys.body.code === "42501");

  const raced = await registered("race");
  const attempts = await Promise.all([rpc("claim_device", { code: raced.pairing_code }, b.token), rpc("claim_device", { code: raced.pairing_code }, c.token)]);
  check("simultaneous cross-household claims have exactly one winner", attempts.filter((r) => r.status === 200 && r.body === raced.device_id).length === 1 && attempts.filter((r) => r.status === 404 && r.body.code === "PT404").length === 1);
  const winnerHousehold = attempts[0].status === 200 ? hb : hc;
  const emptyHousehold = attempts[0].status === 200 ? hc : hb;
  const emptyUser = attempts[0].status === 200 ? c : b;
  check("concurrent claim persists the winner without later overwrite", await ownerOf(raced.device_id) === winnerHousehold);

  // Legacy/inconsistent administrative state: a code exists for an already-owned
  // device. A failed claim must roll back its DELETE and preserve its real owner.
  await sql(`insert into public.device_pairing_codes(code,device_id) values(${quote(first.pairing_code)},${quote(first.device_id)}::uuid);`);
  const alreadyOwned = await rpc("claim_device", { code: first.pairing_code }, d.token);
  check("lingering code cannot transfer an already-owned device", alreadyOwned.status === 409 && alreadyOwned.body.code === "23505" && await ownerOf(first.device_id) === ha);
  const remaining = await sql<{ count: number }>(`select json_build_array(json_build_object('count',count(*))) from public.device_pairing_codes where device_id=${quote(first.device_id)}::uuid;`);
  check("failed ownership transfer rolls back code consumption", remaining[0].count === 1);

  const extra = await registered("extra");
  const second = await rpc("claim_device", { code: extra.pairing_code }, member.token);
  check("ordinary member cannot add a second device to an already-paired household", second.status === 409 && second.body.code === "PT409" && await ownerOf(extra.device_id) === null);
  const firstStillOwned = await http(devicePath(first.device_id), "GET", undefined, a.token);
  check("second-device rejection preserves the existing paired device", firstStillOwned.status === 200 && firstStillOwned.body[0]?.household_id === ha);
  const reused = await rpc("claim_device", { code: extra.pairing_code }, d.token);
  check("second-device rejection preserves the code for an empty household", reused.status === 200 && reused.body === extra.device_id && await ownerOf(extra.device_id) === hd);

  const [one, two] = await settled([registered("same-household-one"), registered("same-household-two")]);
  const sameHousehold = await Promise.all([
    rpc("claim_device", { code: one.pairing_code }, emptyUser.token),
    rpc("claim_device", { code: two.pairing_code }, emptyUser.token),
  ]);
  check("simultaneous distinct-code claims in one household have one success and one PT409", sameHousehold.filter((r) => r.status === 200).length === 1 && sameHousehold.filter((r) => r.status === 409 && r.body.code === "PT409").length === 1);
  const winner = sameHousehold[0].status === 200 ? one : two;
  const loser = sameHousehold[0].status === 200 ? two : one;
  check("same-household race pairs only its winner", await ownerOf(winner.device_id) === emptyHousehold && await ownerOf(loser.device_id) === null);
  const lostCode = await rpc("claim_device", { code: loser.pairing_code }, e.token);
  check("losing concurrent code remains usable by another empty household", lostCode.status === 200 && lostCode.body === loser.device_id && await ownerOf(loser.device_id) === he);

  const counts = await sql<{ count: number }>(`select json_build_array(json_build_object('count',count(*))) from public.devices where household_id=${quote(emptyHousehold)}::uuid;`);
  check("database contains exactly one device for the raced household", counts[0].count === 1);
  console.log(`PASS: ${checks} real local HTTP/Auth/RPC/RLS checks; cleanup follows`);
} finally {
  await cleanupFixtures();
}

async function cleanupFixtures(prefix = runPrefix): Promise<void> {
  const cleanupErrors: string[] = [];
  if (deviceIds.length > 0) {
    try {
      // Visits reference devices without ON DELETE CASCADE, so remove only this
      // fixture's exact visit/device association first.
      await sql(`delete from public.visits where device_id in (${deviceIds.map(quote).join(",")}) and household_id in (select id from public.households where name like ${quote(`${prefix}%`)}); delete from public.devices where id in (${deviceIds.map(quote).join(",")}) and name like ${quote(`${prefix}%`)};`);
    } catch { cleanupErrors.push("devices"); }
  }
  if (householdIds.length > 0) {
    try {
      await sql(`delete from public.households where id in (${householdIds.map(quote).join(",")}) and name like ${quote(`${prefix}%`)};`);
    } catch { cleanupErrors.push("households"); }
  }
  for (const id of userIds) {
    try {
      const result = await http(`/auth/v1/admin/users/${id}`, "DELETE", undefined, undefined, true);
      if (![200, 204].includes(result.status)) cleanupErrors.push("auth user");
    } catch { cleanupErrors.push("auth user"); }
  }
  const residue = await sql<{ devices: number; households: number; users: number }>(`select json_build_array(json_build_object('devices',(select count(*) from public.devices where name like ${quote(`${prefix}%`)}),'households',(select count(*) from public.households where name like ${quote(`${prefix}%`)}),'users',(select count(*) from auth.users where email like ${quote(`${prefix}%`)})));`);
  if (residue[0].devices || residue[0].households || residue[0].users) cleanupErrors.push("fixture residue");
  if (cleanupErrors.length > 0) throw new Error(`Fixture cleanup incomplete (${cleanupErrors.join(", ")}); run prefix ${prefix}`);
  console.log("Cleanup verified: no fixtures from this run remain");
}
