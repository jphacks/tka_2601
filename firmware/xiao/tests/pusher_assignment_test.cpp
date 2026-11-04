#include "servo_support.h"

static servo_pusher_config_t current() {
  servo_pusher_config_t c{};
  assert(servo_pusher_get(&c));
  return c;
}
static servo_pusher_config_t next(uint8_t mask, uint8_t start, uint8_t end) {
  return {current().revision + 1u, SERVO_PUSHER_SCHEMA_VERSION, mask, start, end};
}
static void apply(uint8_t mask, uint8_t start, uint8_t end) {
  auto c = next(mask, start, end);
  const auto before = fake::servoDuties.size();
  assert(servo_pusher_apply(&c) == SERVO_CONFIG_APPLIED);
  assert(servo_pusher_set_pending(false));
  assert(current().revision == c.revision);
  assert(fake::servoDuties.size() == before);
}
static void finish(unsigned hold = 100, unsigned rest = 100) { tick(hold); tick(rest); }
static void closed() { servo_call_close(); assert(!servo_motion_busy()); }

static void localWiringBeforeProvisioning() {
  servo_begin();
  assert(servo_pusher_apply_local(nullptr) == SERVO_CONFIG_INVALID);
  auto local = servo_pusher_config_t{0, 1, 2, 2, 2};
  auto positive = local; positive.revision = 1;
  assert(servo_pusher_apply_local(&positive) == SERVO_CONFIG_INVALID);
  assert(!command("@pusher 1 2 2 2", "invalid_pusher_config"));
  assert(command("@pusher 0 2 2 2"));
  assert(current().revision == 0 && current().call_start == 2 && fake::servoPins.empty());
  const auto writes = fake::storageWrites;
  assert(command("@pusher 0 2 2 2") && fake::storageWrites == writes);
  servo_begin();
  assert(current().revision == 0 && current().enabled_mask == 2 && current().call_end == 2);
  assert(servo_call_open());
  assert(!command("@pusher 0 3 1 2", "busy"));
  servo_call_cancel(); closed();
  assert(command("@begin"));
  assert(!command("@pusher 0 3 1 2", "busy"));
  assert(command("@cancel"));
  fake::failNextStorageWrite = true;
  assert(!command("@pusher 0 3 1 2", "storage_failed"));
  assert(current().enabled_mask == 2);
  servo_begin(); assert(current().enabled_mask == 2 && current().revision == 0);
  assert(servo_pusher_set_pending(true));
  assert(!command("@pusher 0 3 1 2", "busy"));
  assert(command("@get", "\"pusher_pending\":true"));
  assert(command("@confirm") && servo_pusher_pending());
  assert(!servo_pusher_set_pending(false) && !servo_call_open());
  servo_begin(); assert(servo_pusher_pending() && !servo_call_open());
  // The server's first revision replaces any local wiring; USB cannot overwrite it.
  apply(3, 1, 2);
  assert(current().revision == 1);
  assert(!command("@pusher 0 2 2 2", "cloud_managed"));
  assert(current().enabled_mask == 3 && fake::servoPins.empty());
  fake::preferenceRecords.clear(); fake::storedCalibration.clear();
}

