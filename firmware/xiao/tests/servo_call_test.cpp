#include "servo_support.h"
// Call-level behaviour that the M5 receiver tests covered through its socket.
static void released(int pin) {
  assert(fake::attachedPin == -1);
  assert(!fake::stoppedPins.empty() && fake::stoppedPins.back() == pin);
  assert(fake::signalOutputs[pin] && fake::signalLevels[pin] == 0);
  assert(!servo_motion_busy());
}
static void defaultsAndDelayedPress() {
  servo_begin();
  assert(command("@get", "\"call_delay_ms\":3000"));
  assert(command("@get", "\"call_hold_ms\":300"));
  assert(command("@get", "\"return_ms\":1000"));
  assert(fake::servoPins.empty());
  assert(!command("@time d 1", "begin_required"));
  assert(command("@begin"));
  for (const char* text : {"@time d -1", "@time d 30001", "@time c 99", "@time c 2001", "@time e 0", "@time u 2001", "@time r 3001", "@time x 1", "@time c 200 trailing"})
    assert(!command(text, "invalid_timing"));
  for (const char* text : {"@angles c 180 30", "@angles e 0 45", "@time d 2000", "@time c 200", "@time e 100", "@time r 600", "@save"}) assert(command(text));
  assert(fake::servoPins.empty() && fake::storedCalibration.size() == kStoredBytes);
  servo_begin();
  assert(command("@get", "\"call_hold_ms\":200"));
  // Only one press however often the call controller asks.
  assert(servo_call_open());
  assert(!servo_call_open());
  assert(servo_call_press());
  tick(999); assert(servo_call_press()); tick(999);
  assert(fake::servoPins.empty() && servo_call_status() == SERVO_CALL_PENDING);
  tick(2); assert(fake::attachedPin == kCall && fake::servoPins.size() == 1);
  const auto pressed = fake::servoDuties.back(); tick(198); assert(servo_call_press());
  assert(fake::servoDuties.back() == pressed); tick(2);
  assert(fake::servoDuties.back() == duty(180)); // returned to stored rest
  tick(599); assert(servo_call_status() == SERVO_CALL_PENDING);
  tick(1); assert(fake::attachedPin == -1 && servo_call_status() == SERVO_CALL_STARTED);
  released(kCall);
  assert(fake::servoPins.size() == 1);
  // Local tests and calibration stay locked out while a call owns the servos.
  assert(!servo_test('c') && !servo_test('e') && !servo_test('u'));
  assert(!command("@begin", "receiver_busy"));
  assert(command("@get"));
  // END once, even when requested again and cancelled during its motion.
  assert(servo_end_press());
  assert(fake::attachedPin == kEnd && fake::servoDuties.back() == duty(45));
  assert(servo_end_press());
  servo_call_cancel(); servo_call_cancel();
  tick(100); assert(fake::servoDuties.back() == duty(0));
  assert(servo_call_status() == SERVO_CALL_PENDING);
  tick(600); released(kEnd);
  assert(servo_call_status() == SERVO_CALL_ENDED);
  assert(fake::servoPins.size() == 2);
  servo_call_close();
  tick(10000); assert(fake::servoPins.size() == 2);
}
static void cancelBeforeAndDuringPress() {
  const auto start = fake::servoPins.size();
  // Never started: no physical end press.
  assert(servo_call_open());
  servo_call_cancel();
  assert(servo_call_status() == SERVO_CALL_ENDED && fake::servoPins.size() == start);
  servo_call_close();
  // During the wait: no button was pressed, so nothing needs ending.
  assert(servo_call_open() && servo_call_press());
  tick(1000); servo_call_cancel();
  assert(servo_call_status() == SERVO_CALL_ENDED);
  tick(5000); assert(fake::servoPins.size() == start);
  servo_call_close();
  // During the press: return the call servo, then press END exactly once.
  assert(servo_call_open() && servo_call_press());
  tick(2000); tick(); assert(fake::attachedPin == kCall);
  servo_call_cancel();
  assert(fake::servoDuties.back() == duty(180));
  tick(600); assert(fake::attachedPin == kEnd && fake::servoDuties.back() == duty(45));
  servo_call_cancel(); // repeated cancel does not restart it
  tick(100); tick(600); released(kEnd);
  assert(servo_call_status() == SERVO_CALL_ENDED);
  assert(fake::servoPins.size() == start + 2);
  servo_call_close();
  // After a finished call press, a failure elsewhere still ends the intercom call once.
  assert(servo_call_open() && servo_call_press());
  tick(2000); tick(); tick(200); tick(600);
  assert(servo_call_status() == SERVO_CALL_STARTED);
  servo_call_cancel();
  assert(fake::attachedPin == kEnd);
  tick(100); tick(600); assert(servo_call_status() == SERVO_CALL_ENDED);
  servo_call_close();
}
static void failures() {
  // A failed return write cannot leave the press output or test-busy latched.
  assert(command("@begin")); assert(command("@time d 0")); assert(command("@save"));
  assert(servo_test('e'));
  fake::failNextServoWrite = true;
  tick(100); released(kEnd);
  assert(!servo_test_busy());
  assert(command("@get", "\"motion_error\":\"servo_return_failed\""));
  // A press that cannot attach is reported, and END still runs on cancel.
  assert(servo_call_open());
  fake::failNextServoAttach = true;
  assert(!servo_call_press());
  assert(servo_call_status() == SERVO_CALL_FAILED);
  servo_call_cancel();
  assert(fake::attachedPin == kEnd);
  tick(100); tick(600); assert(servo_call_status() == SERVO_CALL_ENDED);
  servo_call_close();
  // END that cannot run stays a failure: the board reports an uncertain call.
  assert(servo_call_open() && servo_call_press());
  tick(200); tick(600); assert(servo_call_status() == SERVO_CALL_STARTED);
  fake::failNextServoAttach = true;
  assert(!servo_end_press());
  assert(servo_call_status() == SERVO_CALL_FAILED);
  servo_call_cancel();
  assert(servo_call_status() == SERVO_CALL_FAILED);
  tick(5000); assert(fake::attachedPin == -1);
  servo_call_close();
  for (auto initial : fake::initialPwmDuties) assert(initial == 0);
}
static void localTests() {
  assert(command("@begin")); assert(command("@time d 2000")); assert(command("@save"));
  // Cancel during the delay: no physical CALL press.
  const auto count = fake::servoPins.size();
  assert(servo_test('c'));
  assert(servo_test_cancel()); assert(!servo_test_busy());
  tick(5000); assert(fake::servoPins.size() == count);
  assert(!servo_test_cancel());
  // Unlock is only ever a local test; it never takes the call delay.
  assert(servo_test('u'));
  assert(fake::attachedPin == kUnlock);
  tick(100); assert(servo_test_cancel());
  const auto duties = fake::servoDuties.size();
  tick(100); assert(servo_test_cancel());
  assert(fake::servoDuties.size() == duties); // repeated cancel doesn't restart return
  tick(600); released(kUnlock);
  assert(std::string(servo_status()) == "Servo test cancelled: unlock");
  assert(!servo_test('x'));
}
int main() {
  defaultsAndDelayedPress();
  cancelBeforeAndDuringPress();
  failures();
  localTests();
  puts("servo calls: delayed single press, one END, cancel, failure reporting and local test isolation passed");
}
