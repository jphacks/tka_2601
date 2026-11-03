#include "servo_support.h"
int main() {
  servo_begin();
  assert(command("@get", "\"call_rest\":180,\"call_press\":150"));
  assert(fake::servoPins.empty());
  for (int pin : {kCall, kEnd, kUnlock}) assert(fake::signalOutputs[pin] && fake::signalLevels[pin] == 0);
  assert(!command("@set c p 45", "begin_required"));
  assert(command("@begin") && servo_calibration_active());
  for (const char* cmd : {"@time d 0", "@time c 500", "@time e 500", "@time u 500", "@time r 500"}) assert(command(cmd));
  assert(fake::servoPins.empty());
  assert(!servo_test('c'));
  for (const char* bad : {"@set c p -1", "@set c p 181", "@set c p 30 trailing", "@set x p 50", "@set c x 50"})
    assert(!command(bad, "invalid_command"));
  assert(fake::servoPins.empty());
  assert(!servo_call_open()); // calibration blocks new calls
  assert(command("@set c r 160"));
  assert(fake::attachedPin == kCall && fake::servoDuties.back() == dutyUs(1888));
  assert(!command("@set c p 25", "servo_busy"));
  tick(1500); tick(500);
  assert(command("@set c p 25"));
  assert(!command("@set e p 145", "returning_previous_servo"));
  tick(499); assert(fake::attachedPin == kCall);
  tick(1); assert(fake::attachedPin == -1);
  assert(command("@set e p 145"));
  tick(1500); assert(fake::attachedPin == kEnd); // returns to saved rest, then detaches
  tick(500); assert(fake::attachedPin == -1);
  fake::failStorage = true;
  assert(!command("@save", "storage_unavailable") && servo_calibration_active());
  assert(fake::storedCalibration.empty());
  fake::failStorage = false;
  assert(command("@save") && !servo_calibration_active());
  assert(fake::storedCalibration.size() == kStoredBytes);
  assert(command("@begin"));
  assert(command("@set c p 40"));
  assert(command("@cancel", "\"call_press\":25"));
  tick(500); assert(fake::attachedPin == -1);
  assert(servo_test('c'));
  assert(fake::servoDuties.back() == dutyUs(1138));
  tick(500); assert(fake::servoDuties.back() == dutyUs(1888));
  tick(500);
  assert(command("@begin")); assert(command("@set c p 55"));
  tick(120000); assert(!servo_calibration_active()); tick(500);
  assert(command("@get", "\"call_press\":25"));
  // Reloading committed NVS data retains every angle, with no startup PWM.
  const size_t operations = fake::servoPins.size();
  servo_begin();
  assert(command("@get", "\"end_press\":145"));
  assert(fake::servoPins.size() == operations);
  // A failure to drive PWM cannot silently replace a calibrated angle.
  assert(command("@begin")); fake::failNextServoWrite = true;
  assert(!command("@set c p 77", "pwm_write_failed"));
  assert(command("@get", "\"call_press\":25"));
  assert(command("@cancel")); tick(500);
  // A test press that cannot attach after its wait must not keep calls blocked until a reboot.
  assert(command("@begin") && command("@time d 1000") && command("@save") && !servo_calibration_active());
  assert(servo_test('c') && servo_test_busy());
  fake::failNextServoAttach = true;
  tick(1000);
  assert(!servo_test_busy());
  assert(servo_call_open());
  servo_call_close();
  puts("calibration: bounds, isolation, return, persistence, cancel and timeout passed");
}