static void migrationAndValidation() {
  fake::readOnlyNamespaceMissing = true;
  servo_begin();
  assert(current().revision == 0 && servo_call_open());
  servo_call_close();
  fake::readOnlyNamespaceMissing = false;
  // Seed the actual old XIAO v1 blob, including the USB-only third profile.
  const uint16_t legacy[] = {1, 160, 35, 10, 65, 20, 80, 900, 100, 100, 100, 100};
  const auto* bytes = reinterpret_cast<const unsigned char*>(legacy);
  fake::preferenceRecords["monban-servo/settings"] = std::vector<unsigned char>(bytes, bytes + sizeof(legacy));
  servo_begin();
  assert(current().revision == 0 && current().enabled_mask == 3);
  assert(command("@get", "\"unlock_press\":80"));
  assert(command("@get", "\"call_press\":35"));
  assert(fake::servoPins.empty());
  assert(servo_pusher_pin(1) == kCall && servo_pusher_pin(2) == kEnd && servo_pusher_pin(3) == kUnlock);
  assert(servo_pusher_pin(0) == UINT8_MAX && servo_pusher_pin(4) == UINT8_MAX);
  assert(servo_pusher_apply(nullptr) == SERVO_CONFIG_INVALID);
  auto c = next(3, 2, 1);
  c.schema_version = 2;
  assert(servo_pusher_apply(&c) == SERVO_CONFIG_UNSUPPORTED_SCHEMA);
  c.schema_version = 1;
  for (const auto bad : {servo_pusher_config_t{1, 1, 0, 1, 1}, {1, 1, 3, 1, 1},
                         {1, 1, 1, 1, 2}, {1, 1, 3, 3, 1}, {0, 1, 3, 1, 2}})
    assert(servo_pusher_apply(&bad) == SERVO_CONFIG_INVALID);
  // The first migration checkpoints v1 before writing the changed assignment.
  // A failure of that changed record still restores the old mapping/profile.
  fake::failWriteKey = "pusher-b";
  assert(servo_pusher_apply(&c) == SERVO_CONFIG_STORAGE_FAILED);
  servo_begin(); assert(current().revision == 0 && current().call_start == 1);
  assert(command("@get", "\"unlock_press\":80"));
  fake::failWriteKey.clear();
  assert(servo_pusher_apply(&c) == SERVO_CONFIG_APPLIED);
  const auto savedWrites = fake::storageWrites;
  c = current();
  assert(servo_pusher_apply(&c) == SERVO_CONFIG_UNCHANGED);
  assert(fake::storageWrites == savedWrites);
  auto conflict = c; conflict.call_start = 1; conflict.call_end = 2;
  assert(servo_pusher_apply(&conflict) == SERVO_CONFIG_REVISION_CONFLICT);
  c.revision = 0;
  assert(servo_pusher_apply(&c) == SERVO_CONFIG_INVALID);
  for (const char* bad : {"@pusher 4294967296 1 1 1", "@pusher -1 1 1 1", "@pusher 0 1 1 1 trailing",
                          "@pusher 0 1 1", "@pusher 0 4 1 1", "@pusher 0 1 3 3", "@pusher 0 0 0 0",
                          "@pusher 1 1 1 1",
                          "@pusher 9999999999999999999999999999999999999 1 1 1"})
    assert(!command(bad, "invalid_pusher_config"));
  assert(!command("@pusher 0 1 1 1", "cloud_managed"));
  const auto before = fake::servoPins.size();
  servo_begin();
  assert(current().revision == 1 && current().call_start == 2 && current().call_end == 1);
  assert(command("@get", "\"unlock_press\":80"));
  assert(fake::preferenceRecords["monban-servo/settings"].size() == 24);
  assert(fake::servoPins.size() == before);
}

static void durablePendingGate() {
  const auto operations = fake::servoPins.size();
  assert(!servo_pusher_pending() && !servo_recovery_required());
  const auto writes = fake::storageWrites;
  assert(servo_pusher_set_pending(true));
  assert(servo_pusher_pending() && !servo_call_open());
  assert(fake::storageWrites == writes + 1);
  assert(servo_pusher_set_pending(true) && fake::storageWrites == writes + 1);
  assert(!servo_pusher_set_pending(false)); // No authenticated apply/readback yet.
  assert(command("@confirm") && servo_pusher_pending());
  // Saving calibration cannot erase an already observed desired update.
  assert(command("@begin") && command("@time r 100") && command("@save"));
  servo_begin();
  assert(servo_pusher_pending() && !servo_call_open() && !servo_recovery_required());
  assert(command("@confirm") && !servo_pusher_set_pending(false));
  assert(!command("@pusher 0 3 1 2", "cloud_managed"));
  assert(servo_pusher_pending());
  auto same = current();
  const auto beforeReadback = fake::storageWrites;
  assert(servo_pusher_apply(&same) == SERVO_CONFIG_UNCHANGED);
  assert(servo_pusher_pending() && fake::storageWrites == beforeReadback);
  assert(servo_pusher_set_pending(false));
  const auto clearedWrites = fake::storageWrites;
  assert(servo_pusher_set_pending(false) && fake::storageWrites == clearedWrites);
  servo_begin();
  assert(!servo_pusher_pending() && servo_call_open());
  servo_call_cancel(); closed();

  // A new desired revision can commit while its pending-clear is still owed.
  assert(servo_pusher_set_pending(true));
  auto newer = next(3, 2, 1);
  assert(servo_pusher_apply(&newer) == SERVO_CONFIG_APPLIED);
  assert(servo_pusher_pending() && !servo_call_open());
  servo_begin();
  assert(current().revision == newer.revision && servo_pusher_pending() && !servo_call_open());
  assert(!servo_pusher_set_pending(false)); // Boot does not retain a RAM-only verification token.
  assert(servo_pusher_apply(&newer) == SERVO_CONFIG_UNCHANGED);
  assert(servo_pusher_set_pending(false));

  // A failed gate write blocks calls in RAM and can be retried after storage
  // becomes writable; unverified writes never count as durable acknowledgement.
  fake::failWriteKey = "pusher-pending";
  assert(!servo_pusher_set_pending(true));
  assert(servo_pusher_pending() && !servo_call_open());
  fake::failWriteKey.clear();
  assert(servo_pusher_set_pending(true));
  servo_begin(); assert(servo_pusher_pending() && !servo_call_open());
  same = current();
  assert(servo_pusher_apply(&same) == SERVO_CONFIG_UNCHANGED);
  fake::failWriteKey = "pusher-pending";
  assert(!servo_pusher_set_pending(false));
  assert(servo_pusher_pending() && !servo_call_open());
  fake::failWriteKey.clear();
  servo_begin(); assert(servo_pusher_pending() && !servo_call_open());
  assert(servo_pusher_apply(&same) == SERVO_CONFIG_UNCHANGED);
  assert(servo_pusher_set_pending(false));

  fake::corruptReadKey = "pusher-pending";
  assert(!servo_pusher_set_pending(true));
  servo_begin(); assert(servo_pusher_pending() && !servo_call_open());
  assert(servo_pusher_apply(&same) == SERVO_CONFIG_UNCHANGED);
  fake::corruptReadKey = "pusher-pending";
  assert(!servo_pusher_set_pending(false));
  assert(fake::preferenceRecords["monban-servo/pusher-pending"] == std::vector<unsigned char>{1});
  servo_begin(); assert(servo_pusher_pending() && !servo_call_open());
  assert(command("@confirm") && servo_pusher_pending());
  assert(servo_pusher_apply(&same) == SERVO_CONFIG_UNCHANGED);
  assert(servo_pusher_set_pending(false));

  // Corrupt length/value or an unreadable marker is fail-closed after boot.
  for (const auto& corrupt : {std::vector<unsigned char>{7}, std::vector<unsigned char>{0, 0}}) {
    fake::preferenceRecords["monban-servo/pusher-pending"] = corrupt;
    servo_begin();
    assert(servo_pusher_pending() && !servo_call_open());
    assert(!servo_pusher_set_pending(false));
    assert(servo_pusher_apply(&same) == SERVO_CONFIG_UNCHANGED);
    assert(servo_pusher_set_pending(false));
  }
  fake::failReadKey = "pusher-pending";
  servo_begin(); assert(servo_pusher_pending() && !servo_call_open());
  fake::failReadKey.clear();
  assert(servo_pusher_apply(&same) == SERVO_CONFIG_UNCHANGED);
  assert(servo_pusher_set_pending(false));

  // A same-revision response cannot unlock a gate using only RAM state when
  // the current persisted configuration itself cannot be read back.
  assert(servo_pusher_set_pending(true));
  fake::failNextStorageRead = true;
  assert(servo_pusher_apply(&same) == SERVO_CONFIG_STORAGE_FAILED);
  assert(!servo_pusher_set_pending(false) && servo_pusher_pending());
  servo_begin(); assert(servo_pusher_pending() && !servo_call_open());
  assert(servo_pusher_apply(&same) == SERVO_CONFIG_UNCHANGED);
  assert(servo_pusher_set_pending(false));
  assert(fake::servoPins.size() == operations);
}

static void reversedTwoAndSnapshot() {
  // Diagnostics follow the assigned logical start, not the physical output ID.
  auto tests = fake::servoPins.size();
  assert(servo_test('e'));
  tick(899); assert(fake::servoPins.size() == tests);
  tick(1); assert(fake::attachedPin == kEnd && fake::servoPins.size() == tests + 1);
  finish(); assert(!servo_test_busy());
  assert(servo_test('c'));
  assert(fake::attachedPin == kCall && fake::servoPins.size() == tests + 2);
  finish(); assert(!servo_test_busy());
  assert(servo_call_open() && servo_call_press());
  // Starting on physical 2 still takes the logical start delay.
  const auto before = fake::servoPins.size();
  tick(899); assert(fake::servoPins.size() == before);
  auto change = next(1, 1, 1);
  assert(servo_pusher_apply(&change) == SERVO_CONFIG_BUSY);
  tick(1); assert(fake::attachedPin == kEnd && fake::servoDuties.back() == duty(65));
  assert(!command("@begin", "receiver_busy"));
  assert(servo_pusher_set_pending(true));
  finish(); assert(servo_call_status() == SERVO_CALL_STARTED);
  assert(servo_end_press());
  assert(fake::attachedPin == kCall && fake::servoDuties.back() == duty(35));
  finish(); assert(servo_call_status() == SERVO_CALL_ENDED);
  closed();
  assert(!servo_call_open());
  const auto confirmed = current();
  assert(servo_pusher_apply(&confirmed) == SERVO_CONFIG_UNCHANGED);
  assert(servo_pusher_set_pending(false));
  assert(servo_call_open()); servo_call_cancel(); closed();
  assert(command("@begin"));
  assert(servo_pusher_apply(&change) == SERVO_CONFIG_BUSY);
  assert(command("@time d 0") && command("@save"));
  assert(servo_test('u')); assert(fake::attachedPin == kUnlock);
  assert(servo_pusher_apply(&change) == SERVO_CONFIG_BUSY);
  finish(); assert(!servo_test_busy());
}

static void sharedBothProfiles() {
  for (uint8_t id : {uint8_t(1), uint8_t(2)}) {
    apply(static_cast<uint8_t>(1u << (id - 1)), id, id);
    const auto operations = fake::servoPins.size();
    const int pin = id == 1 ? kCall : kEnd;
    const unsigned press = id == 1 ? 35 : 65;
    const unsigned rest = id == 1 ? 160 : 10;
    assert(!servo_test(id == 1 ? 'e' : 'c')); // unused output cannot move
    assert(command("@begin"));
    assert(!command(id == 1 ? "@set e p 40" : "@set c p 40", "pusher_disabled"));
    assert(command("@cancel"));
    assert(servo_call_open() && servo_call_press());
    assert(fake::attachedPin == pin && fake::servoDuties.back() == duty(press));
    assert(fake::preferenceRecords["monban-servo/shared-op"] == std::vector<unsigned char>{1});
    assert(!servo_recovery_confirm());
    assert(servo_call_press());
    finish(); assert(servo_call_status() == SERVO_CALL_STARTED);
    assert(fake::servoDuties.back() == duty(rest));
    assert(servo_end_press());
    assert(fake::attachedPin == pin && fake::servoDuties.back() == duty(press));
    assert(servo_end_press()); servo_call_cancel();
    finish(); assert(servo_call_status() == SERVO_CALL_ENDED);
    assert(fake::servoDuties.back() == duty(rest));
    assert(fake::preferenceRecords["monban-servo/shared-op"] == std::vector<unsigned char>{0});
    closed();
    assert(fake::servoPins.size() == operations + 2);
    servo_begin(); assert(!servo_recovery_required());
  }
  const auto c = current();
  auto old = c; --old.revision;
  assert(servo_pusher_apply(&old) == SERVO_CONFIG_STALE_REVISION);
}

static void cancellationAndPowerLoss() {
  assert(command("@begin") && command("@time d 500") && command("@save"));
  auto operations = fake::servoPins.size();
  assert(servo_call_open() && servo_call_press()); tick(250); servo_call_cancel();
  assert(servo_call_status() == SERVO_CALL_ENDED && !servo_recovery_required());
  closed(); tick(500); assert(fake::servoPins.size() == operations);
  assert(servo_call_open()); servo_call_cancel(); closed();
  for (bool duringReturn : {false, true}) {
    assert(servo_call_open() && servo_call_press()); tick(500);
    if (duringReturn) tick(100);
    servo_call_cancel(); servo_call_cancel();
    assert(servo_call_status() == SERVO_CALL_MANUAL_CHECK_REQUIRED);
    assert(!servo_recovery_confirm());
    tick(100); assert(!servo_motion_busy());
    assert(fake::servoPins.size() == ++operations); // never the compensating second press
    closed();
    assert(!servo_call_open() && !servo_test('u'));
    auto change = next(3, 1, 2);
    assert(servo_pusher_apply(&change) == SERVO_CONFIG_RECOVERY_REQUIRED);
    servo_begin(); assert(servo_recovery_required() && !servo_call_open());
    assert(command("@confirm"));
    assert(!servo_recovery_required() && fake::servoPins.size() == operations);
  }
  // A cut anywhere after the durable marker, including after a completed start,
  // inhibits new calls after boot rather than guessing the physical state.
  for (unsigned cut : {0u, 100u, 200u}) {
    assert(servo_call_open() && servo_call_press()); tick(500);
    if (cut) tick(100);
    if (cut == 200) tick(100);
    ++operations;
    servo_begin();
    assert(fake::servoPins.size() == operations && !servo_motion_busy());
    assert(servo_recovery_required() && !servo_call_open());
    assert(command("@confirm"));
  }
  // A failure during initial PWM must never schedule the shared button again.
  for (bool attach : {true, false}) {
    assert(servo_call_open() && servo_call_press());
    if (attach) fake::failNextServoAttach = true; else fake::failNextServoWrite = true;
    tick(500);
    if (!attach) ++operations;
    servo_call_cancel(); tick(100); tick(100);
    assert(servo_call_status() == SERVO_CALL_MANUAL_CHECK_REQUIRED);
    closed(); assert(fake::servoPins.size() == operations);
    assert(command("@confirm"));
  }
  assert(command("@begin") && command("@time d 0") && command("@save"));
}

static void durableFailuresAndLocalTests() {
  auto operations = fake::servoPins.size();
  fake::failWriteKey = "shared-op";
  assert(servo_call_open() && !servo_call_press());
  assert(fake::servoPins.size() == operations && servo_recovery_required());
  servo_call_cancel(); closed();
  assert(!command("@confirm", "recovery_confirmation_failed"));
  fake::failWriteKey.clear(); assert(command("@confirm"));

  assert(servo_call_open() && servo_call_press()); finish();
  assert(servo_end_press()); tick(100);
  fake::failWriteKey = "shared-op"; tick(100);
  assert(servo_call_status() == SERVO_CALL_MANUAL_CHECK_REQUIRED);
  closed(); servo_begin(); assert(servo_recovery_required());
  fake::failWriteKey.clear(); assert(command("@confirm"));

  // A failed return and an unverified marker clear both preserve the durable
  // interlock, including when the process is restarted after the failure.
  assert(servo_call_open() && servo_call_press());
  fake::failNextServoWrite = true; tick(100);
  assert(servo_call_status() == SERVO_CALL_MANUAL_CHECK_REQUIRED);
  servo_call_cancel(); closed(); servo_begin();
  assert(servo_recovery_required() && command("@confirm"));
  assert(servo_call_open() && servo_call_press()); finish();
  assert(servo_end_press()); tick(100);
  fake::corruptReadKey = "shared-op"; tick(100);
  assert(servo_call_status() == SERVO_CALL_MANUAL_CHECK_REQUIRED);
  closed(); servo_begin(); assert(servo_recovery_required()); assert(command("@confirm"));

  // Standalone shared diagnostics cause one movement only, then require an
  // explicit physical idle check. That interlock survives a restart.
  operations = fake::servoPins.size();
  assert(servo_test('e')); finish();
  assert(servo_recovery_required() && fake::servoPins.size() == operations + 1);
  assert(!servo_test('e') && !servo_call_open());
  servo_begin(); assert(servo_recovery_required()); assert(command("@confirm"));
  assert(command("@begin"));
  assert(command("@set e p 65")); finish();
  assert(servo_recovery_required());
  assert(command("@cancel")); assert(command("@confirm"));
  assert(servo_test('u')); finish();
  assert(!servo_recovery_required());

  // Failed writes/readback keep the previous active configuration, and the
  // last valid journal slot survives a truncated newer slot and a restart.
  const auto old = current(); auto change = next(3, 1, 2);
  fake::failStorage = true;
  assert(servo_pusher_apply(&change) == SERVO_CONFIG_STORAGE_FAILED);
  fake::failStorage = false;
  assert(current().revision == old.revision);
  // A torn candidate is never selected instead of the intact current record.
  const auto& a = fake::preferenceRecords["monban-servo/pusher-a"];
  const auto& b = fake::preferenceRecords["monban-servo/pusher-b"];
  const auto generation = [](const std::vector<unsigned char>& v) {
    return v.size() == 48 ? (uint32_t(v[4]) | uint32_t(v[5]) << 8 | uint32_t(v[6]) << 16 | uint32_t(v[7]) << 24) : 0u;
  };
  const std::string inactive = generation(a) > generation(b) ? "pusher-b" : "pusher-a";
  fake::corruptReadKey = inactive;
  assert(servo_pusher_apply(&change) == SERVO_CONFIG_STORAGE_FAILED);
  servo_begin(); assert(current().revision == old.revision);
  fake::preferenceRecords["monban-servo/" + inactive] = {1, 2, 3, 4};
  servo_begin(); assert(current().revision == old.revision);
  const auto writes = fake::storageWrites;
  assert(servo_pusher_apply(&old) == SERVO_CONFIG_UNCHANGED);
  assert(fake::storageWrites == writes);
}

int main() {
  localWiringBeforeProvisioning(); migrationAndValidation(); durablePendingGate(); reversedTwoAndSnapshot(); sharedBothProfiles();
  cancellationAndPowerLoss(); durableFailuresAndLocalTests();
  puts("pusher assignments: v1 migration, physical routing, snapshots, journal, replay, durable pending/shared interlocks and power loss passed");
}
